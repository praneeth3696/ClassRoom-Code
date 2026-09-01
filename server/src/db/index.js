import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Thin database layer with two interchangeable drivers:
 *
 *   - `pg`     — a real PostgreSQL server, used whenever DATABASE_URL is set.
 *   - `pglite` — Postgres compiled to WASM, persisted to disk. Zero-install
 *                default for local development and tests.
 *
 * Both speak the same SQL and the same `$1` placeholder style, so application
 * code never needs to know which one is behind it.
 */

let driver = null;
let ready = null;

/**
 * Normalises PGlite's result shape to `pg`'s `rowCount`.
 *
 * PGlite reports a SELECT's size in `rows` with `affectedRows` left at 0, but a
 * DELETE/UPDATE/INSERT the other way round: `rows` is an empty array and the
 * count lives in `affectedRows`. Reading only one of the two makes every
 * "did this delete anything?" check wrong.
 */
function rowCountOf(res) {
  if (res.rows?.length) return res.rows.length;
  return res.affectedRows ?? 0;
}

async function initPg() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: config.db.url, max: 10 });
  // Timestamps come back as ISO strings rather than local-time Date objects.
  pg.types.setTypeParser(1114, (v) => new Date(`${v}Z`).toISOString());
  pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
  return {
    kind: 'pg',
    async query(text, params = []) {
      const res = await pool.query(text, params);
      return { rows: res.rows, rowCount: res.rowCount };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const wrapped = {
          async query(text, params = []) {
            const res = await client.query(text, params);
            return { rows: res.rows, rowCount: res.rowCount };
          },
        };
        const out = await fn(wrapped);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function initPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  fs.mkdirSync(path.dirname(config.db.pgliteDir), { recursive: true });
  const db = new PGlite(config.db.pgliteDir);
  await db.waitReady;
  return {
    kind: 'pglite',
    async query(text, params = []) {
      const res = await db.query(text, params);
      return { rows: res.rows ?? [], rowCount: rowCountOf(res) };
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async transaction(fn) {
      return db.transaction(async (tx) => {
        const wrapped = {
          async query(text, params = []) {
            const res = await tx.query(text, params);
            return { rows: res.rows ?? [], rowCount: rowCountOf(res) };
          },
        };
        return fn(wrapped);
      });
    },
    async close() {
      await db.close();
    },
  };
}

export async function getDb() {
  if (driver) return driver;
  if (!ready) {
    ready = (config.db.url ? initPg() : initPglite()).then((d) => {
      driver = d;
      return d;
    });
  }
  return ready;
}

export async function query(text, params = []) {
  const db = await getDb();
  return db.query(text, params);
}

/** Returns the first row, or null. */
export async function one(text, params = []) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

/** Returns all rows. */
export async function many(text, params = []) {
  const { rows } = await query(text, params);
  return rows;
}

export async function exec(sql) {
  const db = await getDb();
  return db.exec(sql);
}

export async function transaction(fn) {
  const db = await getDb();
  return db.transaction(fn);
}

export async function closeDb() {
  if (driver) {
    await driver.close();
    driver = null;
    ready = null;
  }
}

export async function describeDb() {
  const db = await getDb();
  return { driver: db.kind, target: config.db.url ? 'postgres-server' : config.db.pgliteDir };
}
