import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { one, many, query } from '../src/db/index.js';
import { prepareTestDb, teardownTestDb } from './setup.js';

before(async () => {
  await prepareTestDb();
});
after(async () => {
  await teardownTestDb();
});

test('every spec table exists', async () => {
  const rows = await many(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const names = rows.map((r) => r.table_name);
  for (const t of [
    'users', 'courses', 'course_teachers', 'course_enrollments',
    'worksheets', 'questions', 'test_cases', 'submissions', 'feedback',
  ]) {
    assert.ok(names.includes(t), `missing table ${t}`);
  }
});

test('email uniqueness is case-insensitive', async () => {
  const email = `case-${Date.now()}@college.edu`;
  await query('INSERT INTO users (email, name) VALUES ($1, $2)', [email, 'Lower']);
  await assert.rejects(
    () => query('INSERT INTO users (email, name) VALUES ($1, $2)', [email.toUpperCase(), 'Upper']),
    /duplicate key|unique/i,
  );
  await query('DELETE FROM users WHERE lower(email) = lower($1)', [email]);
});

test('role and status values are constrained', async () => {
  await assert.rejects(
    () => query('INSERT INTO users (email, name, role) VALUES ($1, $2, $3)', ['bad@college.edu', 'Bad', 'wizard']),
    /check constraint|violates/i,
  );
});

test('a course supports multiple teachers', async () => {
  const course = await one('SELECT id FROM courses LIMIT 1');
  if (!course) return; // nothing seeded
  const { rows } = await query('SELECT count(*)::int AS n FROM course_teachers WHERE course_id = $1', [course.id]);
  assert.ok(rows[0].n >= 2, 'seeded course should have co-teachers');
});

test('one submission row per student per question', async () => {
  const q = await one('SELECT id FROM questions LIMIT 1');
  const s = await one("SELECT id FROM users WHERE role = 'student' LIMIT 1");
  if (!q || !s) return;
  await query(
    `INSERT INTO submissions (question_id, student_id, code, language) VALUES ($1, $2, '', 'python')
     ON CONFLICT (question_id, student_id) DO NOTHING`,
    [q.id, s.id],
  );
  await assert.rejects(
    () => query('INSERT INTO submissions (question_id, student_id, code, language) VALUES ($1, $2, $3, $4)', [q.id, s.id, 'x', 'c']),
    /duplicate key|unique/i,
  );
  await query('DELETE FROM submissions WHERE question_id = $1 AND student_id = $2', [q.id, s.id]);
});

test('deleting a worksheet cascades to questions and test cases', async () => {
  const course = await one('SELECT id FROM courses LIMIT 1');
  const ws = await one(
    `INSERT INTO worksheets (course_id, title) VALUES ($1, 'cascade probe') RETURNING id`, [course.id],
  );
  const q = await one(
    `INSERT INTO questions (worksheet_id, title) VALUES ($1, 'q') RETURNING id`, [ws.id],
  );
  await query(`INSERT INTO test_cases (question_id, input, expected_output) VALUES ($1, 'a', 'b')`, [q.id]);
  await query('DELETE FROM worksheets WHERE id = $1', [ws.id]);
  const left = await one('SELECT count(*)::int AS n FROM test_cases WHERE question_id = $1', [q.id]);
  assert.equal(left.n, 0);
});
