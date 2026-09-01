import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../src/db/index.js';
import { prepareTestDb, teardownTestDb } from './setup.js';
import { config } from '../src/config.js';
import { signSession, verifySession } from '../src/lib/session.js';
import { assertAllowedEmail, emailDomain, initialRoleFor, upsertGoogleUser, findUserByEmail } from '../src/services/users.js';
import { requireRole, requireAuth } from '../src/middleware/auth.js';
import { createApp } from '../src/app.js';

let server;
let base;

before(async () => {
  await prepareTestDb();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await teardownTestDb();
});

describe('session tokens', () => {
  test('round-trips a user', () => {
    const token = signSession({ id: 'abc-123', email: 'a@college.edu', role: 'teacher' });
    const claims = verifySession(token);
    assert.equal(claims.sub, 'abc-123');
    assert.equal(claims.role, 'teacher');
  });

  test('rejects a tampered token', () => {
    const token = signSession({ id: 'abc', email: 'a@b.c', role: 'student' });
    const [h, p, s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'abc', role: 'admin' })).toString('base64url');
    assert.equal(verifySession(`${h}.${forged}.${s}`), null);
    assert.equal(verifySession('not-a-token'), null);
  });
});

describe('domain restriction', () => {
  const original = config.auth.allowedEmailDomains;
  after(() => { config.auth.allowedEmailDomains = original; });

  test('allows anything when the list is empty', () => {
    config.auth.allowedEmailDomains = [];
    assert.doesNotThrow(() => assertAllowedEmail('anyone@gmail.com'));
  });

  test('accepts a matching email suffix', () => {
    config.auth.allowedEmailDomains = ['college.edu'];
    assert.doesNotThrow(() => assertAllowedEmail('student@college.edu'));
    assert.doesNotThrow(() => assertAllowedEmail('STUDENT@College.EDU'));
  });

  test('accepts a matching Workspace hd claim', () => {
    config.auth.allowedEmailDomains = ['college.edu'];
    assert.doesNotThrow(() => assertAllowedEmail('person@alias.example', 'college.edu'));
  });

  test('rejects an outside domain', () => {
    config.auth.allowedEmailDomains = ['college.edu'];
    assert.throws(() => assertAllowedEmail('outsider@gmail.com'), /restricted to college.edu/);
  });

  test('is not fooled by a lookalike suffix', () => {
    config.auth.allowedEmailDomains = ['college.edu'];
    assert.throws(() => assertAllowedEmail('attacker@notcollege.edu'), /restricted/);
    assert.throws(() => assertAllowedEmail('attacker@college.edu.evil.com'), /restricted/);
    assert.equal(emailDomain('a@college.edu.evil.com'), 'college.edu.evil.com');
  });
});

describe('role assignment', () => {
  const original = config.auth.teacherEmails;
  after(() => { config.auth.teacherEmails = original; });

  test('listed emails become teachers, everyone else a student', () => {
    config.auth.teacherEmails = ['boss@college.edu'];
    assert.equal(initialRoleFor('boss@college.edu'), 'teacher');
    assert.equal(initialRoleFor('BOSS@college.edu'), 'teacher');
    assert.equal(initialRoleFor('someone@college.edu'), 'student');
  });
});

describe('google user provisioning', () => {
  test('claims a pre-seeded user by email, keeping their role', async () => {
    const seeded = await findUserByEmail('anita.rao@college.edu');
    assert.ok(seeded, 'expected the seeded teacher to exist');

    const user = await upsertGoogleUser({
      sub: 'google-sub-anita',
      email: 'anita.rao@college.edu',
      name: 'Anita Rao',
      picture: 'https://example.com/a.png',
    });
    assert.equal(user.id, seeded.id, 'should reuse the seeded row, not create a second one');
    assert.equal(user.role, 'teacher', 'seeded role must survive first sign-in');

    const { rows } = await query('SELECT count(*)::int AS n FROM users WHERE lower(email) = $1', ['anita.rao@college.edu']);
    assert.equal(rows[0].n, 1);
  });

  test('creates a new user as a student by default', async () => {
    const email = `newcomer-${Date.now()}@college.edu`;
    const user = await upsertGoogleUser({ sub: `sub-${Date.now()}`, email, name: 'New Comer' });
    assert.equal(user.role, 'student');
    await query('DELETE FROM users WHERE id = $1', [user.id]);
  });

  test('a returning user is matched on google_sub even if their email changed', async () => {
    const sub = `sub-rename-${Date.now()}`;
    const first = await upsertGoogleUser({ sub, email: `old-${Date.now()}@college.edu`, name: 'Before' });
    const second = await upsertGoogleUser({ sub, email: `new-${Date.now()}@college.edu`, name: 'After' });
    assert.equal(first.id, second.id);
    assert.equal(second.name, 'After');
    await query('DELETE FROM users WHERE id = $1', [first.id]);
  });
});

describe('role middleware', () => {
  const run = (mw, req) => new Promise((resolve) => mw(req, {}, (err) => resolve(err ?? null)));

  test('requireAuth rejects an anonymous request', async () => {
    assert.equal((await run(requireAuth, {}))?.status, 401);
    assert.equal(await run(requireAuth, { user: { role: 'student' } }), null);
  });

  test('requireRole gates on the role', async () => {
    const teacherOnly = requireRole('teacher', 'admin');
    assert.equal((await run(teacherOnly, { user: { role: 'student' } }))?.status, 403);
    assert.equal(await run(teacherOnly, { user: { role: 'teacher' } }), null);
    assert.equal(await run(teacherOnly, { user: { role: 'admin' } }), null);
  });
});

describe('http auth flow', () => {
  test('/api/auth/me is null before signing in', async () => {
    const res = await fetch(`${base}/api/auth/me`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { user: null });
  });

  test('dev-login issues an httpOnly session cookie', async () => {
    const res = await fetch(`${base}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'anita.rao@college.edu' }),
    });
    assert.equal(res.status, 200);
    const { user } = await res.json();
    assert.equal(user.role, 'teacher');

    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(config.auth.cookieName));
    assert.ok(cookie, 'expected a session cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);

    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal((await me.json()).user.email, 'anita.rao@college.edu');
  });

  test('dev-login refuses an unknown email and malformed input', async () => {
    const unknown = await fetch(`${base}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ghost@college.edu' }),
    });
    assert.equal(unknown.status, 400);

    const malformed = await fetch(`${base}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.details[0].field, 'email');
  });

  test('logout clears the session', async () => {
    const login = await fetch(`${base}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'aditya.menon@college.edu' }),
    });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];

    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    const cleared = out.headers.getSetCookie()[0];
    assert.match(cleared, new RegExp(`${config.auth.cookieName}=;`));
  });

  test('a session for a deleted user does not authenticate', async () => {
    const token = signSession({ id: '00000000-0000-0000-0000-000000000000', email: 'gone@college.edu', role: 'admin' });
    const res = await fetch(`${base}/api/auth/me`, { headers: { Cookie: `${config.auth.cookieName}=${token}` } });
    assert.deepEqual(await res.json(), { user: null });
  });

  test('google/start refuses when Google is not configured', async () => {
    const res = await fetch(`${base}/api/auth/google/start`, { redirect: 'manual' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /not configured/);
  });

  test('the google callback rejects a mismatched state', async () => {
    const res = await fetch(`${base}/api/auth/google/callback?code=x&state=forged`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/signin\?error=/);
  });
});

describe('google id token verification', () => {
  const original = config.auth.google.clientId;
  before(() => { config.auth.google.clientId = 'test-client.apps.googleusercontent.com'; });
  after(() => { config.auth.google.clientId = original; });

  test('rejects an algorithm downgrade', async () => {
    const { verifyIdToken } = await import('../src/services/google.js');
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'x' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: '1', email: 'a@college.edu' })).toString('base64url');
    await assert.rejects(() => verifyIdToken(`${header}.${payload}.`, null), (e) => {
      assert.equal(e.status, 401);
      assert.match(e.message, /unsupported algorithm \(none\)/);
      return true;
    });
  });

  test('rejects a symmetric-key token', async () => {
    const { default: jwtLib } = await import('jsonwebtoken');
    const { verifyIdToken } = await import('../src/services/google.js');
    const token = jwtLib.sign({ sub: '1', email: 'a@college.edu' }, 'guessable', { algorithm: 'HS256', keyid: 'x' });
    await assert.rejects(() => verifyIdToken(token, null), (e) => {
      assert.equal(e.status, 401);
      assert.match(e.message, /unsupported algorithm \(HS256\)/);
      return true;
    });
  });

  test('rejects a structurally malformed token', async () => {
    const { verifyIdToken } = await import('../src/services/google.js');
    await assert.rejects(() => verifyIdToken('garbage', null), (e) => {
      assert.equal(e.status, 400);
      return true;
    });
  });
});
