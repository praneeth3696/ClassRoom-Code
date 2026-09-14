# Classroom Code Platform — Improvement Plan

Audit date: 2026-09-14 · Base: `main` @ `a828ed5` · Branch: `chore/portfolio-readiness`

Ranking: **Impact** High / Medium / Low · **Effort** S (< 1h) / M (half day) / L (days)

## Audit snapshot

This is the most mature of the repositories: clear SPEC/TIMELINE, strict zod validation, production
config assertions, 404-not-403 authorization, and a real test suite.

| Area | State |
|---|---|
| History | 1 commit. gitleaks flags `# JUDGE0_AUTH_TOKEN=` in `.env.example` — an empty placeholder, not a secret |
| Dependencies | Lockfiles present. server `npm audit`: 3 moderate (`qs` via express/body-parser). web: 2 moderate (`react-router` — fix is v7, a major) |
| Tests | 191 server tests, all passing (~13 s). No frontend tests. `web` build succeeds |
| CI/CD | None |

## Findings

### Security
1. **Open redirect after sign-in.** `GET /api/auth/google/start?next=…` accepts any value starting with
   `/`, then the callback does `new URL(next, WEB_ORIGIN)`. `next=//evil.example` (or `/\evil.example`)
   resolves to `https://evil.example/`, so a crafted sign-in link lands a freshly authenticated student
   on an attacker's page — a convincing phishing vector. Verified with Node's `URL`.
2. `qs` moderate advisories via `express@4.22.2`, fixable in range.
3. `react-router-dom@6` moderate advisory; only fixed in v7.
4. No rate limiting on `dev-login` (dev only), code execution, or the AI worksheet import (which spends
   Anthropic credits). No security headers (helmet/CSP).

### Privacy
5. `server/seed/psg-amcs.json` and the README use a real institution's domain (`psgtech.ac.in`) with
   personal names and roll-number-style emails. If any of these are real people, they should not be in
   a public repository.

### Tests / CI
6. No CI workflow. Frontend has no tests (acceptable for now; server covers the rules).

### Repository
7. No LICENSE. Local folder / remote names (`teacherstudentprod`, `teacher_student`) differ from the
   GitHub name `ClassRoom-Code`.

## Plan

| # | Change | Impact | Effort | Decision |
|---|---|---|---|---|
| 1 | Reject protocol-relative / backslash `next` values (+ tests) | High | S | **Implement** |
| 2 | `npm audit fix` in server (non-breaking) | Medium | S | **Implement** |
| 6 | GitHub Actions: server tests + web build | Medium | S | **Implement** |
| 5 | Confirm seed people are fictional | High | S | Deferred |
| 3 | `react-router-dom` 7 | Medium | M | Deferred (major) |
| 4 | Rate limiting and security headers | Medium | M | Deferred |
| 7 | LICENSE | Medium | S | Deferred |

## Deferred — needs your input

- **Seed data (#5).** I cannot tell whether the teachers and students in `psg-amcs.json` are invented.
  If any are real, replace them with fictional names on an example domain before promoting this repo,
  and consider purging them from history.
- **React Router 7 (#3).** A major upgrade. The v6 advisory is moderate. Options: upgrade now (routes
  mostly compatible with future flags), or wait until the frontend has tests.
- **Rate limiting / headers (#4).** `express-rate-limit` on `/api/auth/*`, `/run`, `/submit` and imports;
  `helmet` with a CSP that allows the bundled Monaco workers. Limits are a product decision (lab of 60
  students behind one NAT IP).
- **LICENSE (#7).**
