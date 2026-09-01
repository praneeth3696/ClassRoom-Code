/**
 * Shared shapes for database question execution.
 *
 * Every engine returns the same thing: a list of result sets, each a
 * `{ columns, rows }` table. The comparison logic in `dbJudge.js` then works
 * identically across SQLite, PostgreSQL, Oracle and MongoDB.
 */

export class DbExecutionError extends Error {
  constructor(message, { statement = null } = {}) {
    super(message);
    this.statement = statement;
  }
}

/** Serialises objects with sorted keys so equal documents compare equal. */
function stableReplacer(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).sort().reduce((acc, k) => {
      acc[k] = value[k];
      return acc;
    }, {});
  }
  return value;
}

export function formatValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (typeof value === 'object') return JSON.stringify(value, stableReplacer);
  return String(value);
}

/** Renders a result set as a stable text table, for display and comparison. */
export function renderTable({ columns, rows }) {
  if (!columns || columns.length === 0) return '';
  const header = columns.map(String);
  const body = rows.map((row) => header.map((c) => formatValue(row[c])));
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length), 0));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join(' | ').trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('-+-').trimEnd(), ...body.map(line)].join('\n');
}

/**
 * Walks a SQL script, calling back at each top-level `;` and at each lone `/`
 * on its own line, skipping over string literals and both comment styles.
 */
function scanSql(text, onBreak) {
  let i = 0;
  let start = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { i += 2; inBlockComment = false; continue; }
      i += 1;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (next === "'") { i += 2; continue; } // an escaped quote inside a literal
        inSingle = false;
      }
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }

    if (ch === '-' && next === '-') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
    if (ch === "'") { inSingle = true; i += 1; continue; }
    if (ch === '"') { inDouble = true; i += 1; continue; }

    if (ch === ';') {
      onBreak(text.slice(start, i), ';');
      i += 1;
      start = i;
      continue;
    }

    // A `/` alone on its own line: in SQL*Plus this runs the buffered block,
    // which is how PL/SQL bodies and Oracle object types are terminated.
    if (ch === '/') {
      const lineStart = text.lastIndexOf('\n', i - 1) + 1;
      const beforeOnLine = text.slice(lineStart, i).trim();
      const afterOnLine = text.slice(i + 1).match(/^[ \t]*(\r?\n|$)/);
      if (beforeOnLine === '' && afterOnLine) {
        onBreak(text.slice(start, i), '/');
        i += 1;
        start = i;
        continue;
      }
    }

    i += 1;
  }
  if (start < text.length) onBreak(text.slice(start), 'eof');
}

/**
 * Splits a SQL script into statements.
 *
 * Follows SQL*Plus semantics, in two passes. A lone `/` on its own line runs
 * whatever is buffered as a single statement no matter how many semicolons it
 * contains, which is how PL/SQL bodies and Oracle object types are written.
 * Everything else splits on semicolons.
 *
 * Doing it this way rather than trying to recognise block openers means
 * PostgreSQL's `CREATE TYPE x AS (...)` — an ordinary statement that merely
 * starts with the same two words as Oracle's — is not mistaken for a block.
 *
 * This is a pragmatic splitter, not a full parser: it exists so a student can
 * paste a multi-statement answer and have it run in order.
 */
export function splitSqlStatements(script) {
  const text = String(script ?? '');

  // Pass 1: cut the script into segments at each lone `/`.
  const segments = [];
  let buffer = '';
  scanSql(text, (chunk, kind) => {
    if (kind === '/') {
      segments.push({ text: buffer + chunk, terminatedBySlash: true });
      buffer = '';
    } else {
      buffer += chunk + (kind === ';' ? ';' : '');
    }
  });
  if (buffer.trim()) segments.push({ text: buffer, terminatedBySlash: false });

  // Pass 2: a `/`-terminated segment is one statement; anything else splits on `;`.
  const statements = [];
  for (const segment of segments) {
    if (segment.terminatedBySlash) {
      const trimmed = segment.text.trim().replace(/;\s*$/, '');
      if (trimmed) statements.push(trimmed);
      continue;
    }
    scanSql(segment.text, (chunk) => {
      const trimmed = chunk.trim();
      if (trimmed && trimmed !== '/') statements.push(trimmed);
    });
  }
  return statements;
}

/** Whether a statement is expected to return rows. */
export function isQueryStatement(sql) {
  return /^\s*(SELECT|WITH|SHOW|PRAGMA|EXPLAIN|DESC|DESCRIBE|VALUES)\b/i.test(sql);
}

/** Strips leading comments so statement detection sees the real keyword. */
export function stripLeadingComments(sql) {
  let s = String(sql ?? '');
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '').replace(/^--[^\n]*\n?/, '').replace(/^\/\*[\s\S]*?\*\//, '');
    if (s === before) return s;
  }
}
