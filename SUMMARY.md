# Classroom Code Platform — Portfolio Readiness Summary

Branch `chore/portfolio-readiness` off `main` @ `a828ed5`. Full audit and rationale in
[IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md).

This was already the strongest repository audited: strict validation, production config guards,
404-not-403 authorization, and 191 passing tests. Changes were deliberately few.

## What changed and why

| Commit | Change | Why |
|---|---|---|
| `fix(auth)` | `next` after Google sign-in must resolve to `WEB_ORIGIN`; re-checked in the callback | **Open redirect**: `/api/auth/google/start?next=//evil.example` sent a freshly signed-in user to an attacker's site (also `/\evil.example`, `/\t/evil.example`) |
| `build(deps)` | `npm audit fix` in `server` (lockfile only) | express 4.22.3 / qs 6.16.0 clear three moderate advisories |
| `ci` | GitHub Actions: server tests and web build | No CI existed |

## Test results

| | Before | After |
|---|---|---|
| Server tests (`npm test`) | 191 passed | **194 passed**, 0 failed |
| Web build (`npm run build`) | succeeds | succeeds |
| `npm audit` (server) | 3 moderate | **0** |

The three new tests cover same-site paths, six off-site forms, and non-string input; the suite
failed against the old code before the fix. CI results are on the pull request.

`npm run verify` / `verify:college` (end-to-end checks against a running server) were not run —
they need a live server with seeded data.

## Deferred — needs your input

1. **Seed data privacy** — `server/seed/psg-amcs.json` and the README use a real institution's
   domain with personal names and roll-number emails. Confirm they are fictional before promoting
   the repo; if not, replace them and consider purging history.
2. **React Router 7** — clears a moderate advisory but is a major upgrade.
3. **Rate limiting and security headers** — especially for code execution and the AI import
   (which spends API credits). Limits depend on lab size behind a shared NAT IP.
4. **LICENSE** — none present.

Details and options for each are in IMPROVEMENT_PLAN.md.

---

# Round 2 — hardening

Branch `improve/classroom-hardening`, stacked on `chore/portfolio-readiness`. Findings and plan are
in the "Round 2" section of IMPROVEMENT_PLAN.md.

## What changed and why

| Commit | Change | Why |
|---|---|---|
| `fix(submissions)`, `feat(web)` | Every Submit is an immutable revision. Run and Save Draft touch only the working copy. Students and teachers see revision numbers, late flags, history, and "resubmitted since feedback" | **Pressing Run after submitting replaced the graded answer** — its code, result and pass/fail — even after the deadline, and the real answer was lost |
| `feat(execution)` | FIFO execution queue: `EXECUTION_CONCURRENCY` (default 8), bounded wait, retryable 503 | A whole lab pressing Run could exhaust memory (~2 GB for 60 runs, measured in QUESTIONS.md) |
| `feat(security)` | Rate limits per user (runs, submits, imports) and per IP (sign-in), 429 with `Retry-After` | Nothing throttled execution or the paid AI import |
| `feat(security)` | Strict CSP and browser security headers, verified against Monaco in Chromium | No security headers were sent; `X-Powered-By` advertised Express |
| `feat(review)` | Flag answers identical apart from whitespace | QUESTIONS.md #4 |
| `feat(review)` | CSV export of a worksheet's results, safe against formula injection | QUESTIONS.md #10 |
| `fix(server)` | Shutdown stops database engines, closes idle connections, forces exit after 10 s | `SIGTERM` leaked the managed `mongod` and could hang |
| `fix(scripts)`, `test` | Relative imports in `verify:solutions`; lab-sheet path read from `LAB_SHEET_DOCX` | Both hard-coded paths into your home directory |
| `test(web)` | ESLint, Vitest, and Playwright (revisions flow and CSP) | The frontend had no tests or lint |
| `build(deps)` | React Router 7.18.3 | Clears the last web advisory |
| `build` | Dockerfile, compose with PostgreSQL, CI production smoke test | Deployment (§13) had no packaging |
| `ci` | Web lint and tests, a Playwright job, a container job | — |

Each fix's test was run against the old code first and failed.

## Test results

| | Round 1 | Round 2 |
|---|---|---|
| Server `npm test` | 194 passed | **232 passed**, 1 skipped (needs `LAB_SHEET_DOCX`) |
| Web lint | none | clean — one accepted warning (`useAuth` exported beside its provider) |
| Web unit tests | none | **16 passed** |
| Playwright in Chromium | none | **2 passed**: the revisions flow, and zero CSP violations with the editor loaded |
| `npm audit`, web | 2 moderate | **0** |

**One unexplained failure.** During one full server run every test in `review.test.js` failed. The
file passed on its own and in the next five full runs, and I did not capture the error, so the cause
is unknown — most likely its `before()` hook timing out under parallel load. If CI ever shows it, the
log will carry the real message.

**Not verified on this machine:** the container image, because Docker is not installed here. The CI
`docker` job builds it and boots it in production mode against PostgreSQL.

## Deferred — needs your input (round 2)

1. **Publish gate on reference solutions** (QUESTIONS.md, Risk A). Questions do not store reference
   solutions, so a gate needs a schema and editor change, plus a decision: block publishing when a
   question has test cases but no verified solution, or only warn.
2. **Admin/HOD oversight views** (§13) — a product design question: what an HOD needs to see.
3. **Running more than one instance.** Rate limits and the execution queue are per process; scaling
   out needs a shared store such as Redis.
4. **Identical-answer detection is deliberately shallow.** Renamed variables defeat it. Real
   plagiarism detection (JPlag, MOSS) is a policy decision as much as a technical one.
5. **Still open from round 1:** seed-data privacy and a LICENSE.
