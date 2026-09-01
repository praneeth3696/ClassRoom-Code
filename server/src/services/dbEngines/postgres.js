import { DbExecutionError, isQueryStatement, splitSqlStatements, stripLeadingComments } from './common.js';

/**
 * PostgreSQL through PGlite — the same engine the platform stores its own data
 * in, but a throwaway in-memory instance per run.
 *
 * Postgres supports composite types, arrays and table inheritance, so it covers
 * a good part of the object-relational syllabus when the department's Oracle
 * server is not reachable. It is not Oracle: VARRAY, nested tables and REF are
 * Oracle-specific, and those exercises need the `oracle` engine.
 */
export const id = 'postgres';
export const label = 'SQL (PostgreSQL)';

export async function isAvailable() {
  return true;
}

export async function run({ setupScripts = [], script, timeoutMs = 15000 }) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(); // in-memory, discarded when closed
  await db.waitReady;
  const started = Date.now();
  const resultSets = [];

  const exec = async (sql, { collect }) => {
    if (Date.now() - started > timeoutMs) {
      throw new DbExecutionError(`Your script ran longer than ${Math.round(timeoutMs / 1000)}s.`);
    }
    const bare = stripLeadingComments(sql);
    if (!bare) return;
    try {
      const res = await db.query(bare);
      if (!collect) return;
      const rows = res.rows ?? [];
      if (isQueryStatement(bare) || rows.length) {
        const columns = res.fields?.map((f) => f.name) ?? (rows.length ? Object.keys(rows[0]) : []);
        resultSets.push({ statement: bare, columns, rows, rowCount: rows.length });
      } else {
        resultSets.push({
          statement: bare, columns: [], rows: [], rowCount: res.affectedRows ?? 0, message: 'OK',
        });
      }
    } catch (err) {
      throw new DbExecutionError(err.message, { statement: bare });
    }
  };

  try {
    for (const setup of setupScripts) {
      for (const stmt of splitSqlStatements(setup)) await exec(stmt, { collect: false });
    }
    for (const stmt of splitSqlStatements(script)) await exec(stmt, { collect: true });
    return { resultSets, timeMs: Date.now() - started };
  } finally {
    await db.close().catch(() => {});
  }
}
