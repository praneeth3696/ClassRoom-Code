import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '..');

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function list(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),

  // Public origin of the web client, used for CORS and OAuth redirects.
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:5173',
  apiOrigin: process.env.API_ORIGIN || `http://localhost:${Number(process.env.PORT || 4000)}`,

  db: {
    // When DATABASE_URL is set we talk to a real PostgreSQL server (production).
    // Otherwise we fall back to PGlite: the same Postgres engine compiled to
    // WASM, stored on disk, so local development needs no server install.
    url: process.env.DATABASE_URL || null,
    // PGlite is single-process, so each test process gets its own throwaway
    // database. Without this, test files running in parallel would fight over
    // one data directory and clobber the development database besides.
    pgliteDir:
      process.env.PGLITE_DIR ||
      (process.env.NODE_ENV === 'test'
        ? path.join(os.tmpdir(), 'classroom-test', `${process.pid}-${Date.now()}`)
        : path.join(SERVER_ROOT, '.data', 'pgdata')),
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
    sessionDays: Number(process.env.SESSION_DAYS || 7),
    cookieName: process.env.SESSION_COOKIE || 'classroom_session',
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || null,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
    },
    // Empty list = any domain accepted. Set to e.g. "college.edu" in production.
    allowedEmailDomains: list(process.env.ALLOWED_EMAIL_DOMAINS),
    // Emails that are provisioned as teachers on first login.
    teacherEmails: list(process.env.TEACHER_EMAILS),
    defaultDepartment: process.env.DEFAULT_DEPARTMENT || 'Computer Science',
    // Dev-only password-less login so the app is testable without Google creds.
    devLogin: bool(process.env.DEV_LOGIN, (process.env.NODE_ENV || 'development') !== 'production'),
  },

  ai: {
    // Used by the worksheet importer. When unset the import feature reports
    // itself as unavailable rather than failing halfway through an upload.
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    maxUploadBytes: Number(process.env.IMPORT_MAX_BYTES || 10 * 1024 * 1024),
  },

  mongo: {
    // Points at the department's MongoDB server when set (SPEC.md §11);
    // otherwise a local mongod is started on demand for development.
    url: process.env.MONGODB_URL || null,
  },

  oracle: {
    // The department already runs Oracle on a separate IP (SPEC.md §11).
    connectString: process.env.ORACLE_CONNECT_STRING || null,
    user: process.env.ORACLE_USER || null,
    password: process.env.ORACLE_PASSWORD || null,
  },

  judge0: {
    url: process.env.JUDGE0_URL || null,
    authToken: process.env.JUDGE0_AUTH_TOKEN || null,
    // Falls back to running code in a local subprocess when Judge0 is absent.
    allowLocalFallback: bool(process.env.ALLOW_LOCAL_EXECUTION, (process.env.NODE_ENV || 'development') !== 'production'),
    cpuTimeLimit: Number(process.env.JUDGE0_CPU_LIMIT || 5),
    wallTimeLimit: Number(process.env.JUDGE0_WALL_LIMIT || 10),
    memoryLimitKb: Number(process.env.JUDGE0_MEMORY_KB || 256000),
  },

  execution: {
    // How many Runs/Submits execute at once; the rest queue. Each database run
    // starts its own engine, so this bounds memory during a full lab session.
    concurrency: Number(process.env.EXECUTION_CONCURRENCY || 8),
    maxQueue: Number(process.env.EXECUTION_QUEUE_LIMIT || 200),
    queueTimeoutMs: Number(process.env.EXECUTION_QUEUE_TIMEOUT_MS || 60_000),
  },
};

export function assertProductionConfig() {
  if (config.env !== 'production') return;
  const problems = [];
  if (!config.db.url) problems.push('DATABASE_URL is required in production');
  if (config.auth.jwtSecret.startsWith('dev-only')) problems.push('JWT_SECRET must be set in production');
  if (!config.auth.google.clientId) problems.push('GOOGLE_CLIENT_ID is required in production');
  if (!config.auth.google.clientSecret) problems.push('GOOGLE_CLIENT_SECRET is required in production');
  if (config.auth.devLogin) problems.push('DEV_LOGIN must be disabled in production');
  if (config.judge0.allowLocalFallback) problems.push('ALLOW_LOCAL_EXECUTION must be disabled in production');
  if (problems.length) {
    throw new Error(`Invalid production configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
