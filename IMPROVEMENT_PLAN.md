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

---

# Round 2 — deeper hardening (branch `improve/classroom-hardening`)

A second, code-level audit of the server and web app found problems the first pass did not
reach. Ranked the same way.

## New findings

8. **Run and Save Draft rewrite a submitted answer.** The Run upsert overwrote `code`,
   `last_run_result` and `auto_passed` on an already-submitted row, and Save Draft overwrote `code`
   while leaving `status = 'submitted'`. So after submitting, any experiment silently changed what
   the teacher grades — even after the deadline, because Run is allowed then. Only the latest
   revision existed, so the graded answer could not be recovered.
9. **No submission history** (SPEC.md §13) and the late flag was returned but never stored.
10. **`scripts/verify-reference-solutions.mjs` imports from absolute paths on the author's machine**,
    so it cannot run anywhere else.
11. **Shutdown leaks the managed `mongod`.** `SIGTERM` closed the HTTP server but never called
    `shutdownEngines()`, and `server.close()` could hang on keep-alive connections.
12. **No execution concurrency limit.** QUESTIONS.md measured 60 simultaneous runs needing ~2 GB and
    recommended a queue of ~10; nothing bounds it.
13. **No rate limiting** on code execution, submissions, dev sign-in, or the AI import (which spends
    API credits).
14. **No security headers** (clickjacking, MIME sniffing, CSP).
15. **Teachers cannot spot identical submissions** (QUESTIONS.md #4) or **export results** (#10).
16. **The frontend has no tests and neither package is linted.**
17. **`react-router-dom` 6** carries a moderate advisory.
18. **No container image**, although deployment onto college infrastructure is the remaining §13 item.

## Round 2 plan

| # | Change | Impact | Effort | Decision |
|---|---|---|---|---|
| 10 | Relative imports in the verification script | Medium | S | **Implement** |
| 11 | Graceful shutdown stops database engines, with a forced-exit timeout | Medium | S | **Implement** |
| 8, 9 | Submission revisions: Run/Save touch only the working copy; each Submit is an immutable revision with its result and late flag; review shows the graded revision and history | High | L | **Implement** |
| 12 | Bounded execution queue (`EXECUTION_CONCURRENCY`) | High | M | **Implement** |
| 13 | Per-user / per-IP rate limits on execution, submission, sign-in, import | High | M | **Implement** |
| 14 | Security headers with a CSP verified against Monaco in a real browser | Medium | M | **Implement** |
| 15 | Identical-submission flag on the review screen; CSV export of a worksheet's results | Medium | M | **Implement** |
| 16 | ESLint for server and web; Vitest for the web app | Medium | M | **Implement** |
| 17 | React Router 7 | Medium | S | **Implement** (verified by tests, build and a browser smoke test) |
| 18 | Dockerfile + compose (app + PostgreSQL), built in CI | Medium | M | **Implement** |
| — | Publish gate on reference solutions | High | L | Deferred — questions do not store reference solutions yet; needs a schema and editor design decision |
| 5, 7 | Seed-data privacy, LICENSE | — | — | Still yours to decide |
