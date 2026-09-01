import { renderTable, formatValue } from './dbEngines/common.js';
import { DbExecutionError, runOnEngine } from './dbEngines/index.js';
import { HttpError } from '../lib/http.js';

/**
 * Judges a database question.
 *
 * The student's script runs against a fresh database seeded with the
 * worksheet's dataset, and the result set it produces is compared with what the
 * teacher expected. When a test case carries a verification query, that query
 * runs after the student's script and its result is compared instead, which is
 * how "create the table and insert five rows" gets checked.
 */

/** The last result set with columns is what the student's answer produced. */
function meaningfulResult(resultSets) {
  for (let i = resultSets.length - 1; i >= 0; i -= 1) {
    if (resultSets[i].columns?.length) return resultSets[i];
  }
  return resultSets[resultSets.length - 1] ?? { columns: [], rows: [], rowCount: 0 };
}

/**
 * Canonical form of a result set for comparison.
 *
 * Three things are normalised away, because none of them is what the question
 * is testing:
 *
 *   - Column name case. Engines disagree: Oracle upper-cases unquoted
 *     identifiers, PostgreSQL lower-cases them.
 *   - Column order (see below).
 *   - Row order, unless the question asks for it. A query without ORDER BY has
 *     no defined row order, so failing it for returning rows in a different
 *     sequence would itself be wrong. A question testing ORDER BY sets
 *     `ordered`.
 *
 * Which columns exist, and every value in them, still count.
 */
export function canonicalRows({ columns, rows }, { ordered = false } = {}) {
  // Sorting the column names makes the comparison independent of the order the
  // engine happened to return them in. MongoDB does not preserve the field
  // order written in a $project, so a correct pipeline can return
  // `count, language` where the teacher wrote `language, count`. Columns are
  // still matched by name, so which columns exist and what is in them counts.
  const cols = [...new Set((columns ?? []).map((c) => String(c).toLowerCase()))].sort();
  const lines = (rows ?? []).map((row) => {
    const byLower = {};
    for (const [k, v] of Object.entries(row ?? {})) byLower[String(k).toLowerCase()] = v;
    // A separator keeps different splits of the same characters apart, so
    // ('ab','c') and ('a','bc') do not compare equal.
    return cols.map((c) => formatValue(byLower[c])).join(' | ');
  });
  return { cols, lines: ordered ? lines : [...lines].sort() };
}

export function resultsMatch(actual, expected, { ordered = false } = {}) {
  const a = canonicalRows(actual, { ordered });
  const b = canonicalRows(expected, { ordered });
  if (a.cols.length !== b.cols.length) return false;
  if (a.cols.join(',') !== b.cols.join(',')) return false;
  if (a.lines.length !== b.lines.length) return false;
  return a.lines.every((line, i) => line === b.lines[i]);
}

/**
 * Parses the teacher's expected output.
 *
 * Accepts either JSON (an array of row objects, which is what copying out of
 * mongosh or a SQL client gives you) or the pipe-delimited table this platform
 * renders, so expected output can be pasted from either place.
 */
export function parseExpected(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { columns: [], rows: [] };

  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const columns = [...new Set(rows.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : ['value'])))];
      return { columns, rows: rows.map((r) => (r && typeof r === 'object' ? r : { value: r })) };
    } catch {
      // Not JSON after all, so fall through and read it as a table.
    }
  }

  const lines = raw.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { columns: [], rows: [] };
  const columns = lines[0].split('|').map((c) => c.trim());
  const body = lines.slice(1).filter((l) => !/^[-+\s|]+$/.test(l));
  const rows = body.map((line) => {
    const cells = line.split('|').map((c) => c.trim());
    return columns.reduce((acc, col, i) => {
      acc[col] = cells[i] ?? '';
      return acc;
    }, {});
  });
  return { columns, rows };
}

function friendlyError(message) {
  const m = String(message);
  if (/no such table|does not exist|ORA-00942/i.test(m)) {
    return 'A table your query refers to does not exist. Check the name, and whether your CREATE statements ran.';
  }
  if (/syntax error|ORA-00900|ORA-00933|SyntaxError|Unrecognized/i.test(m)) {
    return 'Your script has a syntax error. The engine reported the detail below.';
  }
  if (/ran longer than/i.test(m)) return m;
  return null;
}

/** Runs one database test case: seed, student script, optional verification. */
async function runCase({ engine, datasetScript, setupScript, script, verifyQuery, timeoutMs }) {
  const setupScripts = [datasetScript, setupScript].filter((s) => String(s ?? '').trim());
  if (verifyQuery && String(verifyQuery).trim()) {
    // Seed, then the student's script, then the verification query, all in one
    // session so the verification sees whatever the student created.
    const verified = await runOnEngine(engine, {
      setupScripts: [...setupScripts, script],
      script: verifyQuery,
      timeoutMs,
    });
    return { produced: meaningfulResult(verified.resultSets), all: verified.resultSets, timeMs: verified.timeMs };
  }
  const result = await runOnEngine(engine, { setupScripts, script, timeoutMs });
  return { produced: meaningfulResult(result.resultSets), all: result.resultSets, timeMs: result.timeMs };
}

/**
 * Runs a student's database answer against a question's test cases, returning
 * the same shape as the program judge so the frontend and the grading rules do
 * not need to know which kind of question this was.
 */
export async function runDatabaseQuestion({
  engine, script, testCases, datasetScript = null, setupScript = null, ordered = false, timeoutMs = 20000,
}) {
  if (!String(script ?? '').trim()) throw new HttpError(400, 'There is no code to run.');

  const graded = testCases.length > 0;
  const specs = graded
    ? testCases.map((tc) => ({ testCase: tc, verifyQuery: tc.input }))
    : [{ testCase: null, verifyQuery: null }];

  const cases = [];
  let engineError = null;

  for (const [i, spec] of specs.entries()) {
    let produced = { columns: [], rows: [] };
    let all = [];
    let timeMs = null;
    let error = null;

    try {
      const out = await runCase({
        engine, datasetScript, setupScript, script, verifyQuery: spec.verifyQuery, timeoutMs,
      });
      produced = out.produced;
      all = out.all;
      timeMs = out.timeMs;
    } catch (err) {
      if (!(err instanceof DbExecutionError)) throw err;
      error = err;
      engineError = engineError ?? err;
    }

    const expected = spec.testCase ? parseExpected(spec.testCase.expectedOutput) : null;
    const passed = spec.testCase ? (!error && resultsMatch(produced, expected, { ordered })) : null;

    cases.push({
      testCaseId: spec.testCase?.id ?? null,
      label: spec.testCase?.label ?? (graded ? `Check ${i + 1}` : 'Query result'),
      input: spec.verifyQuery || '',
      expectedOutput: expected ? renderTable(expected) : null,
      actualOutput: error ? '' : renderTable(produced),
      resultTable: error ? null : { columns: produced.columns, rows: produced.rows, rowCount: produced.rowCount },
      statements: error ? [] : all.map((rs) => ({
        statement: rs.statement, columns: rs.columns, rowCount: rs.rowCount, message: rs.message ?? null,
      })),
      stderr: error ? error.message : null,
      passed,
      status: error ? 'Error' : 'Executed',
      statusId: error ? 11 : 3,
      explanation: error
        ? (friendlyError(error.message) ?? 'Your script did not run. The engine reported the detail below.')
        : (passed === false ? 'The rows your query returned do not match the expected result.' : null),
      timeMs,
      memoryKb: null,
    });
  }

  const passedCount = cases.filter((c) => c.passed === true).length;
  const totalCount = graded ? cases.length : 0;

  let verdict;
  if (engineError && passedCount === 0) verdict = 'error';
  else if (!graded) verdict = 'no_test_cases';
  else if (passedCount === totalCount) verdict = 'passed';
  else verdict = 'failed';

  return {
    verdict,
    graded,
    passedCount,
    totalCount,
    compileOutput: null,
    cases,
    executor: `db:${engine}`,
    degraded: false,
    ranAt: new Date().toISOString(),
  };
}
