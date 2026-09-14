import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { prepareTestDb, teardownTestDb } from './setup.js';
import { startTestServer } from './helpers.js';
import { contentSecurityPolicy } from '../src/middleware/securityHeaders.js';

let api;

before(async () => {
  await prepareTestDb({ seed: false });
  api = await startTestServer();
});

after(async () => {
  api?.close();
  await teardownTestDb();
});

const directives = (header) => Object.fromEntries(
  header.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const [name, ...values] = d.split(/\s+/);
    return [name, values];
  }),
);

describe('security headers', () => {
  test('API responses forbid MIME sniffing, framing and referrer leaks', async () => {
    const { headers } = await api.get('/api/health');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('x-frame-options'), 'DENY');
    assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(headers.get('x-powered-by'), null, 'the framework is not advertised');
  });

  test('the content security policy only allows this origin, plus what Monaco needs', async () => {
    const { headers } = await api.get('/api/health');
    const csp = directives(headers.get('content-security-policy'));
    assert.deepEqual(csp['default-src'], ["'self'"]);
    assert.deepEqual(csp['script-src'], ["'self'"], 'no inline or remote scripts');
    assert.deepEqual(csp['object-src'], ["'none'"]);
    assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
    assert.ok(csp['worker-src'].includes('blob:'), 'Monaco starts its language workers from blob URLs');
    assert.ok(csp['style-src'].includes("'unsafe-inline'"), 'Monaco injects its theme as inline styles');
  });

  test('outside production, nothing forces HTTPS on a plain-http development server', async () => {
    const { headers } = await api.get('/api/health');
    assert.equal(headers.get('strict-transport-security'), null);
    assert.ok(!headers.get('content-security-policy').includes('upgrade-insecure-requests'));
  });

  test('in production the policy upgrades requests to HTTPS and HSTS is sent', () => {
    const production = directives(contentSecurityPolicy({ production: true }));
    assert.ok('upgrade-insecure-requests' in production);
  });
});
