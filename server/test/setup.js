import fs from 'node:fs';
import path from 'node:path';
import { config, SERVER_ROOT } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb } from '../src/db/index.js';
import { seedFromFile } from '../src/db/seed.js';

/**
 * Brings up a fresh database for one test process: migrate, then load the demo
 * roster so tests have known users to sign in as. Each process gets its own
 * PGlite directory (see config.js), so files running in parallel stay isolated.
 */
export async function prepareTestDb({ seed = true } = {}) {
  await migrate({ quiet: true });
  if (seed) await seedFromFile(path.join(SERVER_ROOT, 'seed', 'demo-course.json'));
}

export async function teardownTestDb() {
  await closeDb();
  if (config.env === 'test') {
    fs.rmSync(config.db.pgliteDir, { recursive: true, force: true });
  }
}
