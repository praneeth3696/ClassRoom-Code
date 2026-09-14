import { config } from '../config.js';
import { JUDGE0_STATUS, isJudge0Configured, runBatch } from './judge0.js';
import { runBatchLocally } from './localRunner.js';
import { runDatabaseQuestion } from './dbJudge.js';
import { getLanguage, isDatabaseLanguage } from '../lib/languages.js';
import { HttpError } from '../lib/http.js';
import { createLimiter } from '../lib/limiter.js';

// Every Run and Submit goes through one bounded queue, whichever engine runs it.
const executionLimiter = createLimiter({
  name: 'execution',
  concurrency: config.execution.concurrency,
  maxQueue: config.execution.maxQueue,
  queueTimeoutMs: config.execution.queueTimeoutMs,
});

/** Live queue figures for /api/health. */
export function executionQueueStats() {
  return executionLimiter.stats();
}

/**
 * Chooses an executor and turns raw execution output into a verdict.
 *
 * Comparison lives here rather than in Judge0 so a submission is judged the
 * same way whichever backend ran it.
 */

/**
 * Compares program output with the expected output.
 *
 * Trailing whitespace on each line and blank lines at the end are ignored, and
 * line endings are normalised. Marking an otherwise-correct answer wrong over
 * a missing final newline teaches students nothing (SPEC.md §9 — the point is
 * understanding the mistake), and every judge in practice trims this way.
 * Whitespace *inside* a line is still significant.
 */
export function normalizeOutput(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

export function outputMatches(actual, expected) {
  return normalizeOutput(actual) === normalizeOutput(expected);
}

const FAILED_TO_RUN = new Set([
  JUDGE0_STATUS.TIME_LIMIT_EXCEEDED,
  JUDGE0_STATUS.COMPILATION_ERROR,
  JUDGE0_STATUS.RUNTIME_ERROR_SIGSEGV,
  JUDGE0_STATUS.RUNTIME_ERROR_SIGXFSZ,
  JUDGE0_STATUS.RUNTIME_ERROR_SIGFPE,
  JUDGE0_STATUS.RUNTIME_ERROR_SIGABRT,
  JUDGE0_STATUS.RUNTIME_ERROR_NZEC,
  JUDGE0_STATUS.RUNTIME_ERROR_OTHER,
  JUDGE0_STATUS.INTERNAL_ERROR,
  JUDGE0_STATUS.EXEC_FORMAT_ERROR,
]);

/** A short, student-facing explanation of why a case did not pass. */
function describeFailure(raw) {
  switch (raw.statusId) {
    case JUDGE0_STATUS.COMPILATION_ERROR:
      return 'Your code did not compile.';
    case JUDGE0_STATUS.TIME_LIMIT_EXCEEDED:
      return `Your program ran longer than ${config.judge0.wallTimeLimit}s — check for an infinite loop, or for input you never read.`;
    case JUDGE0_STATUS.RUNTIME_ERROR_SIGSEGV:
      return 'Your program crashed (segmentation fault) — often an out-of-range array index or a bad pointer.';
    case JUDGE0_STATUS.RUNTIME_ERROR_SIGFPE:
      return 'Your program crashed on an arithmetic error, such as dividing by zero.';
    case JUDGE0_STATUS.RUNTIME_ERROR_NZEC:
    case JUDGE0_STATUS.RUNTIME_ERROR_SIGABRT:
    case JUDGE0_STATUS.RUNTIME_ERROR_OTHER:
      return 'Your program stopped with an error before finishing.';
    case JUDGE0_STATUS.INTERNAL_ERROR:
    case JUDGE0_STATUS.EXEC_FORMAT_ERROR:
      return 'The execution service could not run this submission.';
    default:
      return 'The output did not match the expected output.';
  }
}

export function chooseExecutor() {
  if (isJudge0Configured()) return 'judge0';
  if (config.judge0.allowLocalFallback) return 'local';
  return null;
}

async function execute({ code, language, inputs }) {
  const executor = chooseExecutor();
  if (!executor) {
    throw new HttpError(
      503,
      'Code execution is not configured on this server. Set JUDGE0_URL.',
      undefined,
      { expose: true },
    );
  }
  if (executor === 'judge0') {
    try {
      return { executor, results: await runBatch({ code, language, inputs }) };
    } catch (err) {
      // A configured-but-unreachable Judge0 falls back locally in development
      // only, so a dev machine keeps working when the container is down.
      if (config.judge0.allowLocalFallback && err.status >= 500) {
        console.warn(`[exec] Judge0 unavailable (${err.message}); falling back to local execution`);
        return { executor: 'local', results: await runBatchLocally({ code, language, inputs }), degraded: true };
      }
      throw err;
    }
  }
  return { executor, results: await runBatchLocally({ code, language, inputs }) };
}

/**
 * Runs `code` against a question's test cases and returns a full result.
 *
 * A question with no test cases is still executed once with empty input so the
 * student can see their program's output; it simply has nothing to compare
 * against and is left for the teacher to judge (SPEC.md §7, §9).
 */
export async function runAgainstTestCases(options) {
  // Refuse empty code before queueing, so a validation error never waits.
  if (!String(options.code ?? '').trim()) {
    throw new HttpError(400, 'There is no code to run.');
  }
  return executionLimiter.run(() => judge(options));
}

async function judge({
  code, language, testCases, datasetScript = null, setupScript = null, ordered = false,
}) {
  // Database answers are judged on the rows they return, not on stdout, so
  // they take a different path entirely.
  if (isDatabaseLanguage(language)) {
    return runDatabaseQuestion({
      engine: getLanguage(language).engine,
      script: code,
      testCases,
      datasetScript,
      setupScript,
      ordered,
    });
  }

  const graded = testCases.length > 0;
  const inputs = graded ? testCases.map((tc) => tc.input ?? '') : [''];
  const { executor, results, degraded } = await execute({ code, language, inputs });

  const compileError = results.find((r) => r.statusId === JUDGE0_STATUS.COMPILATION_ERROR);
  const cases = results.map((raw, i) => {
    const testCase = graded ? testCases[i] : null;
    const ran = !FAILED_TO_RUN.has(raw.statusId);
    const passed = graded ? ran && outputMatches(raw.stdout, testCase.expectedOutput) : null;
    return {
      testCaseId: testCase?.id ?? null,
      label: testCase?.label ?? (graded ? `Test case ${i + 1}` : 'Program output'),
      input: graded ? testCase.input : '',
      expectedOutput: graded ? testCase.expectedOutput : null,
      actualOutput: raw.stdout,
      stderr: raw.stderr || null,
      passed,
      status: raw.statusText,
      statusId: raw.statusId,
      explanation: passed === false ? describeFailure(raw) : null,
      timeMs: raw.timeMs,
      memoryKb: raw.memoryKb,
    };
  });

  const passedCount = cases.filter((c) => c.passed === true).length;
  const totalCount = graded ? cases.length : 0;

  let verdict;
  if (compileError) verdict = 'compile_error';
  else if (!graded) verdict = 'no_test_cases';
  else if (passedCount === totalCount) verdict = 'passed';
  else verdict = 'failed';

  return {
    verdict,
    graded,
    passedCount,
    totalCount,
    compileOutput: compileError?.compileOutput || null,
    cases,
    executor,
    degraded: Boolean(degraded),
    ranAt: new Date().toISOString(),
  };
}

/** Whether a run counts as an automated pass. Null when nothing was graded. */
export function autoPassedFrom(result) {
  if (!result || !result.graded) return null;
  return result.verdict === 'passed';
}
