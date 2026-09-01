import { config } from '../config.js';
import { many, one, query, transaction } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { assertAllowedEmail, toPublicUser } from './users.js';
import { isAdmin } from './access.js';
import { generateJoinCode } from './academics.js';

function shapeCourse(row, { includeJoinCode = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    code: row.code ?? null,
    department: row.department ?? null,
    archived: row.archived,
    createdAt: row.created_at,
    // Academic context, present when the course was created from the catalogue.
    subjectId: row.subject_id ?? null,
    subjectName: row.subject_name ?? null,
    subjectCode: row.subject_code ?? null,
    subjectKind: row.subject_kind ?? null,
    batchId: row.batch_id ?? null,
    batchLabel: row.batch_label ?? null,
    programmeName: row.programme_name ?? null,
    programmeCode: row.programme_code ?? null,
    departmentCode: row.department_code ?? null,
    academicYear: row.academic_year ?? null,
    semester: row.semester ?? null,
    // The join code is a teacher-only detail: showing it to students would let
    // anyone with a link pull in classmates from other sections.
    joinCode: includeJoinCode ? (row.join_code ?? null) : undefined,
    joinEnabled: includeJoinCode ? row.join_enabled : undefined,
    teacherCount: row.teacher_count ?? undefined,
    studentCount: row.student_count ?? undefined,
    worksheetCount: row.worksheet_count ?? undefined,
  };
}

// Joins that decorate a course with where it sits in the academic structure.
const COURSE_CONTEXT_JOINS = `
  LEFT JOIN subjects s ON s.id = c.subject_id
  LEFT JOIN batches b ON b.id = c.batch_id
  LEFT JOIN programmes pr ON pr.id = coalesce(b.programme_id, s.programme_id)
  LEFT JOIN departments dep ON dep.id = pr.department_id`;

const COURSE_CONTEXT_COLUMNS = `
  s.name AS subject_name, s.code AS subject_code, s.kind AS subject_kind,
  pr.name AS programme_name, pr.code AS programme_code, dep.code AS department_code,
  CASE WHEN b.id IS NULL THEN NULL
       ELSE pr.name || ' ' || b.admission_year || coalesce(' - Section ' || b.section, '')
  END AS batch_label`;

/** Courses the user can see: taught, enrolled in, or — for admins — all of them. */
export async function listCoursesFor(user, { includeArchived = false } = {}) {
  const filter = includeArchived ? '' : 'AND c.archived = false';
  const counts = `
    (SELECT count(*)::int FROM course_teachers ct WHERE ct.course_id = c.id)    AS teacher_count,
    (SELECT count(*)::int FROM course_enrollments ce WHERE ce.course_id = c.id) AS student_count,
    (SELECT count(*)::int FROM worksheets w WHERE w.course_id = c.id
       ${user.role === 'student' ? "AND w.status = 'published'" : ''})          AS worksheet_count`;
  const teacherView = user.role === 'teacher' || isAdmin(user);

  if (isAdmin(user)) {
    const rows = await many(
      `SELECT c.*, ${COURSE_CONTEXT_COLUMNS}, ${counts}
       FROM courses c ${COURSE_CONTEXT_JOINS}
       WHERE true ${filter} ORDER BY c.name`,
    );
    return rows.map((r) => shapeCourse(r, { includeJoinCode: true }));
  }

  const joinTable = user.role === 'teacher' ? 'course_teachers' : 'course_enrollments';
  const rows = await many(
    `SELECT c.*, ${COURSE_CONTEXT_COLUMNS}, ${counts}
     FROM courses c
     JOIN ${joinTable} j ON j.course_id = c.id AND j.user_id = $1
     ${COURSE_CONTEXT_JOINS}
     WHERE true ${filter}
     ORDER BY c.name`,
    [user.id],
  );
  return rows.map((r) => shapeCourse(r, { includeJoinCode: teacherView }));
}

export async function getCourseDetail(courseId, { includeRoster = true, includeJoinCode = false } = {}) {
  const course = await one(
    `SELECT c.*, ${COURSE_CONTEXT_COLUMNS} FROM courses c ${COURSE_CONTEXT_JOINS} WHERE c.id = $1`,
    [courseId],
  );
  if (!course) throw notFound('Course not found');
  const detail = shapeCourse(course, { includeJoinCode });
  if (includeRoster) {
    detail.teachers = (
      await many(
        `SELECT u.id, u.email, u.name, u.role, u.department, u.avatar_url
         FROM course_teachers ct JOIN users u ON u.id = ct.user_id
         WHERE ct.course_id = $1 ORDER BY u.name`,
        [courseId],
      )
    ).map(toPublicUser);
    detail.students = (
      await many(
        `SELECT u.id, u.email, u.name, u.role, u.department, u.avatar_url
         FROM course_enrollments ce JOIN users u ON u.id = ce.user_id
         WHERE ce.course_id = $1 ORDER BY u.name`,
        [courseId],
      )
    ).map(toPublicUser);
  }
  return detail;
}

export async function createCourse(
  { name, code, department, subjectId, batchId, academicYear, semester },
  creator,
) {
  return transaction(async (tx) => {
    // Creating from the catalogue fills in the display fields, so a course made
    // by picking a subject and a batch names itself.
    let resolvedName = name;
    let resolvedCode = code ?? null;
    if (subjectId) {
      const { rows: subjectRows } = await tx.query('SELECT name, code FROM subjects WHERE id = $1', [subjectId]);
      if (!subjectRows[0]) throw notFound('Subject not found');
      resolvedName = resolvedName || subjectRows[0].name;
      resolvedCode = resolvedCode || subjectRows[0].code;
    }
    if (!resolvedName) throw badRequest('A class needs a name, or a subject to take its name from');

    const joinCode = await generateJoinCode(tx);
    const { rows } = await tx.query(
      `INSERT INTO courses
         (name, code, department, created_by, subject_id, batch_id, academic_year, semester, join_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        resolvedName,
        resolvedCode,
        department ?? creator.department ?? config.auth.defaultDepartment,
        creator.id,
        subjectId ?? null,
        batchId ?? null,
        academicYear ?? null,
        semester ?? null,
        joinCode,
      ],
    );
    const course = rows[0];

    // Enrol the batch straight away: a lab class is the whole batch.
    if (batchId) {
      const { rows: students } = await tx.query(
        "SELECT id FROM users WHERE batch_id = $1 AND role = 'student'",
        [batchId],
      );
      for (const student of students) {
        await tx.query(
          'INSERT INTO course_enrollments (course_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [course.id, student.id],
        );
      }
    }
    // The creator teaches the course they just made, otherwise they would
    // immediately lose access to it under the course-scoped permission rules.
    await tx.query('INSERT INTO course_teachers (course_id, user_id) VALUES ($1, $2)', [course.id, creator.id]);
    return shapeCourse(course, { includeJoinCode: true });
  });
}

export async function updateCourse(courseId, patch) {
  const fields = [];
  const values = [courseId];
  for (const [column, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    values.push(value);
    fields.push(`${column} = $${values.length}`);
  }
  if (fields.length === 0) return getCourseDetail(courseId);
  const row = await one(
    `UPDATE courses SET ${fields.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    values,
  );
  if (!row) throw notFound('Course not found');
  return shapeCourse(row, { includeJoinCode: true });
}

/**
 * Finds a user by email, or provisions a placeholder so a roster can be loaded
 * before anyone has signed in. The placeholder has no google_sub, so the real
 * Google account claims this row on first sign-in and keeps the enrolment.
 */
async function resolveOrCreateUser(tx, { email, name, role, department }) {
  assertAllowedEmail(email);
  const found = await tx.query(
    'SELECT id, email, name, role, department, avatar_url FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  if (found.rows[0]) return found.rows[0];
  const { rows } = await tx.query(
    `INSERT INTO users (email, name, role, department) VALUES ($1, $2, $3, $4)
     RETURNING id, email, name, role, department, avatar_url`,
    [email, name || email.split('@')[0], role, department ?? config.auth.defaultDepartment],
  );
  return rows[0];
}

export async function addTeachers(courseId, entries) {
  return transaction(async (tx) => {
    const added = [];
    for (const entry of entries) {
      const user = await resolveOrCreateUser(tx, { ...entry, role: 'teacher' });
      if (user.role === 'student') {
        // Being assigned to teach a course promotes an existing student account.
        await tx.query("UPDATE users SET role = 'teacher', updated_at = now() WHERE id = $1", [user.id]);
        user.role = 'teacher';
      }
      await tx.query(
        'INSERT INTO course_teachers (course_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [courseId, user.id],
      );
      added.push(toPublicUser(user));
    }
    return added;
  });
}

export async function removeTeacher(courseId, userId) {
  const { rows } = await query('SELECT count(*)::int AS n FROM course_teachers WHERE course_id = $1', [courseId]);
  if (rows[0].n <= 1) {
    throw conflict('A course must keep at least one teacher. Assign another teacher before removing this one.');
  }
  const res = await query('DELETE FROM course_teachers WHERE course_id = $1 AND user_id = $2', [courseId, userId]);
  if (res.rowCount === 0) throw notFound('That teacher is not assigned to this course');
}

export async function addStudents(courseId, entries) {
  return transaction(async (tx) => {
    const added = [];
    for (const entry of entries) {
      const user = await resolveOrCreateUser(tx, { ...entry, role: 'student' });
      if (user.role === 'teacher' || user.role === 'admin') {
        throw badRequest(`${user.email} is a ${user.role} and cannot be enrolled as a student`);
      }
      await tx.query(
        'INSERT INTO course_enrollments (course_id, user_id, section) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [courseId, user.id, entry.section ?? null],
      );
      added.push(toPublicUser(user));
    }
    return added;
  });
}

export async function removeStudent(courseId, userId) {
  const res = await query('DELETE FROM course_enrollments WHERE course_id = $1 AND user_id = $2', [courseId, userId]);
  if (res.rowCount === 0) throw notFound('That student is not enrolled in this course');
}
