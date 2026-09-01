import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { one, query } from '../src/db/index.js';
import { prepareTestDb, teardownTestDb } from './setup.js';
import { startTestServer, TEACHER_A, STUDENT_A, STUDENT_B } from './helpers.js';

let api, teacher, studentA, studentB, courseId, questionId, openQuestionId, worksheetId;

const PY_SUM = 'a, b = map(int, input().split())\nprint(a + b)';
const PY_WRONG = 'a, b = map(int, input().split())\nprint(a - b)';

before(async () => {
  await prepareTestDb();
  api = await startTestServer();
  [teacher, studentA, studentB] = await Promise.all([
    api.signIn(TEACHER_A), api.signIn(STUDENT_A), api.signIn(STUDENT_B),
  ]);
  courseId = (await one('SELECT id FROM courses WHERE name = $1', ['Programming Lab I'])).id;

  const ws = await api.post(`/api/courses/${courseId}/worksheets`, {
    title: 'Execution worksheet',
    deadline: new Date(Date.now() + 86400000).toISOString(),
    questions: [
      {
        title: 'Sum two integers',
        description: 'Read two integers and print their sum.',
        allowedLanguages: ['python', 'c'],
        points: 10,
        testCases: [
          { label: 'basic', input: '2 3\n', expectedOutput: '5\n' },
          { label: 'negative', input: '-1 1\n', expectedOutput: '0\n' },
        ],
      },
      {
        title: 'Open ended',
        description: 'Explain your approach in comments and print your name.',
        allowedLanguages: ['python'],
        testCases: [],
      },
    ],
  }, { cookie: teacher });
  worksheetId = ws.body.worksheet.id;
  questionId = ws.body.worksheet.questions[0].id;
  openQuestionId = ws.body.worksheet.questions[1].id;
  await api.post(`/api/worksheets/${worksheetId}/publish`, {}, { cookie: teacher });
});

after(async () => {
  api?.close();
  await teardownTestDb();
});

describe('running code (SPEC.md §8.3)', () => {
  test('a correct program passes all visible test cases', async () => {
    const res = await api.post(`/api/questions/${questionId}/run`, { code: PY_SUM, language: 'python' }, { cookie: studentA });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.verdict, 'passed');
    assert.equal(res.body.result.passedCount, 2);
    assert.equal(res.body.result.cases[0].expectedOutput, '5\n', 'test cases are visible to students (§4)');
  });

  test('running does not submit the answer', async () => {
    const res = await api.get(`/api/questions/${questionId}/submission`, { cookie: studentA });
    assert.equal(res.body.submission.status, 'draft', 'Run is a self-check, not a grade');
    assert.equal(res.body.submission.submittedAt, null);
  });

  test('a wrong program shows expected vs actual', async () => {
    const res = await api.post(`/api/questions/${questionId}/run`, { code: PY_WRONG, language: 'python' }, { cookie: studentA });
    assert.equal(res.body.result.verdict, 'failed');
    assert.equal(res.body.result.cases[0].actualOutput, '-1\n');
    assert.equal(res.body.result.cases[0].expectedOutput, '5\n');
  });

  test('a disallowed language is refused', async () => {
    const res = await api.post(`/api/questions/${questionId}/run`, { code: 'x', language: 'java' }, { cookie: studentA });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /does not allow java/);
  });

  test('an unknown language is refused', async () => {
    const res = await api.post(`/api/questions/${questionId}/run`, { code: 'x', language: 'rust' }, { cookie: studentA });
    assert.equal(res.status, 400);
  });

  test('empty code is refused', async () => {
    const res = await api.post(`/api/questions/${questionId}/run`, { code: '  ', language: 'python' }, { cookie: studentA });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /no code to run/);
  });

  test('a question with no test cases still shows program output', async () => {
    const res = await api.post(`/api/questions/${openQuestionId}/run`,
      { code: 'print("Aditya Menon")', language: 'python' }, { cookie: studentA });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.verdict, 'no_test_cases');
    assert.match(res.body.result.cases[0].actualOutput, /Aditya Menon/);
  });
});

describe('submitting (SPEC.md §8.4)', () => {
  test('submit records the answer and the automated result', async () => {
    const res = await api.post(`/api/questions/${questionId}/submit`, { code: PY_SUM, language: 'python' }, { cookie: studentA });
    assert.equal(res.status, 200);
    assert.equal(res.body.submission.status, 'submitted');
    assert.equal(res.body.submission.autoPassed, true);
    assert.ok(res.body.submission.submittedAt);
    assert.equal(res.body.result.verdict, 'passed');
  });

  test('the automated result describes the submitted code, not the last Run', async () => {
    // Run something correct, then submit something wrong.
    await api.post(`/api/questions/${questionId}/run`, { code: PY_SUM, language: 'python' }, { cookie: studentB });
    const submitted = await api.post(`/api/questions/${questionId}/submit`, { code: PY_WRONG, language: 'python' }, { cookie: studentB });
    assert.equal(submitted.body.submission.autoPassed, false,
      'submitting must re-run the code being submitted');
    assert.equal(submitted.body.submission.code, PY_WRONG);
  });

  test('a submission stays revisable and overwrites in place', async () => {
    const fixed = await api.post(`/api/questions/${questionId}/submit`, { code: PY_SUM, language: 'python' }, { cookie: studentB });
    assert.equal(fixed.body.submission.autoPassed, true);

    const { rows } = await query(
      'SELECT count(*)::int AS n FROM submissions WHERE question_id = $1 AND student_id = $2',
      [questionId, fixed.body.submission.studentId],
    );
    assert.equal(rows[0].n, 1, 'only the latest revision is kept (SPEC.md §13)');
  });

  test('an ungraded question records no automated pass', async () => {
    const res = await api.post(`/api/questions/${openQuestionId}/submit`,
      { code: 'print("done")', language: 'python' }, { cookie: studentA });
    assert.equal(res.status, 200);
    assert.equal(res.body.submission.status, 'submitted');
    assert.equal(res.body.submission.autoPassed, null,
      'a question with no test cases is teacher-graded only (§9)');
  });

  test('a draft can be saved without running', async () => {
    const put = await api.put(`/api/questions/${openQuestionId}/submission`,
      { code: '# still thinking', language: 'python' }, { cookie: studentB });
    assert.equal(put.status, 200);
    assert.equal(put.body.submission.status, 'draft');
    assert.equal(put.body.submission.code, '# still thinking');
  });

  test('students only ever see their own submission', async () => {
    const a = await api.get(`/api/questions/${questionId}/submission`, { cookie: studentA });
    const b = await api.get(`/api/questions/${questionId}/submission`, { cookie: studentB });
    assert.notEqual(a.body.submission.id, b.body.submission.id);
    assert.notEqual(a.body.submission.studentId, b.body.submission.studentId);
  });
});

describe('access control on execution', () => {
  test('an anonymous request cannot run code', async () => {
    const res = await api.post(`/api/questions/${questionId}/run`, { code: PY_SUM, language: 'python' });
    assert.equal(res.status, 401);
  });

  test('a student in another course cannot run or submit', async () => {
    const otherTeacher = await api.signIn(TEACHER_A);
    const other = await api.post('/api/courses', { name: 'Unrelated Course' }, { cookie: otherTeacher });
    const email = `stranger-${Date.now()}@college.edu`;
    await api.post(`/api/courses/${other.body.course.id}/students`, { people: [{ email }] }, { cookie: otherTeacher });
    const stranger = await api.signIn(email);

    assert.equal((await api.post(`/api/questions/${questionId}/run`, { code: PY_SUM, language: 'python' }, { cookie: stranger })).status, 404);
    assert.equal((await api.post(`/api/questions/${questionId}/submit`, { code: PY_SUM, language: 'python' }, { cookie: stranger })).status, 404);
    assert.equal((await api.get(`/api/questions/${questionId}/submission`, { cookie: stranger })).status, 404);
  });

  test('a question in an unpublished worksheet cannot be attempted', async () => {
    const draft = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Draft execution sheet',
      questions: [{ title: 'Hidden', allowedLanguages: ['python'], testCases: [] }],
    }, { cookie: teacher });
    const hiddenId = draft.body.worksheet.questions[0].id;
    const res = await api.post(`/api/questions/${hiddenId}/run`, { code: 'print(1)', language: 'python' }, { cookie: studentA });
    assert.equal(res.status, 404);
  });
});

describe('the deadline closes submissions (SPEC.md §14)', () => {
  let lockedQuestionId, lockedWorksheetId;

  before(async () => {
    const ws = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Deadline sheet',
      deadline: new Date(Date.now() + 86400000).toISOString(),
      questions: [{
        title: 'Timed question', allowedLanguages: ['python'],
        testCases: [{ input: '', expectedOutput: 'hi\n' }],
      }],
    }, { cookie: teacher });
    lockedWorksheetId = ws.body.worksheet.id;
    lockedQuestionId = ws.body.worksheet.questions[0].id;
    await api.post(`/api/worksheets/${lockedWorksheetId}/publish`, {}, { cookie: teacher });
  });

  test('submission works before the deadline', async () => {
    const res = await api.post(`/api/questions/${lockedQuestionId}/submit`, { code: 'print("hi")', language: 'python' }, { cookie: studentA });
    assert.equal(res.status, 200);
    assert.equal(res.body.submission.autoPassed, true);
  });

  test('after the deadline, submission is refused but running still works', async () => {
    await api.patch(`/api/worksheets/${lockedWorksheetId}`, { deadline: new Date(Date.now() - 3600000).toISOString() }, { cookie: teacher });

    const submit = await api.post(`/api/questions/${lockedQuestionId}/submit`, { code: 'print("late")', language: 'python' }, { cookie: studentA });
    assert.equal(submit.status, 403);
    assert.match(submit.body.error.message, /deadline/);

    const run = await api.post(`/api/questions/${lockedQuestionId}/run`, { code: 'print("hi")', language: 'python' }, { cookie: studentA });
    assert.equal(run.status, 200, 'students can still practise after the deadline');

    const stored = await api.get(`/api/questions/${lockedQuestionId}/submission`, { cookie: studentA });
    assert.equal(stored.body.submission.code, 'print("hi")', 'the submitted answer is unchanged');
    assert.equal(stored.body.submissionOpen, false);
  });

  test('allowing late submissions reopens the window', async () => {
    await api.patch(`/api/worksheets/${lockedWorksheetId}`, { allowLateSubmissions: true }, { cookie: teacher });
    const res = await api.post(`/api/questions/${lockedQuestionId}/submit`, { code: 'print("hi")', language: 'python' }, { cookie: studentA });
    assert.equal(res.status, 200);
    assert.equal(res.body.late, true, 'a late submission is flagged as late');
  });
});
