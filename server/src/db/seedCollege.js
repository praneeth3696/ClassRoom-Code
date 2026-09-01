import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SERVER_ROOT } from '../config.js';
import { migrate } from './migrate.js';
import { closeDb, transaction } from './index.js';
import { DATABASE_LANGUAGE_IDS, LANGUAGE_IDS, kindOfLanguageSet } from '../lib/languages.js';
import { generateJoinCode } from '../services/academics.js';

/**
 * Loads a whole department: programmes, batches, subjects, staff, students and
 * their classes, from one JSON file.
 *
 * The simple `seed.js` seeds a single standalone course and is what the tests
 * use. This one exists because a real college is a hierarchy, and setting up a
 * semester by hand through the API would be tedious.
 *
 * Idempotent throughout: codes and emails are the natural keys, so re-running
 * updates in place rather than duplicating a department every time.
 */

const questionSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  referenceNotes: z.string().optional().nullable(),
  allowedLanguages: z.array(z.enum(LANGUAGE_IDS)).min(1),
  points: z.number().optional().nullable(),
  setupScript: z.string().optional().nullable(),
  orderedComparison: z.boolean().optional().default(false),
  testCases: z.array(z.object({
    label: z.string().optional().nullable(),
    input: z.string().default(''),
    expectedOutput: z.string().default(''),
  }).strict()).default([]),
}).strict().refine((q) => kindOfLanguageSet(q.allowedLanguages) !== null, {
  message: 'a question cannot mix program languages with database engines',
  path: ['allowedLanguages'],
});

const worksheetSchema = z.object({
  title: z.string().min(2),
  description: z.string().optional().nullable(),
  deadlineInDays: z.number().optional().nullable(),
  status: z.enum(['draft', 'published']).default('draft'),
  allowLateSubmissions: z.boolean().default(false),
  datasetEngine: z.enum(DATABASE_LANGUAGE_IDS).optional().nullable(),
  datasetScript: z.string().optional().nullable(),
  questions: z.array(questionSchema).default([]),
}).strict();

const collegeSchema = z.object({
  department: z.object({ name: z.string(), code: z.string() }).strict(),
  staff: z.array(z.object({
    name: z.string(), email: z.string().email(), role: z.enum(['teacher', 'admin']).default('teacher'),
  }).strict()).default([]),
  programmes: z.array(z.object({
    name: z.string(),
    code: z.string(),
    degree: z.string().default('M.Sc'),
    durationYears: z.number().default(5),
    subjects: z.array(z.object({
      code: z.string(),
      name: z.string(),
      kind: z.enum(['lab', 'theory']).default('lab'),
      semester: z.number().optional().nullable(),
      credits: z.number().optional().nullable(),
    }).strict()).default([]),
    batches: z.array(z.object({
      admissionYear: z.number(),
      section: z.string().optional().nullable(),
      currentSemester: z.number().default(1),
      students: z.array(z.object({
        name: z.string(), email: z.string().email(), rollNumber: z.string().optional().nullable(),
      }).strict()).default([]),
    }).strict()).default([]),
  }).strict()).default([]),
  classes: z.array(z.object({
    programmeCode: z.string(),
    subjectCode: z.string(),
    batchYear: z.number(),
    batchSection: z.string().optional().nullable(),
    academicYear: z.string().optional().nullable(),
    semester: z.number().optional().nullable(),
    teachers: z.array(z.string().email()).min(1),
    worksheets: z.array(worksheetSchema).default([]),
  }).strict()).default([]),
}).strict();

function validate(raw, filePath) {
  const { $comment, ...rest } = raw;
  void $comment;
  const result = collegeSchema.safeParse(rest);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`${filePath} is not valid college data:\n${lines.join('\n')}`);
  }
  return result.data;
}

function deadlineFrom(days) {
  if (days === null || days === undefined) return null;
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}

async function upsertUser(tx, { email, name, role, department, batchId = null, rollNumber = null }) {
  const found = await tx.query('SELECT id, role FROM users WHERE lower(email) = lower($1)', [email]);
  if (found.rows[0]) {
    const { rows } = await tx.query(
      `UPDATE users SET name = $2, department = $3,
              batch_id = coalesce($4, batch_id), roll_number = coalesce($5, roll_number),
              updated_at = now()
       WHERE id = $1 RETURNING id`,
      [found.rows[0].id, name, department, batchId, rollNumber],
    );
    return rows[0].id;
  }
  const { rows } = await tx.query(
    `INSERT INTO users (email, name, role, department, batch_id, roll_number)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [email, name, role, department, batchId, rollNumber],
  );
  return rows[0].id;
}

export async function seedCollegeFromFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON: ${err.message}`);
  }
  const data = validate(parsed, filePath);
  const summary = {
    department: data.department.code, programmes: 0, batches: 0, subjects: 0,
    staff: 0, students: 0, classes: 0, worksheets: 0, questions: 0, testCases: 0,
  };

  return transaction(async (tx) => {
    // --- Department --------------------------------------------------------
    let deptId = (await tx.query('SELECT id FROM departments WHERE code = $1', [data.department.code]))
      .rows[0]?.id;
    if (deptId) {
      await tx.query('UPDATE departments SET name = $2 WHERE id = $1', [deptId, data.department.name]);
    } else {
      deptId = (await tx.query(
        'INSERT INTO departments (name, code) VALUES ($1, $2) RETURNING id',
        [data.department.name, data.department.code],
      )).rows[0].id;
    }

    // --- Staff -------------------------------------------------------------
    const staffByEmail = new Map();
    for (const person of data.staff) {
      const id = await upsertUser(tx, { ...person, department: data.department.name });
      // A seeded staff member must not be demoted by a later run.
      await tx.query('UPDATE users SET role = $2 WHERE id = $1', [id, person.role]);
      staffByEmail.set(person.email.toLowerCase(), id);
      summary.staff += 1;
    }

    // --- Programmes, subjects, batches, students ---------------------------
    const programmeByCode = new Map();
    const subjectByKey = new Map();   // `${programmeCode}:${subjectCode}`
    const batchByKey = new Map();     // `${programmeCode}:${year}:${section ?? ''}`

    for (const prog of data.programmes) {
      let progId = (await tx.query(
        'SELECT id FROM programmes WHERE department_id = $1 AND code = $2', [deptId, prog.code],
      )).rows[0]?.id;
      if (progId) {
        await tx.query(
          'UPDATE programmes SET name = $2, degree = $3, duration_years = $4 WHERE id = $1',
          [progId, prog.name, prog.degree, prog.durationYears],
        );
      } else {
        progId = (await tx.query(
          `INSERT INTO programmes (department_id, name, code, degree, duration_years)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [deptId, prog.name, prog.code, prog.degree, prog.durationYears],
        )).rows[0].id;
      }
      programmeByCode.set(prog.code, progId);
      summary.programmes += 1;

      for (const subject of prog.subjects) {
        let subjectId = (await tx.query(
          'SELECT id FROM subjects WHERE programme_id = $1 AND code = $2', [progId, subject.code],
        )).rows[0]?.id;
        if (subjectId) {
          await tx.query(
            'UPDATE subjects SET name = $2, kind = $3, semester = $4, credits = $5 WHERE id = $1',
            [subjectId, subject.name, subject.kind, subject.semester ?? null, subject.credits ?? null],
          );
        } else {
          subjectId = (await tx.query(
            `INSERT INTO subjects (programme_id, code, name, kind, semester, credits)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [progId, subject.code, subject.name, subject.kind, subject.semester ?? null, subject.credits ?? null],
          )).rows[0].id;
        }
        subjectByKey.set(`${prog.code}:${subject.code}`, subjectId);
        summary.subjects += 1;
      }

      for (const batch of prog.batches) {
        const section = batch.section ?? null;
        let batchId = (await tx.query(
          `SELECT id FROM batches WHERE programme_id = $1 AND admission_year = $2
             AND coalesce(section, '') = coalesce($3, '')`,
          [progId, batch.admissionYear, section],
        )).rows[0]?.id;
        if (batchId) {
          await tx.query('UPDATE batches SET current_semester = $2 WHERE id = $1', [batchId, batch.currentSemester]);
        } else {
          batchId = (await tx.query(
            `INSERT INTO batches (programme_id, admission_year, section, current_semester)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [progId, batch.admissionYear, section, batch.currentSemester],
          )).rows[0].id;
        }
        batchByKey.set(`${prog.code}:${batch.admissionYear}:${section ?? ''}`, batchId);
        summary.batches += 1;

        for (const student of batch.students) {
          await upsertUser(tx, {
            ...student, role: 'student', department: data.department.name,
            batchId, rollNumber: student.rollNumber ?? null,
          });
          summary.students += 1;
        }
      }
    }

    // --- Classes (subject offerings) ---------------------------------------
    for (const klass of data.classes) {
      const progId = programmeByCode.get(klass.programmeCode);
      if (!progId) throw new Error(`class refers to unknown programme "${klass.programmeCode}"`);
      const subjectId = subjectByKey.get(`${klass.programmeCode}:${klass.subjectCode}`);
      if (!subjectId) throw new Error(`class refers to unknown subject "${klass.subjectCode}"`);
      const batchId = batchByKey.get(`${klass.programmeCode}:${klass.batchYear}:${klass.batchSection ?? ''}`);
      if (!batchId) throw new Error(`class refers to unknown batch ${klass.batchYear} of ${klass.programmeCode}`);

      const subject = (await tx.query('SELECT name, code FROM subjects WHERE id = $1', [subjectId])).rows[0];
      const owner = staffByEmail.get(klass.teachers[0].toLowerCase());

      let courseId = (await tx.query(
        'SELECT id FROM courses WHERE subject_id = $1 AND batch_id = $2', [subjectId, batchId],
      )).rows[0]?.id;
      if (courseId) {
        await tx.query(
          `UPDATE courses SET name = $2, code = $3, department = $4, academic_year = $5,
                  semester = $6, updated_at = now()
           WHERE id = $1`,
          [courseId, subject.name, subject.code, data.department.name,
            klass.academicYear ?? null, klass.semester ?? null],
        );
      } else {
        const joinCode = await generateJoinCode(tx);
        courseId = (await tx.query(
          `INSERT INTO courses
             (name, code, department, created_by, subject_id, batch_id, academic_year, semester, join_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [subject.name, subject.code, data.department.name, owner ?? null,
            subjectId, batchId, klass.academicYear ?? null, klass.semester ?? null, joinCode],
        )).rows[0].id;
      }
      summary.classes += 1;

      for (const email of klass.teachers) {
        const teacherId = staffByEmail.get(email.toLowerCase());
        if (!teacherId) throw new Error(`class refers to unknown staff member "${email}"`);
        await tx.query(
          'INSERT INTO course_teachers (course_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [courseId, teacherId],
        );
      }

      // The batch is the class: everyone in it is enrolled.
      const { rows: students } = await tx.query(
        "SELECT id FROM users WHERE batch_id = $1 AND role = 'student'", [batchId],
      );
      for (const student of students) {
        await tx.query(
          'INSERT INTO course_enrollments (course_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [courseId, student.id],
        );
      }

      for (const ws of klass.worksheets) {
        const deadline = deadlineFrom(ws.deadlineInDays);
        let worksheetId = (await tx.query(
          'SELECT id FROM worksheets WHERE course_id = $1 AND title = $2', [courseId, ws.title],
        )).rows[0]?.id;

        if (worksheetId) {
          await tx.query(
            `UPDATE worksheets SET description = $2, deadline = $3, status = $4,
                    allow_late_submissions = $5, dataset_script = $6, dataset_engine = $7,
                    published_at = CASE WHEN $4 = 'published' THEN coalesce(published_at, now()) ELSE NULL END,
                    updated_at = now()
             WHERE id = $1`,
            [worksheetId, ws.description ?? null, deadline, ws.status,
              ws.allowLateSubmissions, ws.datasetScript ?? null, ws.datasetEngine ?? null],
          );
          await tx.query('DELETE FROM questions WHERE worksheet_id = $1', [worksheetId]);
        } else {
          worksheetId = (await tx.query(
            `INSERT INTO worksheets
               (course_id, title, description, deadline, status, allow_late_submissions,
                dataset_script, dataset_engine, created_by, published_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                     CASE WHEN $5 = 'published' THEN now() ELSE NULL END)
             RETURNING id`,
            [courseId, ws.title, ws.description ?? null, deadline, ws.status,
              ws.allowLateSubmissions, ws.datasetScript ?? null, ws.datasetEngine ?? null, owner ?? null],
          )).rows[0].id;
        }
        summary.worksheets += 1;

        let position = 0;
        for (const q of ws.questions) {
          const kind = kindOfLanguageSet(q.allowedLanguages) === 'database' ? 'database' : 'program';
          const questionId = (await tx.query(
            `INSERT INTO questions
               (worksheet_id, position, title, description, reference_notes, allowed_languages,
                points, kind, setup_script, ordered_comparison)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [worksheetId, position, q.title, q.description, q.referenceNotes ?? null,
              q.allowedLanguages, q.points ?? null, kind, q.setupScript ?? null, q.orderedComparison],
          )).rows[0].id;
          position += 1;
          summary.questions += 1;

          let tcPosition = 0;
          for (const tc of q.testCases) {
            await tx.query(
              `INSERT INTO test_cases (question_id, position, label, input, expected_output)
               VALUES ($1, $2, $3, $4, $5)`,
              [questionId, tcPosition, tc.label ?? null, tc.input, tc.expectedOutput],
            );
            tcPosition += 1;
            summary.testCases += 1;
          }
        }
      }
    }

    return summary;
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const arg = process.argv[2];
  const file = arg ? path.resolve(process.cwd(), arg) : path.join(SERVER_ROOT, 'seed', 'psg-amcs.json');
  if (!fs.existsSync(file)) {
    console.error(`college seed file not found: ${file}`);
    process.exit(1);
  }
  await migrate({ quiet: true });
  const summary = await seedCollegeFromFile(file);
  console.log(`seeded ${path.relative(process.cwd(), file)}:`);
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);
  await closeDb();
}
