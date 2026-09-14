import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { one } from '../src/db/index.js';
import { prepareTestDb, teardownTestDb } from './setup.js';
import { startTestServer, TEACHER_A, STUDENT_A, STUDENT_B } from './helpers.js';

const PY_SUM = 'a, b = map(int, input().split())\nprint(a + b)';
const PY_WRONG = 'a, b = map(int, input().split())\nprint(a - b)';

let api, teacher, studentA, studentB, courseId, worksheetId, questionId;

const run = (code, cookie) => api.post(`/api/questions/${questionId}/run`, { code, language: 'python' }, { cookie });
const submit = (code, cookie) => api.post(`/api/questions/${questionId}/submit`, { code, language: 'python' }, { cookie });

async function reviewFor(email) {
  const res = await api.get(`/api/questions/${questionId}/submissions`, { cookie: teacher });
  return res.body.submissions.find((s) => s.student.email === email);
}

before(async () => {
  await prepareTestDb();
  api = await startTestServer();
  [teacher, studentA, studentB] = await Promise.all([
    api.signIn(TEACHER_A), api.signIn(STUDENT_A), api.signIn(STUDENT_B),
  ]);
  courseId = (await one('SELECT id FROM courses WHERE name = $1', ['Programming Lab I'])).id;

  const ws = await api.post(`/api/courses/${courseId}/worksheets`, {
    title: 'Revision worksheet',
    deadline: new Date(Date.now() + 86400000).toISOString(),
    questions: [{
      title: 'Sum', allowedLanguages: ['python'], points: 10,
      testCases: [{ input: '2 3\n', expectedOutput: '5\n' }],
    }],
  }, { cookie: teacher });
  worksheetId = ws.body.worksheet.id;
  questionId = ws.body.worksheet.questions[0].id;
  await api.post(`/api/worksheets/${worksheetId}/publish`, {}, { cookie: teacher });
});

after(async () => {
  api?.close();
  await teardownTestDb();
});

describe('a submitted answer is protected from later work (SPEC.md §8.4)', () => {
  before(async () => {
    const res = await submit(PY_SUM, studentA);
    assert.equal(res.body.submission.autoPassed, true);
  });

  test('running different code afterwards does not change what the teacher grades', async () => {
    const ran = await run(PY_WRONG, studentA);
    assert.equal(ran.body.result.verdict, 'failed', 'the run itself still reports its own result');

    const graded = await reviewFor(STUDENT_A);
    assert.equal(graded.code, PY_SUM);
    assert.equal(graded.autoPassed, true);
    assert.equal(graded.lastRunResult.verdict, 'passed');
  });

  test('saving a draft afterwards does not change what the teacher grades', async () => {
    const saved = await api.put(`/api/questions/${questionId}/submission`,
      { code: '# half-finished idea', language: 'python' }, { cookie: studentA });
    assert.equal(saved.status, 200);

    const graded = await reviewFor(STUDENT_A);
    assert.equal(graded.status, 'submitted');
    assert.equal(graded.code, PY_SUM);
  });

  test('the student keeps their unsubmitted work and can see it differs from the submission', async () => {
    const { body } = await api.get(`/api/questions/${questionId}/submission`, { cookie: studentA });
    assert.equal(body.submission.code, '# half-finished idea', 'the editor restores the working copy');
    assert.equal(body.submission.submitted.code, PY_SUM);
    assert.equal(body.submission.submitted.revision, 1);
    assert.equal(body.submission.hasUnsubmittedChanges, true);
    assert.equal(body.submission.autoPassed, true, 'the recorded result is still the submitted one');
  });

  test('class progress counts the submitted result, not the last run', async () => {
    const { body } = await api.get(`/api/worksheets/${worksheetId}/progress`, { cookie: teacher });
    const stats = body.questions.find((q) => q.id === questionId).stats;
    assert.equal(stats.passed, 1);
    assert.equal(stats.failed, 0);
  });
});

describe('every submission is kept as a revision (SPEC.md §13)', () => {
  test('each submit becomes the next numbered revision with its own result', async () => {
    const first = await submit(PY_WRONG, studentB);
    assert.equal(first.body.submission.submitted.revision, 1);
    const second = await submit(PY_SUM, studentB);
    assert.equal(second.body.submission.submitted.revision, 2);
    assert.equal(second.body.submission.revisionCount, 2);

    const graded = await reviewFor(STUDENT_B);
    assert.equal(graded.revision, 2);
    assert.equal(graded.revisionCount, 2);

    const history = await api.get(`/api/submissions/${graded.id}/revisions`, { cookie: teacher });
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.revisions.map((r) => [r.revision, r.autoPassed]), [[2, true], [1, false]]);
    assert.equal(history.body.revisions[1].code, PY_WRONG, 'earlier revisions keep their own code');
    assert.equal(history.body.revisions[1].result.verdict, 'failed');
  });

  test('a student can read their own history but not a classmate’s', async () => {
    const mine = await reviewFor(STUDENT_B);
    assert.equal((await api.get(`/api/submissions/${mine.id}/revisions`, { cookie: studentB })).status, 200);
    assert.equal((await api.get(`/api/submissions/${mine.id}/revisions`, { cookie: studentA })).status, 404);
  });

  test('a teacher who does not teach the course cannot read the history', async () => {
    const email = `outsider-${Date.now()}@college.edu`;
    const other = await api.post('/api/courses', { name: 'Unrelated revisions course' }, { cookie: teacher });
    await api.post(`/api/courses/${other.body.course.id}/teachers`, { people: [{ email }] }, { cookie: teacher });
    const outsider = await api.signIn(email);

    const mine = await reviewFor(STUDENT_B);
    assert.equal((await api.get(`/api/submissions/${mine.id}/revisions`, { cookie: outsider })).status, 404);
  });

  test('a submission after the deadline is recorded as late', async () => {
    await api.patch(`/api/worksheets/${worksheetId}`, {
      deadline: new Date(Date.now() - 3600000).toISOString(),
      allowLateSubmissions: true,
    }, { cookie: teacher });

    const res = await submit(PY_SUM, studentB);
    assert.equal(res.body.late, true);
    assert.equal(res.body.submission.submitted.late, true);

    const graded = await reviewFor(STUDENT_B);
    assert.equal(graded.late, true);
    const history = await api.get(`/api/submissions/${graded.id}/revisions`, { cookie: teacher });
    assert.deepEqual(history.body.revisions.map((r) => r.late), [true, false, false]);
  });
});

describe('feedback knows which revision it was left on', () => {
  test('feedback is flagged as outdated once the student resubmits', async () => {
    const graded = await reviewFor(STUDENT_A);
    const saved = await api.put(`/api/submissions/${graded.id}/feedback`, { comment: 'Nicely done.' }, { cookie: teacher });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.feedback.revision, 1);

    let view = await reviewFor(STUDENT_A);
    assert.equal(view.feedback.revision, 1);
    assert.equal(view.feedback.outdated, false);

    await submit(PY_SUM, studentA);

    view = await reviewFor(STUDENT_A);
    assert.equal(view.revision, 2);
    assert.equal(view.feedback.outdated, true, 'the teacher can see there is something new to review');

    const own = await api.get(`/api/questions/${questionId}/submission`, { cookie: studentA });
    assert.equal(own.body.submission.feedback.revision, 1);
    assert.equal(own.body.submission.feedback.outdated, true);
  });
});
