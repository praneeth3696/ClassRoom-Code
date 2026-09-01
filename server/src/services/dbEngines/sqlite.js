import { DatabaseSync } from 'node:sqlite';
import { DbExecutionError, isQueryStatement, splitSqlStatements, stripLeadingComments } from './common.js';

/**
 * SQLite, built into Node — no install, no server, and a fresh in-memory
 * database per run, so one student's script can never affect another's.
 */
export const id = 'sqlite';
export const label = 'SQL (SQLite)';

export async function isAvailable() {
  return true;
}

export async function run({ setupScripts = [], script, timeoutMs = 10000 }) {
  const db = new DatabaseSync(':memory:');
  const started = Date.now();
  const resultSets = [];

  const exec = (sql, { collect }) => {
    if (Date.now() - started > timeoutMs) {
      throw new DbExecutionError(`Your script ran longer than ${Math.round(timeoutMs / 1000)}s.`);
    }
    const bare = stripLeadingComments(sql);
    if (!bare) return;
    try {
      if (isQueryStatement(bare)) {
        const rows = db.prepare(bare).all();
        if (collect) {
          const columns = rows.length ? Object.keys(rows[0]) : [];
          resultSets.push({ statement: bare, columns, rows, rowCount: rows.length });
        }
      } else {
        db.exec(bare);
        if (collect) resultSets.push({ statement: bare, columns: [], rows: [], rowCount: 0, message: 'OK' });
      }
    } catch (err) {
      throw new DbExecutionError(err.message, { statement: bare });
    }
  };

  try {
    for (const setup of setupScripts) {
      for (const stmt of splitSqlStatements(setup)) exec(stmt, { collect: false });
    }
    for (const stmt of splitSqlStatements(script)) exec(stmt, { collect: true });
    return { resultSets, timeMs: Date.now() - started };
  } finally {
    db.close();
  }
}
