import { createApp } from '../src/app.js';
import { config } from '../src/config.js';

/** Boots the app on an ephemeral port and returns a small fetch client. */
export async function startTestServer() {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { body, cookie, raw = false } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, body: json, headers: res.headers };
  };

  /** Signs in via dev-login and returns the session cookie string. */
  const signIn = async (email) => {
    const res = await fetch(`${base}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (res.status !== 200) throw new Error(`dev-login failed for ${email}: ${res.status} ${await res.text()}`);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(config.auth.cookieName));
    return setCookie.split(';')[0];
  };

  return {
    base,
    close: () => server.close(),
    signIn,
    get: (p, o) => call('GET', p, o),
    post: (p, body, o) => call('POST', p, { ...o, body }),
    patch: (p, body, o) => call('PATCH', p, { ...o, body }),
    put: (p, body, o) => call('PUT', p, { ...o, body }),
    del: (p, o) => call('DELETE', p, o),
  };
}

export const TEACHER_A = 'anita.rao@college.edu';
export const TEACHER_B = 'vikram.shah@college.edu';
export const STUDENT_A = 'aditya.menon@college.edu';
export const STUDENT_B = 'bhavna.iyer@college.edu';
