import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { one } from '../src/db/index.js';
import { prepareTestDb, teardownTestDb } from './setup.js';
import { startTestServer, TEACHER_A, STUDENT_A, STUDENT_B } from './helpers.js';

const STUDENT_C = 'chetan.kulkarni@college.edu';

// Long enough that two students writing it independently would be a coincidence.
const SOLUTION = 'nums = list(map(int, input().split()))\ntotal = 0\nfor n in nums:\n    total += n\nprint(total)';
// The same program with different indentation, spacing and line endings.
const SOLUTION_RESPACED = 'nums = list(map(int,input().split()))\r\ntotal=0\r\nfor n in nums:\r\n  total += n\r\nprint(total)\r\n';
const DIFFERENT = 'print(sum(map(int, input().split())))  # a different approach entirely';

let api, teacher, students, courseId;

async function worksheetWithQuestion(title) {
  const ws = await api.post(`/api/courses/${courseId}/worksheets`, {
    title,
    questions: [{ title: 'Sum a line', allowedLanguages: ['python'], testCases: [{ input: '1 2 3\n', expectedOutput: '6\n' }] }],
  }, { cookie: teacher });
  await api.post(`/api/worksheets/${ws.body.worksheet.id}/publish`, {}, { cookie: teacher });
  return ws.body.worksheet.questions[0].id;
}

const submit = (questionId, code, cookie) =>
  api.post(`/api/questions/${questionId}/submit`, { code, language: 'python' }, { cookie });

async function reviewByEmail(questionId) {
  const res = await api.get(`/api/questions/${questionId}/submissions`, { cookie: teacher });
  return Object.fromEntries(res.body.submissions.map((s) => [s.student.email, s]));
}

before(async () => {
  await prepareTestDb();
  api = await startTestServer();
  teacher = await api.signIn(TEACHER_A);
  students = {
    a: await api.signIn(STUDENT_A),
    b: await api.signIn(STUDENT_B),
    c: await api.signIn(STUDENT_C),
  };
  courseId = (await one('SELECT id FROM courses WHERE name = $1', ['Programming Lab I'])).id;
});

after(async () => {
  api?.close();
  await teardownTestDb();
});

describe('identical submissions are flagged for the teacher (QUESTIONS.md #4)', () => {
  test('submissions that differ only in whitespace point at each other', async () => {
    const questionId = await worksheetWithQuestion('Identical: whitespace');
    await submit(questionId, SOLUTION, students.a);
    await submit(questionId, SOLUTION_RESPACED, students.b);
    await submit(questionId, DIFFERENT, students.c);

    const byEmail = await reviewByEmail(questionId);
    assert.deepEqual(byEmail[STUDENT_A].identicalTo.map((s) => s.email), [STUDENT_B]);
    assert.deepEqual(byEmail[STUDENT_B].identicalTo.map((s) => s.email), [STUDENT_A]);
    assert.deepEqual(byEmail[STUDENT_C].identicalTo, []);
    assert.equal(byEmail[STUDENT_A].identicalTo[0].name.length > 0, true);
  });

  test('short answers that anyone would write the same way are not flagged', async () => {
    const questionId = await worksheetWithQuestion('Identical: trivial');
    await submit(questionId, 'print(6)', students.a);
    await submit(questionId, 'print(6)', students.b);

    const byEmail = await reviewByEmail(questionId);
    assert.deepEqual(byEmail[STUDENT_A].identicalTo, []);
  });

  test('only submitted answers are compared, not a classmate’s unsubmitted work', async () => {
    const questionId = await worksheetWithQuestion('Identical: drafts');
    await submit(questionId, SOLUTION, students.a);
    await api.put(`/api/questions/${questionId}/submission`, { code: SOLUTION, language: 'python' }, { cookie: students.b });

    const byEmail = await reviewByEmail(questionId);
    assert.deepEqual(byEmail[STUDENT_A].identicalTo, []);
    assert.deepEqual(byEmail[STUDENT_B].identicalTo, []);
  });

  test('the same code in a different language is not the same answer', async () => {
    const ws = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Identical: languages',
      questions: [{ title: 'Either language', allowedLanguages: ['python', 'c'], testCases: [] }],
    }, { cookie: teacher });
    await api.post(`/api/worksheets/${ws.body.worksheet.id}/publish`, {}, { cookie: teacher });
    const questionId = ws.body.worksheet.questions[0].id;
    const shared = '/* this text is long enough to count as a real answer to compare */';

    await api.post(`/api/questions/${questionId}/submit`, { code: shared, language: 'python' }, { cookie: students.a });
    await api.post(`/api/questions/${questionId}/submit`, { code: shared, language: 'c' }, { cookie: students.b });

    const byEmail = await reviewByEmail(questionId);
    assert.deepEqual(byEmail[STUDENT_A].identicalTo, []);
  });
});
