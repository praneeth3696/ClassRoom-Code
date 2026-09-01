import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, query, exec, closeDb, describeDb } from './index.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate({ quiet = false } = {}) {
  await getDb();
  await exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    // PGlite's exec() runs a multi-statement script in an implicit transaction.
    await exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${file}');\nCOMMIT;`);
    ran.push(file);
    if (!quiet) console.log(`  applied ${file}`);
  }
  if (!quiet && ran.length === 0) console.log('  no pending migrations');
  return ran;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const info = await describeDb();
  console.log(`migrating (${info.driver}) -> ${info.target}`);
  await migrate();
  await closeDb();
  console.log('done');
}
