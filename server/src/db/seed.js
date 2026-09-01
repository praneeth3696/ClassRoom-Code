import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SERVER_ROOT, config } from '../config.js';
import { migrate } from './migrate.js';
import { closeDb, query, transaction } from './index.js';
import { LANGUAGE_IDS } from '../lib/languages.js';

/**
 * Validates a content file before touching the database.
 *
 * Real pilot content is hand-written JSON, so a typo should produce a message
 * naming the field rather than a constraint violation halfway through an
 * import.
 */
const contentSchema = z.object({
  course: z.object({
    name: z.string().min(2),
    code: z.string().optional().nullable(),
    department: z.string().optional().nullable(),
  }).strict(),
  teachers: z.array(z.object({ name: z.string().optional(), email: z.string().email() }).strict()).default([]),
  students: z.array(z.object({ name: z.string().optional(), email: z.string().email() }).strict()).default([]),
  worksheets: z.array(z.object({
    title: z.string().min(2),
    description: z.string().optional().nullable(),
    deadlineInDays: z.number().optional().nullable(),
    status: z.enum(['draft', 'published']).default('draft'),
    allowLateSubmissions: z.boolean().default(false),
    questions: z.array(z.object({
      title: z.string().min(1),
      description: z.string().optional().default(''),
      referenceNotes: z.string().optional().nullable(),
      allowedLanguages: z.array(z.enum(LANGUAGE_IDS)).min(1, 'list at least one supported language'),
      points: z.number().optional().nullable(),
      testCases: z.array(z.object({
        label: z.string().optional().nullable(),
        input: z.string().default(''),
        expectedOutput: z.string().default(''),
      }).strict()).default([]),
    }).strict()).default([]),
  }).strict()).default([]),
}).strict();

function validateContent(raw, filePath) {
  // A "$comment" key is allowed so content files can carry a note to whoever
  // edits them next; everything else must match the schema exactly, so a
  // misspelled key is caught rather than silently ignored.
  const { $comment, ...rest } = raw;
  void $comment;
  const result = contentSchema.safeParse(rest);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`${filePath} is not valid content:\n${lines.join('\n')}`);
  }
  return result.data;
}

/**
 * Idempotent seeding. Users are matched on email, courses on (name, code),
 * worksheets on (course, title) — so re-running updates in place rather than
 * creating duplicates. Point it at a different JSON file to load real pilot
 * content: `npm run seed -- ./seed/real-lab.json`.
 */

async function upsertUser(tx, { name, email, role, department }) {
  const existing = await tx.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing.rows[0]) {
    const { rows } = await tx.query(
      `UPDATE users SET name = $2, role = $3, department = $4, updated_at = now()
       WHERE id = $1 RETURNING id`,
      [existing.rows[0].id, name, role, department],
    );
    return rows[0].id;
  }
  const { rows } = await tx.query(
    `INSERT INTO users (email, name, role, department) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, name, role, department],
  );
  return rows[0].id;
}

function deadlineFrom(days) {
  if (days === null || days === undefined) return null;
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}

export async function seedFromFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${filePath} is not valid JSON: ${err.message}`);
  }
  const raw = validateContent(parsed, filePath);
  const dept = raw.course.department || config.auth.defaultDepartment;

  return transaction(async (tx) => {
    const teacherIds = [];
    for (const t of raw.teachers || []) {
      teacherIds.push(await upsertUser(tx, { ...t, role: 'teacher', department: dept }));
    }
    const studentIds = [];
    for (const s of raw.students || []) {
      studentIds.push(await upsertUser(tx, { ...s, role: 'student', department: dept }));
    }

    const found = await tx.query(
      'SELECT id FROM courses WHERE name = $1 AND coalesce(code, \'\') = coalesce($2, \'\')',
      [raw.course.name, raw.course.code ?? null],
    );
    let courseId = found.rows[0]?.id;
    if (courseId) {
      await tx.query('UPDATE courses SET department = $2, updated_at = now() WHERE id = $1', [courseId, dept]);
    } else {
      const { rows } = await tx.query(
        'INSERT INTO courses (name, code, department, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
        [raw.course.name, raw.course.code ?? null, dept, teacherIds[0] ?? null],
      );
      courseId = rows[0].id;
    }

    for (const id of teacherIds) {
      await tx.query(
        'INSERT INTO course_teachers (course_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [courseId, id],
      );
    }
    for (const id of studentIds) {
      await tx.query(
        'INSERT INTO course_enrollments (course_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [courseId, id],
      );
    }

    let questionCount = 0;
    let testCaseCount = 0;
    for (const ws of raw.worksheets || []) {
      const status = ws.status === 'published' ? 'published' : 'draft';
      const deadline = deadlineFrom(ws.deadlineInDays);
      const existing = await tx.query('SELECT id FROM worksheets WHERE course_id = $1 AND title = $2', [
        courseId,
        ws.title,
      ]);
      let worksheetId = existing.rows[0]?.id;
      if (worksheetId) {
        await tx.query(
          `UPDATE worksheets SET description = $2, deadline = $3, status = $4,
             allow_late_submissions = $5, published_at = CASE WHEN $4 = 'published' THEN coalesce(published_at, now()) ELSE NULL END,
             updated_at = now()
           WHERE id = $1`,
          [worksheetId, ws.description ?? null, deadline, status, Boolean(ws.allowLateSubmissions)],
        );
        // Questions are rewritten wholesale so the JSON file stays the source of truth.
        await tx.query('DELETE FROM questions WHERE worksheet_id = $1', [worksheetId]);
      } else {
        const { rows } = await tx.query(
          `INSERT INTO worksheets (course_id, title, description, deadline, status, allow_late_submissions, created_by, published_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5 = 'published' THEN now() ELSE NULL END)
           RETURNING id`,
          [
            courseId,
            ws.title,
            ws.description ?? null,
            deadline,
            status,
            Boolean(ws.allowLateSubmissions),
            teacherIds[0] ?? null,
          ],
        );
        worksheetId = rows[0].id;
      }

      let qPos = 0;
      for (const q of ws.questions || []) {
        const langs = q.allowedLanguages;
        const { rows } = await tx.query(
          `INSERT INTO questions (worksheet_id, position, title, description, reference_notes, allowed_languages, points)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [worksheetId, qPos++, q.title, q.description ?? '', q.referenceNotes ?? null, langs, q.points ?? null],
        );
        const questionId = rows[0].id;
        questionCount += 1;
        let tPos = 0;
        for (const tc of q.testCases || []) {
          await tx.query(
            `INSERT INTO test_cases (question_id, position, label, input, expected_output)
             VALUES ($1, $2, $3, $4, $5)`,
            [questionId, tPos++, tc.label ?? null, tc.input ?? '', tc.expectedOutput ?? ''],
          );
          testCaseCount += 1;
        }
      }
    }

    return {
      course: raw.course.name,
      teachers: teacherIds.length,
      students: studentIds.length,
      worksheets: (raw.worksheets || []).length,
      questions: questionCount,
      testCases: testCaseCount,
    };
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const arg = process.argv[2];
  const file = arg ? path.resolve(process.cwd(), arg) : path.join(SERVER_ROOT, 'seed', 'demo-course.json');
  if (!fs.existsSync(file)) {
    console.error(`seed file not found: ${file}`);
    process.exit(1);
  }
  await migrate({ quiet: true });
  const summary = await seedFromFile(file);
  console.log(`seeded from ${path.relative(process.cwd(), file)}:`);
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);
  const { rows } = await query('SELECT role, count(*)::int AS n FROM users GROUP BY role ORDER BY role');
  console.log(`  users in db: ${rows.map((r) => `${r.n} ${r.role}`).join(', ')}`);
  await closeDb();
}
