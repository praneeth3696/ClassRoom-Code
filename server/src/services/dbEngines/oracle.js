import { config } from '../../config.js';
import { DbExecutionError, isQueryStatement, splitSqlStatements, stripLeadingComments } from './common.js';

/**
 * Oracle Database.
 *
 * The object-relational syllabus — object types, VARRAY, nested tables, REF,
 * type inheritance, member functions — is Oracle-specific and cannot be
 * faithfully emulated on another engine, so this talks to a real server. The
 * department already runs one (SPEC.md §11); point ORACLE_CONNECT_STRING at it.
 *
 * Each run happens in its own transaction and is rolled back afterwards, so
 * students share the schema without seeing each other's data. Objects created
 * with DDL cannot be rolled back in Oracle, so per-student schemas are the
 * right production setup — see the README.
 */
export const id = 'oracle';
export const label = 'SQL (Oracle)';

let driver = null;

async function loadDriver() {
  if (driver) return driver;
  try {
    driver = (await import('oracledb')).default;
  } catch {
    throw new DbExecutionError(
      'Oracle questions need the "oracledb" package installed on the server (npm install oracledb).',
    );
  }
  driver.outFormat = driver.OUT_FORMAT_OBJECT;
  driver.fetchAsString = [driver.CLOB, driver.NUMBER, driver.DATE];
  return driver;
}

export function isConfigured() {
  return Boolean(config.oracle.connectString && config.oracle.user);
}

export async function isAvailable() {
  if (!isConfigured()) return false;
  try {
    await loadDriver();
    return true;
  } catch {
    return false;
  }
}

export async function run({ setupScripts = [], script, timeoutMs = 20000 }) {
  if (!isConfigured()) {
    throw new DbExecutionError(
      'Oracle is not connected on this server. Set ORACLE_CONNECT_STRING, ORACLE_USER and '
      + 'ORACLE_PASSWORD, or set this question to PostgreSQL for the parts that do not need '
      + 'Oracle-specific features.',
    );
  }
  const oracledb = await loadDriver();
  const started = Date.now();
  const resultSets = [];
  let connection;

  try {
    connection = await oracledb.getConnection({
      user: config.oracle.user,
      password: config.oracle.password,
      connectString: config.oracle.connectString,
    });
    connection.callTimeout = timeoutMs;

    const exec = async (sql, { collect }) => {
      const bare = stripLeadingComments(sql).replace(/;\s*$/, '');
      if (!bare) return;
      try {
        const res = await connection.execute(bare, [], { autoCommit: false });
        if (!collect) return;
        if (res.rows) {
          const columns = res.metaData?.map((m) => m.name) ?? [];
          resultSets.push({ statement: bare, columns, rows: res.rows, rowCount: res.rows.length });
        } else {
          resultSets.push({
            statement: bare, columns: [], rows: [], rowCount: res.rowsAffected ?? 0, message: 'OK',
          });
        }
      } catch (err) {
        throw new DbExecutionError(err.message, { statement: bare });
      }
      void isQueryStatement;
    };

    for (const setup of setupScripts) {
      for (const stmt of splitSqlStatements(setup)) await exec(stmt, { collect: false });
    }
    for (const stmt of splitSqlStatements(script)) await exec(stmt, { collect: true });
    return { resultSets, timeMs: Date.now() - started };
  } finally {
    if (connection) {
      // Undo the student's DML. DDL in Oracle commits implicitly, which is why
      // production should give each student their own schema.
      await connection.rollback().catch(() => {});
      await connection.close().catch(() => {});
    }
  }
}
