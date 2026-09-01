import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config.js';

/**
 * Exercises the Judge0 client against a stub that speaks the real CE protocol:
 * base64 payloads, batch submission returning tokens, and results that only
 * settle after a few polls. Verifies the wire format without needing Docker.
 */

let server, requests, behaviour;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s ?? '', 'base64').toString('utf8');

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, headers: req.headers });
      const send = (code, payload) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url.startsWith('/languages')) return send(200, behaviour.languages);
      if (req.url.startsWith('/about')) return send(200, { version: '1.13.0' });
      if (req.method === 'POST' && req.url.startsWith('/submissions/batch')) {
        behaviour.polls = 0;
        return send(201, body ? JSON.parse(body).submissions.map((_, i) => ({ token: `tok-${i}` })) : []);
      }
      if (req.method === 'GET' && req.url.startsWith('/submissions/batch')) {
        behaviour.polls += 1;
        if (behaviour.polls < behaviour.settleAfter) {
          return send(200, { submissions: behaviour.pending });
        }
        return send(200, { submissions: behaviour.finished });
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, r));
  config.judge0.url = `http://127.0.0.1:${server.address().port}`;
  config.judge0.authToken = 'test-token';
});

after(() => {
  server?.close();
  config.judge0.url = null;
  config.judge0.authToken = null;
});

function reset() {
  requests = [];
  behaviour = {
    polls: 0,
    settleAfter: 1,
    languages: [
      { id: 50, name: 'C (GCC 9.2.0)' },
      { id: 75, name: 'C (Clang 7.0.1)' },
      { id: 54, name: 'C++ (GCC 9.2.0)' },
      { id: 62, name: 'Java (OpenJDK 13.0.1)' },
      { id: 71, name: 'Python (3.8.1)' },
      { id: 70, name: 'Python (2.7.17)' },
    ],
    pending: [{ status: { id: 2, description: 'Processing' } }, { status: { id: 1, description: 'In Queue' } }],
    finished: [
      { token: 'tok-0', stdout: b64('5\n'), stderr: null, compile_output: null, status: { id: 3, description: 'Accepted' }, time: '0.012', memory: 3200, exit_code: 0 },
      { token: 'tok-1', stdout: b64('0\n'), stderr: null, compile_output: null, status: { id: 3, description: 'Accepted' }, time: '0.011', memory: 3100, exit_code: 0 },
    ],
  };
}

describe('judge0 client', () => {
  test('resolves language ids from the instance, preferring the newest', async () => {
    reset();
    const { resolveLanguageIds } = await import('../src/services/judge0.js');
    const map = await resolveLanguageIds({ force: true });
    assert.equal(map.get('c'), 75, 'should pick the newest matching C, not the first');
    assert.equal(map.get('cpp'), 54);
    assert.equal(map.get('java'), 62);
    assert.equal(map.get('python'), 71, 'must not match Python 2');
  });

  test('sends base64 payloads, limits, and the auth token', async () => {
    reset();
    const { runBatch, resolveLanguageIds } = await import('../src/services/judge0.js');
    await resolveLanguageIds({ force: true });
    requests.length = 0;

    await runBatch({ code: 'print(1)', language: 'python', inputs: ['2 3\n', '-1 1\n'] });

    const post = requests.find((r) => r.method === 'POST');
    assert.ok(post, 'expected a batch submission');
    assert.match(post.url, /base64_encoded=true/);
    assert.equal(post.headers['x-auth-token'], 'test-token');
    assert.equal(post.body.submissions.length, 2);
    assert.equal(unb64(post.body.submissions[0].source_code), 'print(1)');
    assert.equal(unb64(post.body.submissions[0].stdin), '2 3\n');
    assert.equal(post.body.submissions[0].language_id, 71);
    assert.equal(post.body.submissions[0].cpu_time_limit, config.judge0.cpuTimeLimit);
    assert.equal(post.body.submissions[0].memory_limit, config.judge0.memoryLimitKb);
  });

  test('polls until every submission settles, then decodes results', async () => {
    reset();
    behaviour.settleAfter = 3;
    const { runBatch } = await import('../src/services/judge0.js');
    const results = await runBatch({ code: 'print(1)', language: 'python', inputs: ['a', 'b'] });

    const polls = requests.filter((r) => r.method === 'GET' && r.url.startsWith('/submissions/batch'));
    assert.equal(polls.length, 3, 'should keep polling while status is In Queue/Processing');
    assert.equal(results.length, 2);
    assert.equal(results[0].stdout, '5\n');
    assert.equal(results[0].statusId, 3);
    assert.equal(results[0].timeMs, 12, 'seconds are converted to milliseconds');
    assert.equal(results[0].memoryKb, 3200);
  });

  test('decodes a compile error', async () => {
    reset();
    behaviour.finished = [
      { token: 'tok-0', stdout: null, stderr: null, compile_output: b64('main.c:1: error: expected ;'), status: { id: 6, description: 'Compilation Error' }, time: null, memory: null },
    ];
    const { runBatch } = await import('../src/services/judge0.js');
    const [result] = await runBatch({ code: 'bad', language: 'c', inputs: [''] });
    assert.equal(result.statusId, 6);
    assert.match(result.compileOutput, /expected ;/);
    assert.equal(result.timeMs, null);
  });

  test('an unreachable instance reports a 503, not a crash', async () => {
    reset();
    const saved = config.judge0.url;
    config.judge0.url = 'http://127.0.0.1:1';
    try {
      const { runBatch, resolveLanguageIds } = await import('../src/services/judge0.js');
      await resolveLanguageIds({ force: true }); // falls back to built-in ids
      await assert.rejects(
        () => runBatch({ code: 'print(1)', language: 'python', inputs: [''] }),
        (e) => { assert.equal(e.status, 503); assert.match(e.message, /Could not reach/); return true; },
      );
    } finally {
      config.judge0.url = saved;
    }
  });

  test('the health probe reports the instance version', async () => {
    reset();
    const { judge0Status } = await import('../src/services/judge0.js');
    const status = await judge0Status();
    assert.deepEqual(status, { configured: true, reachable: true, version: '1.13.0' });
  });
});
