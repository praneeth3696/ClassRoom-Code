import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real single-process build: the API serving
 * web/dist, a throwaway PGlite database seeded with the demo course, and the
 * local code runner. Run `npm run e2e` (it builds first).
 */

const PORT = Number(process.env.E2E_PORT || 4100);
const origin = `http://127.0.0.1:${PORT}`;
const serverDir = fileURLToPath(new URL('../server', import.meta.url));
const dataDir = path.join(os.tmpdir(), 'classroom-e2e-db');

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: origin,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node -e "require('fs').rmSync(process.env.PGLITE_DIR,{recursive:true,force:true})" && npm run migrate && npm run seed && npm start`,
    cwd: serverDir,
    url: `${origin}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: 'development',
      PORT: String(PORT),
      PGLITE_DIR: dataDir,
      WEB_ORIGIN: origin,
      API_ORIGIN: origin,
      DEV_LOGIN: 'true',
      ALLOW_LOCAL_EXECUTION: 'true',
    },
  },
});
