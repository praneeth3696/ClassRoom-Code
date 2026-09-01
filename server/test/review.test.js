import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { one } from '../src/db/index.js';
import { prepareTestDb, teardownTestDb } from './setup.js';
import { startTestServer, TEACHER_A, TEACHER_B, STUDENT_A, STUDENT_B } from './helpers.js';

let api, teacher, coTeacher, studentA, studentB, courseId, questionId, openQuestionId, worksheetId;

const PY_SUM = 'a, b = map(int, input().split())\nprint(a + b)';

before(async () => {
  await prepareTestDb();
  api = await startTestServer();
  [teacher, coTeacher, studentA, studentB] = await Promise.all([
    api.signIn(TEACHER_A), api.signIn(TEACHER_B), api.signIn(STUDENT_A), api.signIn(STUDENT_B),
  ]);
  courseId = (await one('SELECT id FROM courses WHERE name = $1', ['Programming Lab I'])).id;

  const ws = await api.post(`/api/courses/${courseId}/worksheets`, {
    title: 'Review worksheet',
    deadline: new Date(Date.now() + 86400000).toISOString(),
    questions: [
      { title: 'Sum', allowedLanguages: ['python'], points: 10,
        testCases: [{ input: '2 3\n', expectedOutput: '5\n' }] },
      { title: 'Open ended', allowedLanguages: ['python'], points: 5, testCases: [] },
    ],
  }, { cookie: teacher });
  worksheetId = ws.body.worksheet.id;
  questionId = ws.body.worksheet.questions[0].id;
  openQuestionId = ws.body.worksheet.questions[1].id;
  await api.post(`/api/worksheets/${worksheetId}/publish`, {}, { cookie: teacher });

  await api.post(`/api/questions/${questionId}/submit`, { code: PY_SUM, language: 'python' }, { cookie: studentA });
  await api.post(`/api/questions/${questionId}/submit`,
    { code: 'a, b = map(int, input().split())\nprint(a - b)', language: 'python' }, { cookie: studentB });
});

after(async () => {
  api?.close();
  await teardownTestDb();
});

describe('listing submissions (SPEC.md §7.4)', () => {
  test('a teacher sees every submission with code and result', async () => {
    const res = await api.get(`/api/questions/${questionId}/submissions`, { cookie: teacher });
    assert.equal(res.status, 200);
    assert.equal(res.body.submissions.length, 2);
    const [first] = res.body.submissions;
    assert.ok(first.code.length > 0);
    assert.ok(first.lastRunResult);
    assert.ok(first.student.name && first.student.email);
  });

  test('students who have not submitted are listed separately', async () => {
    const res = await api.get(`/api/questions/${questionId}/submissions`, { cookie: teacher });
    // Three students are seeded; two submitted.
    assert.equal(res.body.notSubmitted.length, 1);
    assert.ok(!res.body.submissions.some((s) => s.student.id === res.body.notSubmitted[0].id));
  });

  test('a student cannot list the class’s submissions', async () => {
    assert.equal((await api.get(`/api/questions/${questionId}/submissions`, { cookie: studentA })).status, 403);
  });

  test('an unassigned teacher cannot list them', async () => {
    const solo = await api.post('/api/courses', { name: 'Private Review Course' }, { cookie: teacher });
    const sheet = await api.post(`/api/courses/${solo.body.course.id}/worksheets`, {
      title: 'Private', questions: [{ title: 'Q', allowedLanguages: ['python'], testCases: [] }],
    }, { cookie: teacher });
    const privateQ = sheet.body.worksheet.questions[0].id;
    assert.equal((await api.get(`/api/questions/${privateQ}/submissions`, { cookie: coTeacher })).status, 404);
  });
});

describe('feedback (SPEC.md §9)', () => {
  let submissionId;

  before(async () => {
    const res = await api.get(`/api/questions/${questionId}/submissions`, { cookie: teacher });
    submissionId = res.body.submissions.find((s) => s.student.email === STUDENT_B).id;
  });

  test('a teacher leaves a comment and marks', async () => {
    const res = await api.put(`/api/submissions/${submissionId}/feedback`,
      { comment: 'You subtracted instead of adding.', marks: 4 }, { cookie: teacher });
    assert.equal(res.status, 200);
    assert.equal(res.body.feedback.marks, 4);
    assert.match(res.body.feedback.comment, /subtracted/);
  });

  test('feedback is replaced, not duplicated', async () => {
    await api.put(`/api/submissions/${submissionId}/feedback`, { comment: 'Revised.', marks: 6 }, { cookie: teacher });
    const row = await one('SELECT count(*)::int AS n FROM feedback WHERE submission_id = $1', [submissionId]);
    assert.equal(row.n, 1);
  });

  test('a comment alone is valid, and marks alone are valid', async () => {
    assert.equal((await api.put(`/api/submissions/${submissionId}/feedback`,
      { comment: 'Just a comment.' }, { cookie: teacher })).status, 200);
    assert.equal((await api.put(`/api/submissions/${submissionId}/feedback`,
      { marks: 5 }, { cookie: teacher })).status, 200);
  });

  test('empty feedback is rejected', async () => {
    // An empty body would otherwise mark the submission reviewed while telling
    // the student nothing.
    for (const body of [{}, { comment: '' }, { comment: '   ' }, { comment: null, marks: null }]) {
      const res = await api.put(`/api/submissions/${submissionId}/feedback`, body, { cookie: teacher });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
  });

  test('marks above the question’s points are rejected', async () => {
    const res = await api.put(`/api/submissions/${submissionId}/feedback`,
      { comment: 'x', marks: 50 }, { cookie: teacher });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /cannot exceed/);
  });

  test('a co-teacher can review the same course (§5)', async () => {
    const res = await api.put(`/api/submissions/${submissionId}/feedback`,
      { comment: 'From the co-teacher.', marks: 7 }, { cookie: coTeacher });
    assert.equal(res.status, 200);
  });

  test('a student cannot leave feedback', async () => {
    assert.equal((await api.put(`/api/submissions/${submissionId}/feedback`,
      { comment: 'A+', marks: 10 }, { cookie: studentA })).status, 403);
  });

  test('the student sees the feedback on their own submission (§8.5)', async () => {
    const res = await api.get(`/api/questions/${questionId}/submission`, { cookie: studentB });
    assert.equal(res.body.submission.feedback.comment, 'From the co-teacher.');
    assert.equal(res.body.submission.feedback.marks, 7);
    assert.equal(res.body.submission.feedback.teacherName, 'Prof. Vikram Shah');
    assert.equal(res.body.submission.autoPassed, false, 'shown alongside the automated result');
  });

  test('a student does not see another student’s feedback', async () => {
    const res = await api.get(`/api/questions/${questionId}/submission`, { cookie: studentA });
    assert.equal(res.body.submission.feedback, null);
  });
});

describe('worksheet progress', () => {
  test('a teacher sees class-wide counts', async () => {
    const res = await api.get(`/api/worksheets/${worksheetId}/progress`, { cookie: teacher });
    assert.equal(res.status, 200);
    assert.equal(res.body.enrolledCount, 3);
    const sum = res.body.questions.find((q) => q.id === questionId);
    assert.equal(sum.stats.submitted, 2);
    assert.equal(sum.stats.passed, 1);
    assert.equal(sum.stats.failed, 1);
    assert.ok(sum.stats.reviewed >= 1);
  });

  test('a student sees only their own state', async () => {
    const res = await api.get(`/api/worksheets/${worksheetId}/progress`, { cookie: studentA });
    const sum = res.body.questions.find((q) => q.id === questionId);
    assert.equal(sum.stats, undefined, 'students must not receive class-wide counts');
    assert.equal(sum.mine.status, 'submitted');
    assert.equal(sum.mine.autoPassed, true);
    const open = res.body.questions.find((q) => q.id === openQuestionId);
    assert.equal(open.mine, null, 'an unattempted question reports no submission');
  });
});
