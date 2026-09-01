import fs from 'node:fs';
import { config } from '../config.js';
import { closeDb, exec } from './index.js';

// Local development helper: wipe the database so `npm run migrate && npm run seed`
// starts from scratch. Refuses to touch a real server unless explicitly forced.
if (config.db.url && process.env.FORCE_RESET !== '1') {
  console.error('DATABASE_URL is set. Re-run with FORCE_RESET=1 to drop the remote schema.');
  process.exit(1);
}

if (config.db.url) {
  await exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await closeDb();
  console.log('remote schema dropped');
} else {
  fs.rmSync(config.db.pgliteDir, { recursive: true, force: true });
  console.log(`removed ${config.db.pgliteDir}`);
}
