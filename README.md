# Classroom Code Platform

A web platform for college coding labs: teachers publish worksheets of coding
questions, students solve them in an in-browser editor and check their work
against visible test cases, and teachers leave feedback on what went wrong.

Requirements live in [SPEC.md](SPEC.md). This README covers running it.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Schema, migrations, DB layer, server skeleton, seeding | done |
| 2 | Google OAuth, sessions, roles | done |
| 3 | Teacher API: courses, worksheets, questions, test cases | done |
| 4 | Judge0 integration: run + submit | done |
| 5 | Student frontend (Monaco editor) | done |
| 6 | Teacher frontend: authoring and review | done |
| 7 | Pilot content, end-to-end verification | done |
| 8 | Department structure, SQL and MongoDB labs | done |
| 9 | Importing a worksheet from a problem sheet | done |

All of the MVP scope in SPEC.md §12 is built and verified, plus the academic
structure and database labs added in Phase 8. [TIMELINE.md](TIMELINE.md) records
what happened in each phase and why.

From §13, **submission history** is built — every Submit is kept as a revision —
and the platform ships as a **container image with a PostgreSQL compose stack**.
Not started: admin/HOD oversight views.

## Running it

Two processes in development — the API and the Vite dev server:

```bash
cd server && npm install && npm run migrate && npm run seed && npm run dev
```

```bash
cd web && npm install && npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` to the server, so the browser
stays on one origin and the session cookie is first-party exactly as it is in
production.

### Signing in as a teacher or a student

There is **one application**, not two. The same URL shows a teacher's view or a
student's view depending on who is signed in (SPEC.md §1). On the sign-in page,
development mode lists the seeded accounts — pick one and you are in.

After loading the department seed (below):

| Role | Account | Sees |
|---|---|---|
| Teacher | `anita.rao@psgtech.ac.in` | Big Data and Modern Databases Lab, co-taught with Prof. Vikram Shah |
| Teacher | `meena.sundaram@psgtech.ac.in` | Software Engineering Lab, same batch, different subject |
| Student | `ss2301@psgtech.ac.in` (Aditya Menon) | Both labs above, as a member of the 2023 batch |
| Student | `ss2302@psgtech.ac.in` (Bhavna Iyer) | The same, for testing two students at once |
| Admin | `hod.amcs@psgtech.ac.in` | Every class in the department |

To see both sides at once, open a second browser window in private mode and sign
in there as the other role.

`GET /api/health` reports the active database driver, migration count, and which
code executor is in use.

### Single-process deployment

For the college server, build the frontend and run only the API — it serves the
built files and hands the SPA shell to any non-`/api` route, so deep links and
refreshes work:

```bash
cd web && npm run build && cd ../server && npm start
```

Everything is then on <http://localhost:4000>. Set `WEB_DIST` to serve the build
from elsewhere.

### Container

The `Dockerfile` builds the frontend and the production server into one image
that runs as an unprivileged user, applies migrations on start-up, and has a
health check. `docker-compose.yml` runs it with PostgreSQL 16:

```bash
POSTGRES_PASSWORD=... JWT_SECRET=... PUBLIC_ORIGIN=https://labs.example.edu \
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... docker compose up -d --build
```

Every setting the production config check requires is marked required in the
compose file, so compose stops and names anything missing instead of the server
refusing to boot. Judge0 is deliberately not part of the stack — it needs a
privileged host and belongs on its own VM — so point `JUDGE0_URL` at it. CI
builds the image and boots it in production mode against PostgreSQL on every
push.

### Verifying a deployment

```bash
cd server && npm run verify
```

`scripts/verify.mjs` walks the whole product against a running server — the
teacher flow (§7), the student flow (§8), all four languages, the grading and
feedback loop (§9), the authorization boundaries, and the deadline rules — and
exits non-zero on any failure. It needs `DEV_LOGIN` enabled, so it is a
staging/development check, not a production one.

### Database

`DATABASE_URL` selects the driver:

- **unset** (default) — [PGlite](https://pglite.dev): PostgreSQL 16 compiled to
  WASM, persisted under `server/.data/pgdata`. No Postgres install, no Docker.
  It is a single-process embedded database, so **stop the server before running
  `npm run seed`** — two processes cannot hold the data directory at once.
- **set** — a real PostgreSQL server via `pg`. Same SQL, same migrations. This
  is the production path (SPEC.md §10).

`npm run reset` wipes the local database; re-run `migrate` and `seed` after it.

### Seeding

`npm run seed` loads `server/seed/demo-course.json`. Point it at any file with
the same shape to load real content:

```bash
npm run seed -- ./seed/real-lab.json
```

Seeding is idempotent — users match on email, courses on name + code,
worksheets on course + title — so re-running updates in place. Questions and
test cases are rewritten from the file each time, which keeps the JSON the
source of truth for seeded worksheets.

### Loading the department

`npm run seed:college` loads `server/seed/psg-amcs.json`: the AMCS department,
its four five-year programmes, their lab and theory subjects, batches, staff,
students, and the Semester V Big Data and Modern Databases lab with its real
worksheets.

```bash
cd server && npm run seed:college
```

The structure it creates:

```
Department   AMCS
  Programme    M.Sc Software Systems  (also Theoretical CS, Data Science, Cyber Security)
    Batch        2023 intake, Section A  -  6 students with roll numbers
      Class        5SSL01 Big Data and Modern Databases Lab   (Dr Anita Rao + Prof Vikram Shah)
      Class        5SSL03 Software Engineering Lab            (Dr Meena Sundaram)
```

Each programme carries 3 lab and 5 theory subjects, and a subject may be taught
by a different teacher for each batch. Copy the file and edit it to load your own
department; keys are validated strictly, so a typo is reported rather than
ignored.

### Loading a single course of pilot content

`server/seed/TEMPLATE.json` is an annotated skeleton to copy. Content files are
validated strictly before anything touches the database, and every problem is
reported at once with the field that caused it:

```
seed/real-lab.json is not valid content:
  worksheets.0.questions.0.allowedLanguages.0: Invalid enum value. Expected 'c' | 'cpp' | 'java' | 'python', received 'rust'
  worksheets.0.questions.1: Unrecognized key(s) in object: 'testcases'
```

Unknown keys are errors rather than being ignored, so a misspelled `testCases`
is caught instead of silently producing a question with no test cases.

Enrolling students who have never signed in is expected: they are created as
placeholder accounts, and their Google account claims the row on first sign-in,
keeping the enrolment and any work attached to it.

## Authentication

Sessions are a signed JWT in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in
production). The role is re-read from the database on every request rather than
trusted from the token, so changing someone's role takes effect immediately
instead of waiting for their session to expire.

| Endpoint | Purpose |
|---|---|
| `GET /api/auth/me` | Current user, or `null` |
| `GET /api/auth/google/start` | Begins the OAuth redirect (`?next=/path` to resume a page) |
| `GET /api/auth/google/callback` | OAuth callback; redirects back to the web app |
| `POST /api/auth/logout` | Clears the session |
| `POST /api/auth/dev-login` | Development only — sign in as a seeded user |
| `GET /api/auth/dev-users` | Development only — roster for the sign-in picker |

### Setting up Google sign-in

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth 2.0 Client ID** of type *Web application*.
2. Add this authorised redirect URI, matching `API_ORIGIN` exactly:
   `http://localhost:4000/api/auth/google/callback`
3. Put the client ID and secret in `server/.env`.
4. Set `ALLOWED_EMAIL_DOMAINS=college.edu` to restrict sign-in, and
   `TEACHER_EMAILS=...` to list who is provisioned as a teacher on first login.

`GET /api/auth/config` (signed in) echoes back the redirect URI the server
expects, which is the usual cause of `redirect_uri_mismatch`.

The OAuth endpoints are read from Google's discovery document at runtime, with
the current published values as a fallback, so this survives Google moving them
(SPEC.md §10 asks that these be confirmed against live documentation).

**Domain restriction** handles both account styles (SPEC.md §14): Workspace
accounts are matched on Google's `hd` claim *or* the email suffix, plain
accounts on the suffix alone. Matching is on the full domain, so
`college.edu.attacker.com` is rejected.

### Development sign-in

Without Google credentials, `POST /api/auth/dev-login` with
`{"email": "..."}` starts a session as any **already-seeded** user — it never
creates accounts. Guarded by `DEV_LOGIN`, which the production config check
refuses to let you enable.

## API

All endpoints require a session except `/api/health` and `/api/meta`.

### Courses

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/courses` | Anyone — teachers see courses they teach, students their enrolments |
| `POST` | `/api/courses` | Teacher — creator is auto-assigned to it |
| `GET` | `/api/courses/:id` | Assigned teacher or enrolled student |
| `PATCH` | `/api/courses/:id` | Assigned teacher |
| `POST` | `/api/courses/:id/teachers` | Assigned teacher — `{ people: [{ email, name? }] }` |
| `DELETE` | `/api/courses/:id/teachers/:userId` | Assigned teacher |
| `POST` | `/api/courses/:id/students` | Assigned teacher — same body shape |
| `DELETE` | `/api/courses/:id/students/:userId` | Assigned teacher |

### Worksheets and questions

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/courses/:id/worksheets` | Students see published only |
| `POST` | `/api/courses/:id/worksheets` | Assigned teacher — questions may be nested |
| `GET` | `/api/worksheets/:id` | Full detail with questions and test cases |
| `PATCH` | `/api/worksheets/:id` | Assigned teacher |
| `POST` | `/api/worksheets/:id/publish` \| `/unpublish` | Assigned teacher |
| `DELETE` | `/api/worksheets/:id` | Assigned teacher — `?force=true` if it has submissions |
| `POST` | `/api/worksheets/:id/questions` | Append a question |
| `POST` | `/api/worksheets/:id/questions/reorder` | `{ questionIds: [...] }`, must be the full set |
| `PATCH` | `/api/questions/:id` | Edit; sending `testCases` replaces them wholesale |
| `DELETE` | `/api/questions/:id` | `?force=true` if it has submissions |

### Submissions and execution

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/questions/:id/submission` | The caller's own submission + whether the window is open |
| `POST` | `/api/questions/:id/run` | Self-check against the visible test cases — not a grade |
| `PUT` | `/api/questions/:id/submission` | Save a draft without running |
| `POST` | `/api/questions/:id/submit` | Submit or re-submit; re-runs, re-grades, and records a new revision |
| `GET` | `/api/submissions/:id/revisions` | Every submitted revision, newest first — the owning student or the course's teachers |

### Review

| Method | Path | Who |
|---|---|---|
| `GET` | `/api/worksheets/:id/progress` | Class-wide counts for teachers; a student's own state |
| `GET` | `/api/questions/:id/submissions` | Assigned teacher — each student's graded revision, identical-answer flags, and who has not submitted |
| `PUT` \| `DELETE` | `/api/submissions/:id/feedback` | Assigned teacher — comment and/or marks, recorded against the current revision |
| `GET` | `/api/worksheets/:id/export.csv` | Assigned teacher — results and marks for every enrolled student |

### Authorization model

Holding the `teacher` role is **not** enough to touch a given course — a teacher
must be *assigned* to it, because courses are co-taught (SPEC.md §5). Assignment
is the unit of permission, not the role.

Requests for a course, worksheet or question the caller has no relationship with
return **404, not 403**, so the API does not confirm what exists to people
outside it. The same applies to a draft worksheet viewed by a student: an
unpublished worksheet is invisible rather than forbidden.

Two destructive operations refuse to run silently. Deleting a worksheet or a
question that has student submissions returns **409** naming how many would be
lost; repeating the call with `?force=true` goes through and reports the count.

## Languages

Two kinds, because they are judged differently.

| Language | Kind | Judged on | Runs via |
|---|---|---|---|
| C, C++, Java, Python | program | printed output vs expected, per test case | Judge0, or a local subprocess in development |
| SQL (SQLite) | database | the rows returned | `node:sqlite`, built into Node |
| SQL (PostgreSQL) | database | the rows returned | PGlite, in-memory per run |
| SQL (Oracle) | database | the rows returned | the department's Oracle server |
| MongoDB Shell | database | the documents returned | real `mongosh` against a real MongoDB |

### Database questions

A database answer runs against a fresh database seeded with the worksheet's
dataset, and the result set is compared with what the teacher expected.

Three things are deliberately ignored when comparing, because none of them is
what a question is testing:

- **Column name case** — Oracle upper-cases unquoted identifiers, PostgreSQL
  lower-cases them.
- **Column order** — MongoDB does not preserve the field order written in a
  `$project`, so a correct pipeline can return `count, language` where the
  teacher wrote `language, count`.
- **Row order**, unless the question ticks *row order matters*. A query without
  `ORDER BY` has no defined row order.

Which columns exist, and every value in them, still count.

**Each run gets its own database**, so nothing one student writes is visible to
another — a student can `CREATE TABLE` freely without colliding with the rest of
the class. This is verified by a test.

### MongoDB

Scripts run through the real `mongosh`, so aggregation pipelines, `$lookup`,
`$unwind`, indexes and validators behave exactly as they do in the lab. Set
`MONGODB_URL` to use the department's server; otherwise a local `mongod` is
started on demand and each run gets a uniquely named database that is dropped
afterwards.

Install it locally with `brew install mongodb-community` (macOS) or your
distribution's package.

### Oracle

Object types, `VARRAY`, nested tables, `REF` and type inheritance are
Oracle-specific and cannot be faithfully emulated, so this engine talks to a
real server:

```bash
npm install oracledb
# then in server/.env
ORACLE_CONNECT_STRING=hostname:1521/ORCLPDB1
ORACLE_USER=...
ORACLE_PASSWORD=...
```

Without it, an Oracle question says Oracle is not connected rather than
pretending to run. PostgreSQL covers composite types and array collections in
the meantime, which is most of the object-relational syllabus short of the
Oracle-only features.

Each run is rolled back afterwards, but **DDL commits implicitly in Oracle**, so
for real use give each student their own schema rather than sharing one login.

## Code execution

Student code runs through **Judge0 CE** (SPEC.md §10). Set `JUDGE0_URL` and the
platform uses it; leave it unset in development and code runs in a local
subprocess instead.

### Running Judge0

Judge0 CE self-hosts with Docker:

```bash
wget https://github.com/judge0/judge0/releases/download/v1.13.1/judge0-v1.13.1.zip
```

Unzip it, set a password in `judge0.conf`, then `docker compose up -d db redis`,
wait ~10s, and `docker compose up -d`. Point `JUDGE0_URL` at
`http://localhost:2358` and check it with:

```bash
curl -s "http://localhost:4000/api/health?deep=true"
```

Language ids are **resolved from the instance's own `/languages` endpoint** and
cached, preferring the newest compiler for each language, because a self-hosted
instance may not carry the same ids as the public one. The ids in
`src/lib/languages.js` are only a fallback for when that call fails.

### The local fallback — development only

With no Judge0 configured, code is compiled and run in a subprocess
(`cc`, `c++`, `javac`/`java`, `python3`). It applies a wall-clock timeout, caps
captured output at 64 KB, and kills the whole process group on timeout — but
**it is not a sandbox**. Student code runs as your user with full access to the
machine. That is exactly the problem Judge0 exists to solve, which is why
`ALLOW_LOCAL_EXECUTION` is refused when `NODE_ENV=production`.

If Judge0 is configured but unreachable, development falls back locally and
flags the result `degraded: true`. Production has no fallback: it returns 503.

### How answers are judged

- **Comparison happens in the app, not in Judge0**, so a submission is judged
  identically whichever executor ran it. Judge0 is trusted for what only it
  knows: compile errors, timeouts, signals, and resource usage.
- Trailing whitespace per line, trailing blank lines, and CRLF vs LF are
  ignored. Whitespace *inside* a line is significant. Failing a correct answer
  over a missing final newline teaches nothing (SPEC.md §9).
- A question passes automatically only if **every** test case passes.
- A question with **no test cases** is executed once with empty input so the
  student sees their output, and records `autoPassed: null` — teacher-graded
  only (SPEC.md §7, §9).
- **Submit re-runs the code being submitted**, so the recorded pass/fail always
  describes the submitted answer rather than whatever was last Run.
- **Every Submit is kept as an immutable revision.** Run and Save Draft change
  only the student's working copy, so experimenting after submitting — even after
  the deadline, when Run is still allowed — never changes the answer being graded.

### Load limits

A whole lab pressing Run at once is the platform's peak load (QUESTIONS.md
measured about 2 GB for 60 simultaneous database runs), so:

- **Execution is queued.** At most `EXECUTION_CONCURRENCY` runs (default 8)
  execute together and the rest wait their turn. A request that finds
  `EXECUTION_QUEUE_LIMIT` already waiting, or waits longer than
  `EXECUTION_QUEUE_TIMEOUT_MS`, gets a 503 the student can retry. `/api/health`
  reports how many are active and waiting.
- **Requests are rate-limited** per signed-in user — 60 runs and 20 submits a
  minute, 30 import operations an hour — and sign-in per IP address. Counting per
  user means a lab behind one college NAT address does not share one allowance.
  Over a limit returns 429 with `Retry-After`. Sign-in limits read the client
  address through one trusted proxy hop, so expose the server only behind that
  proxy.

Both are held in memory, which is exact for the single-process deployment.
Running several instances behind a load balancer would need a shared store.

## Configuration

Copy `server/.env.example` to `server/.env`. Every setting has a working
development default, so an empty file boots. Two development-only escape
hatches (`DEV_LOGIN`, `ALLOW_LOCAL_EXECUTION`) are refused when
`NODE_ENV=production`, alongside checks for the secrets that must be set there.
The server refuses to boot rather than start up insecurely:

```
Error: Invalid production configuration:
  - DATABASE_URL is required in production
  - JWT_SECRET must be set in production
```

Every response carries browser security headers: a Content-Security-Policy that
allows scripts, connections and frames only from this origin — plus the inline
styles and `blob:` workers Monaco needs — along with `nosniff`,
`X-Frame-Options: DENY` and a strict referrer policy. HTTPS upgrades and HSTS
are added only when `NODE_ENV=production`, so a plain-http development server
keeps working. An over-tight policy fails silently in the browser, so a
Playwright test loads the editor under it and fails on any violation.

## Creating an assignment, end to end

This is the flow from a teacher publishing work to a student seeing it.

### 1. Create the class (once per subject, per batch)

Sign in as a teacher, then **New class** on the Classes page. Choose the
programme, the subject, and the batch. Choosing a batch enrols every student in
it immediately, so there is usually no roster to type.

The class gets a six-character **join code** for anyone not on the roll — a
repeating student, a late admission. Students enter it under **Join a class**.
Rotate the code or switch joining off from the class page. Students never see
the code for a class they are already in.

### Shortcut: import the sheet you already hand out

**Import from a sheet** on the class page takes the `.docx` or PDF you give
students and drafts the worksheet from it.

What it does and does not do matters:

- A model reads the sheet and drafts the questions — titles, descriptions,
  references, languages, points, and a dataset when the sheet describes entities
  without giving data.
- **It is never asked what a question's expected output is.** It supplies a
  *reference solution*, and the platform runs that against the real engine. The
  expected output is whatever the solution actually returned.
- A question whose reference solution does not run gets **no test cases at all**
  and is imported as teacher-graded. Nothing is invented, because an unverified
  expected output marks correct students wrong and nobody notices.
- The review screen labels every question **Checked**, **Partly checked**,
  **You grade this**, or **Not checked**, and shows the computed expected output
  next to the solution that produced it. You edit before anything is created.
- The worksheet is always created as a **draft** for you to publish.

Needs `ANTHROPIC_API_KEY` on the server. Without it the page says so and you can
still write worksheets by hand. Drafts are stored, so you can close the tab and
resume from the list of earlier uploads.

Word files convert through HTML rather than markdown, because the markdown
converter escapes punctuation — which corrupts SQL — and drops tables, and the
command references in these labs are mostly tables. PDFs are passed to the model
as-is so their layout survives.

### 2. Write the worksheet

Open the class and choose **New worksheet**. Give it a title, an optional
deadline, and decide whether late submissions are allowed.

**For a database lab**, set the *shared dataset*: pick the engine and paste the
schema and seed data. It runs before every question on the worksheet, on a fresh
database per student per run, and students can read it so they are not guessing
table and field names.

### 3. Add questions

Each question needs a title, a description, and at least one allowed language.

- **Program questions** (C, C++, Java, Python) are judged on printed output. Each
  test case is an input and the expected output.
- **Database questions** (SQLite, PostgreSQL, Oracle, MongoDB) are judged on the
  rows returned. Each check has an expected result, pasted as JSON rows or as a
  pipe-separated table.
  - Leave the *verification query* empty to judge whatever the student's own
    script returns — this covers ordinary "write a query" questions.
  - Fill it in when the student is asked to *create* something: it runs after
    their script, so `SELECT count(*) AS n FROM customer_2;` checks that they
    really made the table and inserted the rows.
  - Tick **row order matters** only when the question is about `ORDER BY` or
    `$sort`. Off by default, because a query without one has no defined order.

A question cannot mix program languages with database engines, because the two
are judged differently. Leave the checks empty for open-ended questions you want
to read yourself — those record no automated verdict and wait for your comment.

### 4. Publish

A worksheet starts as a **draft**, invisible to students. Press **Publish** when
it is ready. Unpublishing hides it again without destroying anything.

### 5. What the student does

The worksheet appears in their class immediately. They open a question, pick a
language, write code, and press **Run** — a self-check against the visible
checks that does not submit. **Submit** records the answer and re-runs it, so
the stored pass/fail always describes what was submitted. They can revise and
re-submit until the deadline. Each submission is kept as a numbered revision; if
they keep editing afterwards, the page says their teacher still sees the last
revision they submitted and offers to restore it.

### 6. Review and feedback

Back in the worksheet, each question shows how many of the class have submitted
and how many are passing. **Review** opens the submissions: the student's code,
the automated result, and a box for a comment and marks. The student sees your
comment on their own question page, next to their result.

The review screen shows which revision you are reading, a **Late** badge, and the
earlier revisions when there are several. A student who resubmits after your
feedback is marked **Resubmitted**, so new work is easy to find. Answers that are
identical to another student's, ignoring whitespace, are marked **Identical** — a
prompt to look closer, not a plagiarism verdict. **Export CSV** on the worksheet
page downloads every enrolled student's results and marks for the department's
marks sheet.

## The frontend

One React application with role-based views (SPEC.md §1) — not two apps. The
same routes render a teacher or student variant from the signed-in role.

| Route | Student sees | Teacher sees |
|---|---|---|
| `/` | Courses they are enrolled in | Courses they teach, and a create action |
| `/courses/:id` | Published worksheets | All worksheets with draft badges, plus the roster |
| `/worksheets/:id` | Questions with their own status | Questions with class-wide progress and review links |
| `/questions/:id` | Editor, Run, Submit, feedback | — |
| `/questions/:id/submissions` | — | Every submission, its result, and a feedback form |
| `/worksheets/:id/edit` | — | Worksheet and question authoring |

**Monaco is bundled, not loaded from a CDN.** `@monaco-editor/react` fetches
Monaco from jsDelivr by default, which would break the editor — the core of the
student experience — on a college network that blocks external CDNs or on an
offline lab machine. It is bundled locally instead, trimmed to the four taught
languages, and code-split so it downloads only when an editor is actually
shown: the main bundle is ~66 KB gzipped, with Monaco a separate ~840 KB chunk.

## Tests

```bash
cd server && npm test                 # 233 unit and integration tests
cd web && npm run lint && npm test    # ESLint, then 16 component and API-client tests
cd web && npm run e2e                 # Playwright in Chromium against the real build
cd server && npm run verify           # 53 end-to-end checks of the MVP flows
cd server && npm run verify:college   # 29 checks of the hierarchy and database labs
```

The two `verify` scripts need a running server with `DEV_LOGIN` enabled, so they
are staging and development checks rather than production ones.
`verify:college` expects the department seed to be loaded.

`npm run e2e` builds the frontend and starts the server itself on a throwaway
database seeded with the demo course. It needs `python3` for the local runner
and Chromium (`npx playwright install chromium`). One server test is skipped
unless `LAB_SHEET_DOCX` points at a real lab sheet. CI runs everything above
except the `verify` scripts on every push and pull request, plus a production
smoke test of the container image.

Each test process gets its own throwaway PGlite database, so files run in
parallel without touching each other or your development data.
