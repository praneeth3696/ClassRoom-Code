import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { getLanguage } from '../lib/languages.js';
import { HttpError } from '../lib/http.js';
import { JUDGE0_STATUS } from './judge0.js';

/**
 * Development-only executor: compiles and runs student code in a subprocess so
 * the platform works end to end without a Judge0 instance.
 *
 * !! THIS IS NOT A SANDBOX. !!
 *
 * It applies a wall-clock timeout and caps captured output, but student code
 * runs with this process's own user and full access to the machine — no
 * cgroups, no seccomp, no filesystem isolation. Judge0 exists precisely because
 * doing this safely is hard (SPEC.md §10). Guarded by ALLOW_LOCAL_EXECUTION,
 * which the production config check refuses to let you enable.
 */

const MAX_OUTPUT_BYTES = 64 * 1024;

const RECIPES = {
  python: { file: 'main.py', run: ['python3', ['main.py']] },
  c: { file: 'main.c', compile: ['cc', ['main.c', '-O0', '-o', 'program', '-lm']], run: ['./program', []] },
  cpp: { file: 'main.cpp', compile: ['c++', ['main.cpp', '-O0', '-std=c++17', '-o', 'program']], run: ['./program', []] },
  java: { file: 'Main.java', compile: ['javac', ['Main.java']], run: ['java', ['-Xmx256m', 'Main']] },
};

function runProcess(command, args, { cwd, stdin = '', timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      // Its own process group, so a timeout kills any children it spawned too.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: cwd, LANG: 'C.UTF-8' },
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;

    const collect = (buf, chunk) => {
      if (buf.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return buf;
      }
      return Buffer.concat([buf, chunk]).subarray(0, MAX_OUTPUT_BYTES);
    };

    child.stdout.on('data', (c) => { stdout = collect(stdout, c); });
    child.stderr.on('data', (c) => { stderr = collect(stderr, c); });

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    const started = Date.now();
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: err, stdout: '', stderr: err.message, code: null, timedOut, timeMs: 0, truncated });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        code,
        timedOut,
        timeMs: Date.now() - started,
        truncated,
      });
    });

    child.stdin.on('error', () => {}); // the program may exit without reading stdin
    child.stdin.end(stdin ?? '');
  });
}

/** Mirrors judge0.runBatch's return shape so callers cannot tell them apart. */
export async function runBatchLocally({ code, language, inputs }) {
  if (!config.judge0.allowLocalFallback) {
    throw new HttpError(503, 'Code execution is not available: no Judge0 instance is configured.');
  }
  const lang = getLanguage(language);
  const recipe = lang && RECIPES[lang.id];
  if (!recipe) throw new HttpError(400, `Unsupported language: ${language}`);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'classroom-run-'));
  try {
    await fs.writeFile(path.join(dir, recipe.file), code ?? '', 'utf8');

    if (recipe.compile) {
      const [cmd, args] = recipe.compile;
      const compiled = await runProcess(cmd, args, { cwd: dir, timeoutMs: 20000 });
      if (compiled.error) {
        throw new HttpError(503, `Local execution needs "${cmd}" on PATH, which is not installed.`);
      }
      if (compiled.code !== 0 || compiled.timedOut) {
        const output = compiled.stderr || compiled.stdout || 'Compilation failed';
        // One compile error, repeated per test case, matching Judge0's shape.
        return inputs.map(() => ({
          stdout: '', stderr: '', compileOutput: output, message: '',
          statusId: JUDGE0_STATUS.COMPILATION_ERROR, statusText: 'Compilation Error',
          timeMs: compiled.timeMs, memoryKb: null, exitCode: compiled.code,
        }));
      }
    }

    const [cmd, args] = recipe.run;
    const results = [];
    for (const stdin of inputs) {
      const r = await runProcess(cmd, args, {
        cwd: dir,
        stdin,
        timeoutMs: config.judge0.wallTimeLimit * 1000,
      });
      if (r.error) {
        throw new HttpError(503, `Local execution needs "${cmd}" on PATH, which is not installed.`);
      }
      let statusId = JUDGE0_STATUS.ACCEPTED;
      let statusText = 'Executed';
      if (r.timedOut) {
        statusId = JUDGE0_STATUS.TIME_LIMIT_EXCEEDED;
        statusText = 'Time Limit Exceeded';
      } else if (r.code !== 0) {
        statusId = JUDGE0_STATUS.RUNTIME_ERROR_NZEC;
        statusText = `Runtime Error (exit code ${r.code})`;
      }
      results.push({
        stdout: r.truncated ? `${r.stdout}\n...[output truncated]` : r.stdout,
        stderr: r.stderr,
        compileOutput: '',
        message: '',
        statusId,
        statusText,
        timeMs: r.timeMs,
        memoryKb: null,
        exitCode: r.code,
      });
    }
    return results;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Reports which languages this machine can actually build and run. */
export async function localRunnerStatus() {
  const available = {};
  for (const [id, recipe] of Object.entries(RECIPES)) {
    const [cmd] = recipe.compile ?? recipe.run;
    const probe = await runProcess(cmd, ['--version'], { cwd: os.tmpdir(), timeoutMs: 5000 });
    available[id] = !probe.error;
  }
  return { enabled: config.judge0.allowLocalFallback, languages: available };
}
