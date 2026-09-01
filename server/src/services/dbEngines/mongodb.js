import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { DbExecutionError } from './common.js';

const execFileAsync = promisify(execFile);

/**
 * MongoDB, executed through the real `mongosh`.
 *
 * The shell is not emulated: aggregation pipelines, $lookup, $unwind, indexes
 * and validators behave exactly as they do in the lab, because it is the same
 * shell talking to a real server.
 *
 * Two ways to get a server:
 *   - MONGODB_URL points at one (the department's server, per SPEC.md §11).
 *   - Otherwise a local `mongod` is started once and reused, with every run
 *     given its own freshly-named database that is dropped afterwards.
 */
export const id = 'mongodb';
export const label = 'MongoDB Shell';

let managed = null; // { proc, port, dir, ready }

async function hasBinary(name) {
  try {
    await execFileAsync(name, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function isAvailable() {
  if (!(await hasBinary('mongosh'))) return false;
  return Boolean(config.mongo.url) || (await hasBinary('mongod'));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(uri, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await execFileAsync('mongosh', [uri, '--quiet', '--eval', 'db.runCommand({ping:1}).ok'], { timeout: 5000 });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return false;
}

/** Starts a local mongod on first use and keeps it for the process lifetime. */
async function ensureServer() {
  if (config.mongo.url) return config.mongo.url.replace(/\/+$/, '');
  if (managed?.ready) return `mongodb://127.0.0.1:${managed.port}`;
  if (managed?.starting) return managed.starting;

  const startup = (async () => {
    if (!(await hasBinary('mongod'))) {
      throw new DbExecutionError(
        'MongoDB questions need a server: install mongod, or set MONGODB_URL to point at one.',
      );
    }
    const port = await freePort();
    const dir = path.join(os.tmpdir(), `classroom-mongo-${process.pid}`);
    await fs.mkdir(dir, { recursive: true });
    const proc = spawn('mongod', [
      '--dbpath', dir, '--port', String(port), '--bind_ip', '127.0.0.1',
      '--setParameter', 'enableTestCommands=1',
    ], { stdio: 'ignore', detached: false });
    proc.on('error', () => {});
    managed = { proc, port, dir, ready: false };

    const uri = `mongodb://127.0.0.1:${port}`;
    if (!(await waitForServer(uri))) {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      managed = null;
      throw new DbExecutionError('Could not start a local MongoDB server.');
    }
    managed.ready = true;
    managed.starting = null;
    console.log(`[mongo] local server ready on port ${port}`);
    return uri;
  })();

  managed = { ...(managed ?? {}), starting: startup };
  return startup;
}

export async function shutdown() {
  if (!managed?.proc) return;
  try { managed.proc.kill('SIGTERM'); } catch { /* already gone */ }
  const dir = managed.dir;
  managed = null;
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Splits a script into "everything before the last expression" and "the last
 * expression", so the last expression's value can be returned as the answer -
 * which is what typing it into the shell would show.
 *
 * The split point is found by *parsing* candidates rather than by guessing from
 * line shape. An earlier version looked at the last non-comment line, which
 * broke on any multi-line script: the last line of a formatted aggregation
 * pipeline is `])`, and it produced `return ]);`. Formatting a pipeline over
 * several lines is the normal way to write one.
 *
 * Candidates are tried from the end backwards; the right one is the latest
 * position where the first half parses as a program and the second as a single
 * expression.
 */
function parsesAsProgram(code) {
  if (!code.trim()) return true;
  try { new Function(`return (async () => { ${code} })`); return true; } catch { return false; }
}

function parsesAsExpression(code) {
  if (!code.trim()) return false;
  try { new Function(`return (async () => ( ${code} \n))`); return true; } catch { return false; }
}

export function withImplicitReturn(script) {
  const text = String(script ?? '').trimEnd().replace(/;+\s*$/, '');
  if (!text.trim()) return '';

  // Statement boundaries, latest first: after a `;` or `}`, or at a line start.
  const boundaries = new Set([0]);
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ';' || text[i] === '}' || text[i] === '\n') boundaries.add(i + 1);
  }
  const ordered = [...boundaries].sort((a, b) => b - a);

  for (const idx of ordered) {
    const head = text.slice(0, idx);
    const tail = text.slice(idx);
    if (parsesAsExpression(tail) && parsesAsProgram(head)) {
      return `${head}\nreturn ( ${tail}\n);`;
    }
  }
  return `${text};`;
}

/**
 * Wraps the student's script so the shell's behaviour is preserved: their
 * `print()` calls are captured, and the value of the last expression becomes
 * the answer, exactly as typing it into mongosh would show.
 *
 * The script is placed inline in the string handed to `mongosh --eval`, not run
 * through `eval()`, because mongosh rewrites that string to await its own async
 * calls. Inside a nested `eval` that rewriting does not happen and
 * `db.c.countDocuments()` comes back as a pending promise.
 */
function buildHarness(script) {
  return `
(async () => {
  const __out = [];
  // Keep the shell's own print before replacing it: the student's print() is
  // captured into __out, but the sentinel payload below must still reach stdout.
  const __emit = print;
  async function __normalise(value) {
    if (value === undefined || value === null) return [];
    // A cursor only contacts the server when it is drained, so an invalid
    // pipeline surfaces here. The error is left to propagate: it belongs in
    // the error report, not as a row of the student's result.
    if (typeof value.toArray === 'function') return await value.toArray();
    if (Array.isArray(value)) return value;
    return [value];
  }
  globalThis.print = (...a) => { __out.push({ type: 'print', text: a.map(String).join(' ') }); };
  globalThis.printjson = (v) => { __normalise(v).then((rows) => __out.push({ type: 'result', rows })); };
  try {
    let __value = await (async () => {
${withImplicitReturn(script)}
    })();
    if (__value && typeof __value.then === 'function') __value = await __value;
    if (__value !== undefined) __out.push({ type: 'result', rows: await __normalise(__value) });
    __emit('__CLASSROOM_OK__' + EJSON.stringify({ out: __out }, { relaxed: true }));
  } catch (e) {
    __emit('__CLASSROOM_ERR__' + EJSON.stringify({ message: e.message || String(e) }, { relaxed: true }));
  }
})()
`;
}

export async function run({ setupScripts = [], script, timeoutMs = 20000 }) {
  const base = await ensureServer();
  // A unique database per run: nothing a student writes is visible to anyone else.
  const dbName = `run_${crypto.randomBytes(8).toString('hex')}`;
  const uri = `${base}/${dbName}`;
  const started = Date.now();

  try {
    for (const setup of setupScripts) {
      if (!String(setup ?? '').trim()) continue;
      const { stdout } = await execFileAsync('mongosh', [uri, '--quiet', '--eval', setup], {
        timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      }).catch((err) => {
        throw new DbExecutionError(`The question's dataset failed to load: ${err.stderr || err.message}`);
      });
      void stdout;
    }

    const harness = buildHarness(script);
    let stdout;
    try {
      ({ stdout } = await execFileAsync('mongosh', [uri, '--quiet', '--eval', harness], {
        timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      }));
    } catch (err) {
      if (err.killed) throw new DbExecutionError(`Your script ran longer than ${Math.round(timeoutMs / 1000)}s.`);
      throw new DbExecutionError((err.stderr || err.message || '').trim().split('\n').slice(0, 6).join('\n'));
    }

    const okAt = stdout.indexOf('__CLASSROOM_OK__');
    const errAt = stdout.indexOf('__CLASSROOM_ERR__');
    if (errAt !== -1) {
      const payload = JSON.parse(stdout.slice(errAt + '__CLASSROOM_ERR__'.length).split('\n')[0]);
      throw new DbExecutionError(payload.message);
    }
    if (okAt === -1) {
      throw new DbExecutionError(stdout.trim().split('\n').slice(0, 6).join('\n') || 'The shell returned nothing.');
    }

    const payload = JSON.parse(stdout.slice(okAt + '__CLASSROOM_OK__'.length).split('\n')[0]);
    const resultSets = [];
    for (const item of payload.out) {
      if (item.type === 'print') {
        resultSets.push({ statement: null, columns: ['output'], rows: [{ output: item.text }], rowCount: 1 });
      } else {
        const rows = item.rows ?? [];
        const columns = [...new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : ['value'])))];
        resultSets.push({
          statement: null,
          columns: columns.length ? columns : ['value'],
          rows: rows.map((r) => (r && typeof r === 'object' ? r : { value: r })),
          rowCount: rows.length,
        });
      }
    }
    return { resultSets, timeMs: Date.now() - started };
  } finally {
    await execFileAsync('mongosh', [uri, '--quiet', '--eval', 'db.dropDatabase()'], { timeout: 8000 })
      .catch(() => {});
  }
}
