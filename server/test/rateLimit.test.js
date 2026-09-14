import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

// Limits are read once at import and are off under NODE_ENV=test, so this file
// turns them on, with small numbers, before loading the app.
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RATE_LIMIT_RUNS_PER_MINUTE = '3';
process.env.RATE_LIMIT_SIGNINS_PER_MINUTE = '6';

const { rateLimit } = await import('../src/middleware/rateLimit.js');
const { one } = await import('../src/db/index.js');
const { prepareTestDb, teardownTestDb } = await import('./setup.js');
const { startTestServer, TEACHER_A, STUDENT_A, STUDENT_B } = await import('./helpers.js');

function fakeExchange({ user = null, ip = '10.0.0.1' } = {}) {
  const headers = {};
  return {
    req: { user, ip },
    res: { setHeader: (name, value) => { headers[name] = value; } },
    headers,
  };
}

function callOnce(middleware, exchange) {
  let outcome;
  middleware(exchange.req, exchange.res, (err) => { outcome = err ?? 'next'; });
  return outcome;
}

describe('rateLimit middleware', () => {
  test('allows `max` requests per window, then refuses with 429 and Retry-After', () => {
    let clock = 1_000_000;
    const limiter = rateLimit({ name: 'runs', windowMs: 60_000, max: 2, enabled: () => true, now: () => clock });
    const user = { id: 'u1' };

    assert.equal(callOnce(limiter, fakeExchange({ user })), 'next');
    const second = fakeExchange({ user });
    assert.equal(callOnce(limiter, second), 'next');
    assert.equal(second.headers['RateLimit-Remaining'], '0');

    const third = fakeExchange({ user });
    const err = callOnce(limiter, third);
    assert.equal(err.status, 429);
    assert.match(err.message, /Too many runs/);
    assert.equal(third.headers['Retry-After'], '60');

    clock += 60_000;
    assert.equal(callOnce(limiter, fakeExchange({ user })), 'next', 'a new window starts fresh');
  });

  test('counts signed-in users separately even when they share an IP address', () => {
    const limiter = rateLimit({ name: 'runs', windowMs: 60_000, max: 1, enabled: () => true });
    assert.equal(callOnce(limiter, fakeExchange({ user: { id: 'a' }, ip: '1.2.3.4' })), 'next');
    assert.equal(callOnce(limiter, fakeExchange({ user: { id: 'b' }, ip: '1.2.3.4' })), 'next');
    assert.equal(callOnce(limiter, fakeExchange({ user: { id: 'a' }, ip: '1.2.3.4' })).status, 429);
  });

  test('counts by IP when asked to, or when nobody is signed in', () => {
    const limiter = rateLimit({ name: 'sign-ins', windowMs: 60_000, max: 1, by: 'ip', enabled: () => true });
    assert.equal(callOnce(limiter, fakeExchange({ user: { id: 'a' }, ip: '1.2.3.4' })), 'next');
    assert.equal(callOnce(limiter, fakeExchange({ user: { id: 'b' }, ip: '1.2.3.4' })).status, 429);
    assert.equal(callOnce(limiter, fakeExchange({ ip: '5.6.7.8' })), 'next');
  });

  test('does nothing when disabled', () => {
    const limiter = rateLimit({ name: 'runs', windowMs: 60_000, max: 0, enabled: () => false });
    assert.equal(callOnce(limiter, fakeExchange({ user: { id: 'a' } })), 'next');
  });
});

describe('rate limits on the running app', () => {
  let api, teacher, studentA, studentB, questionId;

  before(async () => {
    await prepareTestDb();
    api = await startTestServer();
    [teacher, studentA, studentB] = await Promise.all([
      api.signIn(TEACHER_A), api.signIn(STUDENT_A), api.signIn(STUDENT_B),
    ]);
    const courseId = (await one('SELECT id FROM courses WHERE name = $1', ['Programming Lab I'])).id;
    const ws = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Rate limit worksheet',
      questions: [{ title: 'Echo', allowedLanguages: ['python'], testCases: [{ input: '', expectedOutput: 'ok\n' }] }],
    }, { cookie: teacher });
    questionId = ws.body.worksheet.questions[0].id;
    await api.post(`/api/worksheets/${ws.body.worksheet.id}/publish`, {}, { cookie: teacher });
  });

  after(async () => {
    api?.close();
    await teardownTestDb();
  });

  test('a student who keeps pressing Run is slowed down, without affecting classmates', async () => {
    const runAs = (cookie) => api.post(`/api/questions/${questionId}/run`, { code: 'print("ok")', language: 'python' }, { cookie });

    for (let i = 0; i < 3; i += 1) assert.equal((await runAs(studentA)).status, 200);
    const limited = await runAs(studentA);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.match(limited.body.error.message, /Too many runs/);

    assert.equal((await runAs(studentB)).status, 200, 'another student on the same address is unaffected');
  });

  test('repeated development sign-ins from one address are limited', async () => {
    // before() already signed in three times from this address.
    const attempt = () => api.post('/api/auth/dev-login', { email: STUDENT_A });
    const statuses = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await attempt()).status);
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  });
});
