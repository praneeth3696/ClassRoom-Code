import { config } from '../config.js';
import { LANGUAGES, getLanguage } from '../lib/languages.js';

// Judge0 runs compiled and interpreted programs. Database engines are executed
// by this platform's own engines, so they never reach here.
const PROGRAM_LANGUAGES = LANGUAGES.filter((l) => l.kind === 'program');
import { HttpError } from '../lib/http.js';

/**
 * Judge0 CE client (SPEC.md §10).
 *
 * Uses the batch submission API with polling rather than `wait=true`, because
 * synchronous waiting is disabled by default on self-hosted instances.
 *
 * Judge0 can compare against `expected_output` itself, but this client does not
 * ask it to: the comparison happens in `execution.js` so that the verdict is
 * identical whichever executor ran the code. What Judge0 is trusted for is the
 * part only it knows — compile errors, timeouts, signals, and resource usage.
 */

// https://ce.judge0.com/#statuses-and-languages-status-get
export const JUDGE0_STATUS = {
  IN_QUEUE: 1,
  PROCESSING: 2,
  ACCEPTED: 3,
  WRONG_ANSWER: 4,
  TIME_LIMIT_EXCEEDED: 5,
  COMPILATION_ERROR: 6,
  RUNTIME_ERROR_SIGSEGV: 7,
  RUNTIME_ERROR_SIGXFSZ: 8,
  RUNTIME_ERROR_SIGFPE: 9,
  RUNTIME_ERROR_SIGABRT: 10,
  RUNTIME_ERROR_NZEC: 11,
  RUNTIME_ERROR_OTHER: 12,
  INTERNAL_ERROR: 13,
  EXEC_FORMAT_ERROR: 14,
};

export function isJudge0Configured() {
  return Boolean(config.judge0.url);
}

const b64encode = (s) => Buffer.from(s ?? '', 'utf8').toString('base64');
const b64decode = (s) => (s ? Buffer.from(s, 'base64').toString('utf8') : '');

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (config.judge0.authToken) h['X-Auth-Token'] = config.judge0.authToken;
  return h;
}

async function judge0Fetch(path, init = {}, timeoutMs = 15000) {
  const url = `${config.judge0.url.replace(/\/$/, '')}${path}`;
  let res;
  try {
    res = await fetch(url, { ...init, headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new HttpError(503, `Could not reach the code execution service: ${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(502, `Code execution service returned ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new HttpError(502, 'Code execution service returned a malformed response');
  }
}

// --- Language id resolution --------------------------------------------------

let languageCache = { map: null, at: 0 };
const LANGUAGE_TTL_MS = 60 * 60 * 1000;

/**
 * Maps our language ids to the instance's own numeric ids. A self-hosted
 * Judge0 may carry a different set from the public one, so the ids in
 * lib/languages.js are only a fallback.
 */
export async function resolveLanguageIds({ force = false } = {}) {
  if (!force && languageCache.map && Date.now() - languageCache.at < LANGUAGE_TTL_MS) {
    return languageCache.map;
  }
  const map = new Map();
  try {
    const available = await judge0Fetch('/languages');
    for (const lang of PROGRAM_LANGUAGES) {
      // Prefer the highest id matching the language, which is the newest
      // compiler version the instance offers.
      const matches = available
        .filter((entry) => lang.judge0Match.test(entry.name))
        .sort((a, b) => b.id - a.id);
      map.set(lang.id, matches[0]?.id ?? lang.judge0Id);
    }
  } catch (err) {
    console.warn(`[judge0] could not read /languages (${err.message}); using built-in ids`);
    for (const lang of PROGRAM_LANGUAGES) map.set(lang.id, lang.judge0Id);
  }
  languageCache = { map, at: Date.now() };
  return map;
}

// --- Execution ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one program against several stdin inputs.
 * Returns one raw result per input, in the order given.
 */
export async function runBatch({ code, language, inputs }) {
  const lang = getLanguage(language);
  if (!lang) throw new HttpError(400, `Unsupported language: ${language}`);
  if (lang.kind !== 'program') {
    throw new HttpError(400, `${lang.label} is a database engine and is not run through Judge0`);
  }
  const languageIds = await resolveLanguageIds();
  const languageId = languageIds.get(lang.id);

  const submissions = inputs.map((stdin) => ({
    source_code: b64encode(code),
    language_id: languageId,
    stdin: b64encode(stdin ?? ''),
    cpu_time_limit: config.judge0.cpuTimeLimit,
    wall_time_limit: config.judge0.wallTimeLimit,
    memory_limit: config.judge0.memoryLimitKb,
    redirect_stderr_to_stdout: false,
  }));

  const created = await judge0Fetch('/submissions/batch?base64_encoded=true', {
    method: 'POST',
    body: JSON.stringify({ submissions }),
  });

  const tokens = created.map((c) => c.token).filter(Boolean);
  if (tokens.length !== inputs.length) {
    throw new HttpError(502, 'Code execution service did not accept every test case');
  }

  const fields = 'stdout,stderr,compile_output,message,status,time,memory,exit_code,token';
  const deadline = Date.now() + (config.judge0.wallTimeLimit * 1000 + 5000) * Math.max(1, inputs.length);
  let delay = 250;

  while (Date.now() < deadline) {
    const batch = await judge0Fetch(
      `/submissions/batch?tokens=${tokens.join(',')}&base64_encoded=true&fields=${fields}`,
    );
    const results = batch.submissions ?? [];
    const settled = results.every((r) => (r?.status?.id ?? 0) > JUDGE0_STATUS.PROCESSING);
    if (settled) {
      return results.map((r) => ({
        stdout: b64decode(r.stdout),
        stderr: b64decode(r.stderr),
        compileOutput: b64decode(r.compile_output),
        message: b64decode(r.message),
        statusId: r.status?.id ?? JUDGE0_STATUS.INTERNAL_ERROR,
        statusText: r.status?.description ?? 'Unknown',
        timeMs: r.time === null || r.time === undefined ? null : Math.round(Number(r.time) * 1000),
        memoryKb: r.memory ?? null,
        exitCode: r.exit_code ?? null,
      }));
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 1500);
  }

  throw new HttpError(504, 'The code execution service did not finish in time. Please try again.');
}

/** Liveness probe used by /api/health. */
export async function judge0Status() {
  if (!isJudge0Configured()) return { configured: false, reachable: false };
  try {
    const info = await judge0Fetch('/about', {}, 5000);
    return { configured: true, reachable: true, version: info?.version ?? null };
  } catch (err) {
    return { configured: true, reachable: false, error: err.message };
  }
}
