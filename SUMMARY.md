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
