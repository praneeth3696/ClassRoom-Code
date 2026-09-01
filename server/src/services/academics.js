import crypto from 'node:crypto';
import { many, one, query, transaction } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/http.js';

/**
 * The academic structure: department, programme, batch, subject.
 *
 * A course is one subject taught to one batch — the thing a teacher handles and
 * a student joins, equivalent to a class in Google Classroom. Subjects live in
 * a catalogue of their own because the same subject is offered to a new batch
 * every year, with possibly a different teacher.
 */

export function shapeProgramme(row) {
  if (!row) return null;
  return {
    id: row.id,
    departmentId: row.department_id,
    name: row.name,
    code: row.code,
    degree: row.degree,
    durationYears: row.duration_years,
    departmentName: row.department_name ?? undefined,
    departmentCode: row.department_code ?? undefined,
  };
}

export function shapeBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    programmeId: row.programme_id,
    admissionYear: row.admission_year,
    section: row.section ?? null,
    currentSemester: row.current_semester,
    programmeName: row.programme_name ?? undefined,
    programmeCode: row.programme_code ?? undefined,
    label: row.programme_name
      ? `${row.programme_name} ${row.admission_year}${row.section ? ` — Section ${row.section}` : ''}`
      : undefined,
    studentCount: row.student_count ?? undefined,
  };
}

export function shapeSubject(row) {
  if (!row) return null;
  return {
    id: row.id,
    programmeId: row.programme_id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    semester: row.semester ?? null,
    credits: row.credits === null || row.credits === undefined ? null : Number(row.credits),
    programmeName: row.programme_name ?? undefined,
  };
}

export async function listDepartments() {
  return many('SELECT * FROM departments ORDER BY name');
}

export async function listProgrammes({ departmentId } = {}) {
  const rows = departmentId
    ? await many(
      `SELECT p.*, d.name AS department_name, d.code AS department_code
       FROM programmes p JOIN departments d ON d.id = p.department_id
       WHERE p.department_id = $1 ORDER BY p.name`,
      [departmentId],
    )
    : await many(
      `SELECT p.*, d.name AS department_name, d.code AS department_code
       FROM programmes p JOIN departments d ON d.id = p.department_id
       ORDER BY d.name, p.name`,
    );
  return rows.map(shapeProgramme);
}

export async function listBatches({ programmeId } = {}) {
  const where = programmeId ? 'WHERE b.programme_id = $1' : '';
  const params = programmeId ? [programmeId] : [];
  const rows = await many(
    `SELECT b.*, p.name AS programme_name, p.code AS programme_code,
            (SELECT count(*)::int FROM users u WHERE u.batch_id = b.id) AS student_count
     FROM batches b JOIN programmes p ON p.id = b.programme_id
     ${where}
     ORDER BY b.admission_year DESC, p.name, b.section`,
    params,
  );
  return rows.map(shapeBatch);
}

export async function listSubjects({ programmeId, semester, kind } = {}) {
  const clauses = [];
  const params = [];
  if (programmeId) { params.push(programmeId); clauses.push(`s.programme_id = $${params.length}`); }
  if (semester) { params.push(semester); clauses.push(`s.semester = $${params.length}`); }
  if (kind) { params.push(kind); clauses.push(`s.kind = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await many(
    `SELECT s.*, p.name AS programme_name
     FROM subjects s LEFT JOIN programmes p ON p.id = s.programme_id
     ${where}
     ORDER BY s.semester NULLS LAST, s.kind DESC, s.name`,
    params,
  );
  return rows.map(shapeSubject);
}

// --- Join codes --------------------------------------------------------------

// Ambiguous characters are left out so a code read off a projector cannot be
// mistyped as a different valid code.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomJoinCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Generates a code that is not already taken. */
export async function generateJoinCode(tx = null) {
  const run = tx ? (sql, params) => tx.query(sql, params) : (sql, params) => query(sql, params);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = randomJoinCode();
    const { rows } = await run('SELECT 1 AS taken FROM courses WHERE join_code = $1', [code]);
    if (rows.length === 0) return code;
  }
  throw conflict('Could not allocate a join code. Please try again.');
}

export async function rotateJoinCode(courseId) {
  const code = await generateJoinCode();
  const row = await one(
    'UPDATE courses SET join_code = $2, updated_at = now() WHERE id = $1 RETURNING join_code',
    [courseId, code],
  );
  if (!row) throw notFound('Course not found');
  return row.join_code;
}

export async function setJoinEnabled(courseId, enabled) {
  const row = await one(
    'UPDATE courses SET join_enabled = $2, updated_at = now() WHERE id = $1 RETURNING join_enabled',
    [courseId, Boolean(enabled)],
  );
  if (!row) throw notFound('Course not found');
  return row.join_enabled;
}

/**
 * Enrols a student using a class code, the way Google Classroom does.
 *
 * Codes are matched case-insensitively because students type them off a board.
 * Joining twice is not an error: it returns the same class, so a student who
 * taps the button again is not shown a failure.
 */
export async function joinCourseByCode(user, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 4) throw badRequest('That does not look like a class code.');

  const course = await one(
    `SELECT c.*, s.name AS subject_name, s.kind AS subject_kind
     FROM courses c LEFT JOIN subjects s ON s.id = c.subject_id
     WHERE upper(c.join_code) = $1`,
    [code],
  );
  if (!course) throw notFound('No class has that code. Check it with your teacher.');
  if (!course.join_enabled) throw conflict('This class is not accepting new students right now.');
  if (course.archived) throw conflict('This class has been archived.');

  const teaching = await one(
    'SELECT 1 AS yes FROM course_teachers WHERE course_id = $1 AND user_id = $2',
    [course.id, user.id],
  );
  if (teaching) throw badRequest('You teach this class, so you cannot join it as a student.');

  await query(
    'INSERT INTO course_enrollments (course_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [course.id, user.id],
  );
  return { id: course.id, name: course.name, subjectName: course.subject_name ?? null };
}

/**
 * Enrols every student of a batch into a course in one step.
 *
 * This is how a real class is populated: the batch already exists, and a lab
 * has the whole batch in it. Students who joined by code are not duplicated.
 */
export async function enrollBatch(courseId, batchId) {
  return transaction(async (tx) => {
    const { rows: students } = await tx.query(
      "SELECT id FROM users WHERE batch_id = $1 AND role = 'student'",
      [batchId],
    );
    for (const student of students) {
      await tx.query(
        'INSERT INTO course_enrollments (course_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [courseId, student.id],
      );
    }
    await tx.query('UPDATE courses SET batch_id = $2, updated_at = now() WHERE id = $1', [courseId, batchId]);
    return { enrolled: students.length };
  });
}
