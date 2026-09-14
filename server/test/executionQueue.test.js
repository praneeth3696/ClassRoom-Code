import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

// Configuration is read once at import, so the limit is set before the app loads.
process.env.EXECUTION_CONCURRENCY = '1';

const { one } = await import('../src/db/index.js');
const { prepareTestDb, teardownTestDb } = await import('./setup.js');
const { startTestServer, TEACHER_A, STUDENT_A, STUDENT_B } = await import('./helpers.js');

let api, teacher, studentA, studentB, questionId;

before(async () => {
  await prepareTestDb();
  api = await startTestServer();
  [teacher, studentA, studentB] = await Promise.all([
    api.signIn(TEACHER_A), api.signIn(STUDENT_A), api.signIn(STUDENT_B),
  ]);
  const courseId = (await one('SELECT id FROM courses WHERE name = $1', ['Programming Lab I'])).id;
  const ws = await api.post(`/api/courses/${courseId}/worksheets`, {
    title: 'Queue worksheet',
    questions: [{
      title: 'Echo', allowedLanguages: ['python'],
      testCases: [{ input: '', expectedOutput: 'ok\n' }],
    }],
  }, { cookie: teacher });
  questionId = ws.body.worksheet.questions[0].id;
  await api.post(`/api/worksheets/${ws.body.worksheet.id}/publish`, {}, { cookie: teacher });
});

after(async () => {
  api?.close();
  await teardownTestDb();
});

describe('execution queue (EXECUTION_CONCURRENCY)', () => {
  test('/api/health reports the queue and its configured size', async () => {
    const { body } = await api.get('/api/health');
    assert.deepEqual(body.execution.queue, { concurrency: 1, active: 0, waiting: 0, maxQueue: 200 });
  });

  test('with one slot, simultaneous runs from different students queue and all succeed', async () => {
    const code = 'import time\ntime.sleep(0.3)\nprint("ok")';
    const started = Date.now();
    const results = await Promise.all([studentA, studentB, studentA].map((cookie) =>
      api.post(`/api/questions/${questionId}/run`, { code, language: 'python' }, { cookie })));

    for (const res of results) {
      assert.equal(res.status, 200);
      assert.equal(res.body.result.verdict, 'passed');
    }
    assert.ok(Date.now() - started >= 850, 'three 0.3 s runs through one slot take at least 0.9 s');
    assert.equal((await api.get('/api/health')).body.execution.queue.active, 0, 'every slot is released');
  });

  test('empty code is refused immediately rather than queued', async () => {
    const res = await api.post(`/api/questions/${questionId}/run`, { code: '   ', language: 'python' }, { cookie: studentA });
    assert.equal(res.status, 400);
  });
});
