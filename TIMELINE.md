# Build timeline

A record of what was built in each phase, why the significant decisions were
made, and what went wrong along the way. Requirements live in [SPEC.md](SPEC.md);
this file is the history.

Phases 1–7 delivered the MVP in SPEC.md §12. Phase 8 extended it to the real
department structure and to database labs. Phase 9 added importing a worksheet
from the problem sheet a teacher already hands out.

---

## Phase 1 — Foundation

**Built:** the server skeleton and the data model.

- PostgreSQL schema for all nine entities in SPEC.md §6, with foreign-key
  cascades and `CHECK` constraints — `server/src/db/migrations/001_init.sql`.
- A migration runner tracking applied files in `schema_migrations`.
- An idempotent seeder driven by a JSON file, so content is data rather than code.
- Express app with `/api/health` and `/api/meta`, plus error middleware.
- 6 schema tests covering constraints and cascades.

**The decision that shaped everything after it.** The machine had no PostgreSQL
and no Docker. Rather than make that a prerequisite, the database layer got two
interchangeable drivers behind one interface: `pg` when `DATABASE_URL` is set,
and [PGlite](https://pglite.dev) — PostgreSQL 16 compiled to WASM, stored on
disk — when it is not. Same SQL, same migrations, so the production path in
SPEC.md §10 is unchanged, and local development needs no install. This paid off
again in Phase 8, where PGlite became the engine for object-relational
exercises.

**Open questions resolved** (SPEC.md §14): submissions lock at the worksheet
deadline with a per-worksheet `allow_late_submissions` override; teachers author
test cases by hand; questions may have zero test cases.

---

## Phase 2 — Authentication and roles

**Built:** Google OAuth 2.0, sessions, role middleware, and a development
sign-in.

- `services/google.js` — authorization-code flow, endpoints read from Google's
  discovery document at runtime with the published values as a fallback.
- Full ID-token verification: signature against Google's JWKS, plus issuer,
  audience, expiry and nonce.
- JWT session in an `httpOnly`, `SameSite=Lax` cookie; the role is re-read from
  the database on every request, so a role change takes effect immediately
  rather than waiting out a 7-day session.
- Domain restriction that checks Google's `hd` claim *and* the email suffix, so
  it works whether or not the college uses Workspace.

**Three attacks tested and confirmed rejected:** a token signed with an
attacker's own RSA key, an `alg: none` downgrade, and an HS256 forgery.

**Bug found:** those three were initially rejected with **502**, which was wrong
twice over — a rejected credential is not a bad gateway, and 502s get masked as
"internal server error" and logged as server faults, so forged tokens would have
looked like the server breaking. Changed to 401 with precise reasons, and the
`alg` check moved ahead of the key lookup so a downgrade reports its real cause.

**Design note:** a user seeded from a roster with no `google_sub` is *claimed*
on first Google sign-in by email match, keeping their role and enrolments. This
is what lets a roll-number roster be loaded before anyone has logged in.

---

## Phase 3 — Teacher API

**Built:** courses, roster, worksheets, questions and test cases — 19 endpoints.

- `services/access.js` — course-scoped authorization.
- Full CRUD for worksheets and questions, publish/unpublish, question reordering.
- Enrolling an unknown email provisions a placeholder account for later claiming.

**The authorization rule that matters.** Holding the `teacher` role is not
enough to touch a given course — a teacher must be *assigned* to it, because
courses are co-taught (SPEC.md §5). Assignment is the unit of permission, not
the role. Requests for something the caller has no relationship with return
**404, not 403**, so the API does not confirm what exists to outsiders; the same
applies to a draft worksheet seen by a student.

**Two bugs found, both caught by tests rather than review:**

1. **PGlite returned `rowCount: 0` for every successful DELETE and UPDATE.** It
   reports `rows: []` with the count in `affectedRows`, and the `??` fallback
   never fired because `[]` is not nullish. Every "did this delete anything? →
   404" check was silently broken. Fixed once in the driver with a `rowCountOf`
   normaliser rather than at each call site.
2. **Tests shared one database** — files ran in parallel against single-process
   PGlite *and* against the development database. Each test process now gets its
   own throwaway database under `NODE_ENV=test`.

**Safety:** deleting a worksheet or question that has submissions returns **409**
naming how many would be lost; `?force=true` confirms.

---

## Phase 4 — Code execution

**Built:** Judge0 integration, a local fallback, and the run/submit endpoints.

- `services/judge0.js` — batch submission with polling (not `wait=true`, which
  self-hosted instances disable), base64 payloads, language ids resolved from
  the instance's own `/languages` endpoint.
- `services/localRunner.js` — development-only subprocess executor for C, C++,
  Java and Python, with wall-clock timeouts, output caps and process-group kills.
- `services/execution.js` — executor selection, output comparison, verdicts.

**Judge0 could not be run here** (no Docker), so the client was tested against a
stub speaking the real CE protocol — base64, batch tokens, results settling only
after several polls. That caught the wire-format details: seconds→milliseconds,
`X-Auth-Token`, and preferring the *newest* compiler when an instance lists both
`C (GCC 9.2.0)` and `C (Clang 7.0.1)`.

**Three judgment calls:**

- **Comparison happens in this codebase, not in Judge0.** Judge0 can compare
  against `expected_output` itself, but then verdicts would differ between the
  Judge0 and local paths. Judge0 is trusted only for what it alone knows:
  compile errors, timeouts, signals, memory.
- **Trailing whitespace and the final newline are ignored.** Whitespace inside a
  line still counts. Failing a correct answer over a missing `\n` teaches
  nothing, and SPEC.md §9 is explicitly about understanding mistakes.
- **Submit re-runs the code being submitted**, so the recorded pass/fail always
  describes the submitted answer rather than whatever was last Run.

A question with no test cases records `autoPassed: null`, not `false` — an
open-ended question is not failing, it is awaiting a teacher.

---

## Phase 5 — Student frontend

**Built:** the React application and the student workspace.

- Vite + React, with `/api` proxied so the session cookie stays first-party.
- Monaco editor, worksheet and question views, Run/Submit/Save-draft.
- Test results showing expected vs actual per case, with failures expanded.

**Monaco is bundled, not loaded from a CDN.** `@monaco-editor/react` fetches
Monaco from jsDelivr by default, which would break the editor — the core of the
student experience — on a college network that blocks external CDNs or on an
offline lab machine. It is bundled locally, trimmed to the taught languages, and
code-split so it downloads only when an editor is shown: the main bundle is
~66 KB gzipped, Monaco a separate ~840 KB chunk.

**A false alarm worth recording:** during browser testing the editor appeared to
merge text incorrectly. Checking what the server had actually persisted showed
it matched the editor exactly — the merge was an artefact of automated typing
during a re-render, not an application bug.

---

## Phase 6 — Teacher frontend and feedback

**Built:** the review side, and the backend it needed.

- Backend added first: submission listing, worksheet progress (class-wide for
  teachers, personal for students), and feedback endpoints.
- Worksheet authoring UI: worksheet fields, questions, test cases.
- Submission review: student list, read-only code, automated result, feedback
  form with comment and marks.
- Students see feedback on their own submission, attributed to the teacher.

**Bug found:** an empty feedback body (`{}`) was accepted, because the check
tested `marks !== null` and `undefined !== null` is true. A teacher could mark a
submission "reviewed" while telling the student nothing. Fixed, and tested
against four empty-ish shapes.

---

## Phase 7 — Delivery

**Built:** the things that make it deployable and checkable.

- The API serves the built frontend in production, so this deploys as one
  process on the college server (SPEC.md §11).
- `seed/TEMPLATE.json` for pilot content, with strict validation.
- `npm run verify` — 53 end-to-end checks walking the whole product against a
  running server.

**Bug found:** seed validation only checked the top level, so a teacher writing
`"testcases"` instead of `"testCases"` got a question with *no test cases*,
silently. Every nested object is strict now, so a typo is a named error.

**At the end of this phase the MVP in SPEC.md §12 was complete:** 130 unit tests
and 53 end-to-end checks passing from a clean database.

---

## Phase 8 — Department structure and database labs

Driven by two requirements that arrived with real lab documents: the platform
had to model how the college is actually organised, and it had to run the
languages a CS student actually uses — including SQL and the MongoDB shell.

### The academic hierarchy

`002_academic_structure.sql` adds the structure above a course:

```
Department   AMCS
  Programme    M.Sc Software Systems (5-year integrated), and 3 more
    Batch        the 2023 intake, Section A — the group of students
      Course       one subject taught to one batch — the "class"
```

Subjects live in a catalogue of their own, because the same subject is offered
to a new batch every year, possibly by a different teacher. Each programme
carries 3 lab and 5 theory subjects. A student belongs to a batch and has a roll
number; creating a class for a batch enrols everyone in it.

**Join codes, as in Google Classroom.** A teacher shares a six-character code
and students join themselves. The alphabet excludes ambiguous characters
(`0/O`, `1/I`), so a code read off a projector cannot be mistyped into a
different valid code. Codes can be rotated and joining can be switched off.
Students are never shown the code for a class they are in — that would let them
pull in students from other sections.

### Database questions

A database answer is judged on the rows it returns, not on stdout, so it needed
a second question kind rather than a special case of the first:

- `worksheets.dataset_script` + `dataset_engine` — the schema and seed data
  every question on the worksheet runs against, so twenty queries over one
  dataset do not each repeat it. Students can read it, so they are not guessing
  field names.
- `questions.setup_script` — extra data for one question alone.
- A test case's `input` becomes an optional **verification query** run *after*
  the student's script, which is how "create the table and insert five rows"
  gets checked.
- `questions.ordered_comparison` — off by default, because a query without
  `ORDER BY` has no defined row order.

**Four engines**, all behind one interface:

| Engine | How | Status here |
|---|---|---|
| SQLite | `node:sqlite`, built into Node 24 | works, no install |
| PostgreSQL | PGlite, in-memory per run | works, no install |
| MongoDB | real `mongod` + `mongosh` | works |
| Oracle | `oracledb` against the department server | needs the server |

**MongoDB is not emulated.** Scripts run through the real `mongosh` against a
real server, each run getting its own freshly-named database that is dropped
afterwards. Aggregation pipelines, `$lookup`, `$unwind` and indexes therefore
behave exactly as they do in the lab.

**Oracle cannot be emulated.** Object types, `VARRAY`, nested tables, `REF` and
type inheritance are Oracle-specific. The engine is written and the exercises
are seeded, but the worksheet stays a draft until `ORACLE_CONNECT_STRING` points
at the department's server (SPEC.md §11). Asked to run without it, the platform
says so plainly rather than pretending. PostgreSQL covers the composite-type and
collection parts of the syllabus in the meantime.

### Bugs found in this phase

1. **The SQL splitter swallowed whole PostgreSQL scripts.** It treated any
   `CREATE TYPE` as an Oracle PL/SQL block, so semicolons stopped splitting and
   the entire script became one statement. PostgreSQL's `CREATE TYPE x AS (...)`
   is an ordinary statement that merely starts with the same two words. Rewritten
   to follow SQL\*Plus semantics instead: a lone `/` on its own line runs
   whatever is buffered, everything else splits on semicolons. No guessing at
   block openers.

2. **The result judge compared column order.** Running the real lab queries
   showed two failing where the values were identical and only the column order
   differed — MongoDB does not preserve the field order written in a `$project`,
   so a correct pipeline returns `count, language` where the teacher wrote
   `language, count`. Columns are now matched by name and sorted before
   comparison. Which columns exist and what is in them still counts.

3. **The MongoDB harness printed `2`.** The wrapper overrode `print` to capture a
   student's output, then used `print` itself to emit the result payload — so
   the payload went into the capture array and the shell echoed the array's
   length. The original `print` is now saved before being replaced.

Bugs 1 and 2 were only found because the seeded content is the *real* lab
exercises rather than invented examples.

### Content

`seed/psg-amcs.json` carries the department: 4 programmes, 32 subjects, 4
batches, 15 students, 6 staff and 4 classes. The Big Data and Modern Databases
lab holds the two real worksheets — 15 MongoDB questions and 6 object-relational
questions — with expected outputs computed by running reference solutions
against the real engines, not written by hand.

### Verification

- 157 unit and integration tests (27 new for the database layer).
- `npm run verify` — 53 end-to-end checks of the MVP flows.
- `npm run verify:college` — 29 end-to-end checks of the hierarchy, join codes,
  MongoDB and PostgreSQL judging, per-student isolation, and Oracle reporting
  honestly.

---

## Phase 9 — Importing a worksheet from a problem sheet

Built because of the adoption problem behind everything else: teachers do not
type questions into forms. They hand out a Word document. If the platform cannot
read that document, it does not get used, however good the rest of it is.

### The split that makes this safe

The model drafts **structure**. It never states an expected output.

A model asked "what does this query return?" produces something plausible. When
that is wrong, a student who wrote a *correct* answer is marked wrong and has no
way to argue — and nobody notices until a complaint. That is a worse failure
than any crash, so the pipeline is arranged to make it impossible:

```
.docx / .pdf  ─▶ extract ─▶ model drafts questions + a REFERENCE SOLUTION
                                          │
                            platform RUNS the reference solution
                                          │
                        whatever it actually returned = expected output
                                          │
                              teacher reviews ─▶ worksheet (draft)
```

The consequence is deliberate: **a question whose reference solution does not run
gets no test cases at all.** It is imported as teacher-graded rather than given a
made-up expectation. The review screen labels each question *Checked*, *Partly
checked*, *You grade this*, or *Not checked*, so the teacher can see exactly how
far the draft can be trusted.

### What was built

| Piece | What it does |
|---|---|
| `services/documentText.js` | `.docx` → text, preserving tables; `.pdf` passed through for the model to read natively |
| `services/worksheetDraft.js` | The structured-output schema and the Claude call |
| `services/draftSolver.js` | Runs each reference solution and turns real results into expectations |
| `services/imports.js` | Upload → analyse → edit → apply, with the draft stored so it can be resumed |
| `routes/imports.js` | Six endpoints, teacher-only and course-scoped |
| `pages/ImportWorksheet.jsx` | Upload, extraction preview, per-question review with status badges |

Uses Claude Opus 5 with adaptive thinking and structured outputs, so the response
is constrained to the same shape the seed loader already validates — a draft
needs no translation step to become a worksheet.

### Word documents needed care

mammoth's markdown converter escapes punctuation (`\(`, `\_`, `\-`), which
corrupts the SQL and shell snippets these sheets are full of, and it drops tables
entirely. The Oracle command reference is *mostly* tables, so that would have
lost the document. Conversion goes through HTML instead, with a dedicated pass
that turns each `<tr>` into one pipe-separated line. On the real lab sheets this
recovers 21 table rows with the SQL intact and no escaping.

### Bugs found while building it

1. **Deliberate 5xx messages were being masked.** The error handler replaced any
   `status >= 500` message with "Internal server error" — correct for an
   unexpected 500, wrong for "Worksheet import needs an Anthropic API key" or
   "Code execution is not configured. Set JUDGE0_URL". Those tell an operator
   exactly what to fix and contain nothing internal. `HttpError` now carries an
   `expose` flag; the Judge0 messages from Phase 4 were affected too and are
   fixed by the same change.

2. **Saving an edited draft silently deleted every computed expectation.**
   `validateDraft` used the *model output* schema, which has `testInputs` but no
   `testCases`, so zod stripped the solver's work on the way back in. There are
   now two schemas: what the model is constrained to produce, and what a stored
   draft looks like after solving. The model still cannot supply `testCases` —
   that field only exists on the stored shape.

3. **The review screen could only show a draft created in the same tab**, even
   though drafts are persisted. Teachers can now resume one from a list, rather
   than re-uploading and paying for a second analysis.

### Verified, and what is not

Tested for real: extraction from all three of the department's lab documents,
table preservation, draft validation, the solver computing expectations from
working reference solutions, a broken reference solution being downgraded rather
than faked, upload permissions, editing, applying, and — the point of the whole
feature — **a student's correct answer passing against an expectation that was
computed rather than written**. 34 tests.

**Not tested: the Claude call itself.** No `ANTHROPIC_API_KEY` was available on
this machine. Everything either side of it is exercised, and the missing-key path
is tested (it reports clearly and records the failure on the import rather than
half-failing), but the model's actual output quality on a real lab sheet is
unmeasured. That needs a key and one afternoon with a teacher.

---

## Still open

- **Google OAuth has never completed a real sign-in.** The code is verified
  against Google's live discovery document and JWKS, and forged tokens are
  rejected, but it needs a real client ID and an answer on how the college's
  accounts are set up.
- **Oracle is untested against a real instance**, for want of a server.
- **Acceptance testing** with the scenarios the department wants to run.
- **The worksheet importer has never called the model.** The pipeline around it
  is tested; the draft quality is not. First real run needs an API key.
- **`verify:solutions` is not yet a publish gate.** Making it one would close
  the wrong-expected-output failure for hand-written worksheets too, not just
  imported ones.
- SPEC.md §13 items not started: admin/HOD oversight views, submission
  versioning, deployment onto college infrastructure.
