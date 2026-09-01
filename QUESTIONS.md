# Questions and answers

Answers to the four questions asked on 30 August 2026, plus the questions those
answers raised in return. Where I checked something rather than recalled it, the
source is linked at the bottom.

Short version of each:

1. **Uploading a problem sheet and getting a worksheet out is worth building** — but the AI must draft the *structure*, never the *expected outputs*. Those have to be computed by running code.
2. **You can demo real Google sign-in today, with no college involvement.** Because this app asks only for name and email, it is exempt from Google's verification, the 100-user cap, and the 7-day expiry.
3. **Reliability is mostly not about crashes.** The failure that would kill this is a worksheet published with a wrong expected output. There is already a script that prevents it; it needs to become a gate.
4. **The bulk loader already exists.** Don't load eight semesters at once — one lab course, one semester, taught by a teacher who will tell you when it is wrong.

---

## 1. Can a teacher upload the problem sheet and have the worksheet built for them?

**Yes, and this is the single highest-value thing you could add.** It removes the
only real adoption barrier: a teacher who will not spend an evening typing
questions into a form.

I can be unusually confident about this because **I already did it by hand.** In
Phase 8 I read your two `.docx` files and produced 21 working questions with a
dataset and expected outputs. So I know exactly which parts an AI does well and
which part it must never be trusted with.

### What the model is genuinely good at

Reading your MongoDB sheet, everything below came straight out of the prose and
would come out of a model just as reliably:

| Field | From your document |
|---|---|
| Question title | "Retrieve all information on the books where the author is 'Danielle Steel'" |
| Description | The surrounding sentence, tidied into an instruction |
| Language / engine | "Mongo DB" in the heading |
| References | The hints already in the sheet |
| Grouping into worksheets | The numbered sections |
| Whether it is auto-gradable | Question 4's "explain your approach" clearly is not |

It is also good at the thing your sheet leaves implicit: your document says
"create the collections USER and BOOK" and describes the fields, but never gives
sample data. A model can invent a plausible library dataset from that
description — which is exactly what I did.

### The part that must not be AI-generated

**Expected outputs.** If a model is asked "what does this query return?", it will
produce something that looks right. Sometimes it will be right. When it is wrong,
a student who wrote a *correct* answer is marked wrong, and they have no way to
argue with it. That single failure would destroy faculty trust faster than any
crash, and it is silent — nobody notices until a student complains.

So the pipeline has to be:

```
  .docx  ──▶  extract text  ──▶  Claude drafts structure  ──▶  teacher reviews
                                                                     │
                                    ┌────────────────────────────────┘
                                    ▼
                       teacher (or AI) writes a reference solution
                                    │
                                    ▼
              PLATFORM RUNS IT against the real engine  ──▶  expected output
                                    │
                                    ▼
                                 publish
```

The expected output is never typed and never guessed. It is **whatever the
reference solution actually returned**, captured from a real run. That is how the
current seed content was built, and it is why the 21 seeded questions grade
correctly today.

This also happens to be the honest pitch to faculty: *"the AI writes the
paperwork, the database decides what is correct, you approve both."*

### What it would take to build

Most of the pieces exist already:

- **The output shape is already defined.** `server/seed/psg-amcs.json` and its
  strict validator are the target format. The model does not need a new contract
  invented for it — it fills in a schema the seeder already enforces.
- **The execution half already exists.** `npm run verify:solutions` runs
  reference solutions against the real engines. Turning its output into the
  expected outputs of a draft worksheet is a small step.
- **`.docx` needs one conversion step.** The Claude API reads PDFs natively but
  not Word files, so `.docx` has to be unzipped and its XML flattened to text
  first (`mammoth` on npm does this; I used a five-line Python equivalent to read
  your files). A teacher uploading a PDF skips even that.

New work: an upload endpoint, one API call with a structured-output schema, and a
review screen where the teacher edits the draft before it becomes a worksheet.

### Cost

Small enough to ignore. Claude Opus 5 is **$5 per million input tokens and $25
per million output**. Your MongoDB sheet is roughly 1,200 words in; a full draft
worksheet with a dataset is maybe 6,000 tokens out. That is **a few rupees per
worksheet**. Even if every teacher in the department re-ran it weekly, the API
bill would be lost in the noise. The Batch API halves it again if you process a
semester's sheets overnight.

### The honest caveat

The first draft will not be perfect. Your sheets contain questions like *"To
enforce uniqueness, set indexes on user.mobile_no"* — where the "answer" is a
schema change, not a query. Those need a human to decide how they should be
graded. Expect the teacher to accept about 70% of a draft untouched and edit the
rest, which is still an enormous saving over typing 15 questions from scratch.

---

## 2. Google sign-in, and the path from prototype to the college running it

This one has a much better answer than I expected before checking.

### You can demo real Google sign-in this week

**This app requests only `openid`, `email`, and `profile`** — name and email
address, nothing else. Google treats those as *non-sensitive*, and apps that ask
only for them are explicitly exempt from the things that normally make an
unpublished OAuth app painful. Per Google's own documentation, such apps:

- do **not** need users on a trusted-tester list,
- do **not** show the "Google hasn't verified this app" warning,
- do **not** have authorizations expire after 7 days,
- do **not** need to go through the verification review.

That means the sequence is simply:

1. Create a Google Cloud project on **your own** account — no college involvement.
2. Create an OAuth 2.0 Client ID (type: *Web application*).
3. Add the redirect URI, matching `API_ORIGIN` exactly.
4. Set the audience to **External** and publish to **In Production**.
5. Put the client ID and secret in `server/.env`, and set
   `ALLOWED_EMAIL_DOMAINS=psgtech.ac.in`.

Now anyone can sign in with Google — but **your server rejects everyone who is
not `@psgtech.ac.in`**. The domain restriction is enforced by this codebase
(checking Google's `hd` claim *and* the email suffix), not by Google, so it works
before the college is involved at all.

For a demo to faculty this is ideal: they sign in with their own real college
Google account and see their own name in the corner. That is far more convincing
than a dropdown of fake users.

> The one error you will hit is `redirect_uri_mismatch`, from the URI in the
> console not matching byte-for-byte. `GET /api/auth/config` prints exactly what
> the server expects — compare the two strings.

### What changes when the college adopts it

Once they give you a domain and a server, the changes are small:

| | Prototype (yours) | College deployment |
|---|---|---|
| Google Cloud project | your personal account | inside the college's Cloud Organization |
| Audience | External + In Production | **Internal** |
| Who can sign in | anyone Google-authenticated, filtered by your code | only `@psgtech.ac.in`, **enforced by Google** |
| Redirect URI | `http://localhost:4000/...` | `https://labs.psgtech.ac.in/api/auth/callback` |
| Who owns the client secret | you | the department |

Switching to **Internal** is the meaningful upgrade: Google itself refuses
non-college accounts, so a leaked class code or a misconfigured env var cannot
let an outsider in. It requires the project to live in the college's Google
Workspace organisation — which is precisely the thing you would be asking them
for anyway.

### How to run the pitch

The order that works:

1. **Show it working first, with their own accounts and their own lab sheet.**
   You already have the real Big Data lab seeded. A faculty member signing in and
   seeing *their* Semester V worksheet is the whole argument.
2. **Ask for exactly two things**, not a vague "support": a subdomain, and a VM
   with Docker. Both are small asks that an IT department can say yes to.
3. **Name what you are not asking for.** You are not asking to touch student
   records, the exam system, or attendance. Scope discipline is what gets a
   student project approved.
4. **Have an answer for "who maintains this when you leave."** See my questions
   below — this will be asked, and "I'll hand it over" is not an answer.

---

## 3. Keeping it running without errors, in a college setting

"No errors" is worth splitting into three very different risks, because they need
different answers and only one of them is really dangerous.

### Risk A — wrong grading (the one that matters)

A crash is embarrassing for an hour. **A worksheet published with a wrong
expected output marks a whole class wrong, and nobody notices.** That is the
failure that would get the platform banned from the department.

Everything that guards against it already exists; it needs to be made compulsory:

- Expected outputs come from **executing** a reference solution, never from
  typing or from an AI's guess.
- `npm run verify:solutions` runs the stored reference solutions against the real
  engines and reports any that no longer pass.
- **Recommended change: make this a publish gate.** A worksheet with auto-graded
  questions should refuse to publish until every question has a reference
  solution that passes. It is a small amount of code and it makes the dangerous
  failure structurally impossible.

Two comparison rules already exist for the same reason — row order and column
order are ignored unless the question explicitly asks for order, because a
correct query that returns rows in another sequence is still correct. Both were
added after real lab queries failed against hand-written expectations.

### Risk B — capacity

I measured this rather than guessing. Each "run" below is one student pressing
Run once; all of them were executed simultaneously:

| Engine | 30 at once | 60 at once | Peak memory |
|---|---|---|---|
| SQL (SQLite) | 0.0 s, all passed | — | negligible |
| SQL (PostgreSQL) | 7.3 s, all passed | **14.7 s, all passed** | ~1.9 GB |
| MongoDB | 7.7 s, all passed | **21.0 s, all passed** | ~0.75 GB |

So **a full class of 60 hitting Run at the same instant all get correct results**,
but the unluckiest student waits ~20 seconds, and the server needs about 2 GB of
headroom. On a college VM slower than this laptop, expect worse.

Two things to do before a real lab session:

- **Add a concurrency limit** (a queue of ~10 simultaneous database runs). This
  bounds memory and makes latency predictable instead of letting 60 WASM
  Postgres instances exist at once.
- **Size the VM at 4 GB RAM minimum**, 8 GB if Judge0 shares it.

### Risk C — the execution sandbox

This is the part with real operational sharp edges, and it is worth knowing
before you promise anything:

- **Judge0 needs `--privileged` Docker and cgroup v1.** Modern Ubuntu (22.04+,
  and certainly 24.04) defaults to **cgroup v2**, and Judge0's sandbox does not
  work on it. The fix is a kernel boot parameter
  (`systemd.unified_cgroup_hierarchy=0`) and a reboot — which is a conversation
  with whoever owns the server, so have it early rather than on demo day.
- **Judge0 has had sandbox-escape advisories.** Combined with `--privileged`, the
  correct posture is: **Judge0 runs on its own VM**, never on the same machine as
  the application database, and never on the same machine as Oracle.
- **`ALLOW_LOCAL_EXECUTION` must stay off in production.** The local runner is
  not a sandbox — it runs student code as the server's own user. The config
  check already refuses to boot with it enabled under `NODE_ENV=production`;
  leave that alone.
- **Oracle DDL commits implicitly**, so a student's `CREATE TABLE` cannot be
  rolled back. For real use each student needs their own Oracle schema, which the
  DBA has to provision. Worth raising with whoever runs the Oracle server before
  you promise Oracle labs.

### Routine operations

- **Backups.** It is PostgreSQL, so a nightly `pg_dump` piped to a second disk is
  enough. What actually matters is `submissions` and `feedback` — the rest can be
  re-seeded from the JSON in git.
- **Monitoring.** `GET /api/health` already reports the database, the executor,
  and which database engines are live; `?deep=true` also pings Judge0. Point any
  uptime checker at it.
- **Deploy as one process.** The API serves the built frontend, so it is a single
  Node process behind nginx — no separate web host to keep in sync.
- **Keep the seed content in git.** Every worksheet is reproducible from a JSON
  file, so a bad edit is a `git revert`, not a database surgery.

---

## 4. Loading every semester's sheets for every class

The machinery is already built. `npm run seed:college` reads one JSON file
describing a whole department — programmes, subjects, batches, students, staff,
classes, worksheets, questions, test cases — and is **idempotent**, so re-running
it updates in place instead of duplicating. Validation is strict: a misspelled
key is a named error rather than a silently missing field.

### How I would organise it

One file per programme per semester, kept in the repository:

```
server/seed/
  psg-amcs.json                 ← department, programmes, subjects, batches, staff
  content/
    ss-sem5-bigdata.json        ← one lab course's worksheets
    ss-sem5-networks.json
    ds-sem5-datamining.json
```

That gives you version history, review before anything reaches students, and a
`git revert` when a sheet is wrong.

### But do not load everything at once

Four programmes × 8 semesters × 3 labs is around **96 lab courses**. Loading them
all before anyone has used the platform means 96 chances to be subtly wrong, with
no one checking.

Do this instead:

1. **One course, this semester** — Big Data and Modern Databases, which is
   already seeded and already correct.
2. Run it with one real class for one lab session. Fix what that exposes.
3. Then the other two labs of that semester.
4. Then widen, once a teacher other than you has authored a worksheet
   successfully.

The bottleneck will not be loading content. It will be that every question needs a
correct expected output, and that requires running a reference solution for each
one. That is the work — and it is exactly what question 1's AI pipeline is for.

---

## My questions back to you

These are the ones where I would build something different depending on the
answer. The first three are the ones I would want answered before writing more
code.

### Blocking — these change the design

**1. Is this the system of record for marks, or a practice tool?**
Everything downstream depends on it. If a teacher's marks here become the
student's actual internal assessment score, then you need retention rules, an
audit trail, an export to whatever the college uses now, and a much more careful
story about disputes. If it is practice with feedback, none of that matters. The
spec currently says "grading here means feedback, not necessarily an official
college mark" — is that still true?

**2. All test cases are visible to students. Is that still right for assessments?**
It is a deliberate decision in the spec (§4), and it is right for practice — a
student can see exactly why they failed. But you now describe this as being for
"lab assessments". If this is used for a graded lab test, visible test cases mean
a student can hard-code the expected outputs. Do you need hidden tests for
assessment worksheets? That is a real change and it contradicts the current spec,
so it needs a decision rather than an assumption.

**3. Who runs this after you graduate?**
Faculty will ask, and it decides how much you should build. A platform only you
can operate is a prototype no matter how good it is. Options worth thinking about:
another junior maintains it, the department's IT staff run it as a service, or it
is deliberately simple enough to be handed over with a README. The third is
achievable and is roughly what the current documentation is aiming at.

### Worth deciding soon

**4. Plagiarism.** The spec excludes it, and I agree for now. But the first time
two students submit identical code, a teacher will ask. Even a "these two
submissions are identical" flag on the review screen would be cheap and would
prevent the question becoming "why doesn't your system catch this?"

**5. Network reach.** Does this need to work from hostels and homes, or only from
inside the campus network? It changes whether you need a public certificate and
DNS, or just an internal address — and it changes what students can do the night
before a deadline.

**6. Oracle, seriously.** The Oracle worksheet is written and waiting, but needs
a connection and per-student schemas. Is the Oracle server something you can
realistically get credentials for this semester? If not, the PostgreSQL
object-relational worksheet covers most of the syllabus and I would put Oracle
aside rather than leave a broken-looking draft in the class.

**7. Lab timing.** Are labs fixed 2-hour slots where a whole batch works at once?
That is the concurrency spike I measured against. If instead students work
whenever they like, the load profile is far gentler and the concurrency limiter
matters less.

### Smaller, but ask before it bites

**8. What do lab machines run?** Monaco needs a reasonably modern browser. If lab
PCs run something locked-down or old, that is worth discovering now rather than
during a demo.

**9. How long must submissions be kept?** A semester? Until results are
published? Some colleges require a year. It is a one-line retention policy but it
should be a decision, not an accident.

**10. Does anything need to leave this system?** Attendance, marks upload, a
report for the HOD. If the answer is "the HOD wants a PDF of who passed what",
that is a small feature — but only if you know about it before you are asked for
it the day before a review.

---

## Sources

Checked while writing this, rather than recalled:

- [Manage app audience — Google Cloud Console Help](https://support.google.com/cloud/answer/15549945?hl=en) — Internal vs External, Testing vs In Production, the 100 test-user cap, and the exemption for apps requesting only name/email/profile
- [OAuth consent screen and app verification — Google Cloud Help](https://support.google.com/cloud/answer/13463073) — when verification is required (sensitive/restricted scopes only)
- [Google OAuth 100 user limit](https://www.unipile.com/google-oauth-100-user-limit/) and [Google OAuth refresh token expiry](https://www.unipile.com/google-oauth-refresh-token/) — the 7-day refresh-token behaviour in Testing status
- [Self-hosting Judge0 — step-by-step guide](https://tutorialsdojo.com/self-hosting-judge0-a-step-by-step-guide-using-aws-ec2-lambda-and-s3/) and [Judge0 issue #583](https://github.com/judge0/judge0/issues/583) — the cgroup v1 requirement and where it breaks
- [Judge0 security advisory GHSA-q7vg-26pg-v5hr](https://github.com/judge0/judge0/security/advisories/GHSA-q7vg-26pg-v5hr) — sandbox escape through unsafe default configuration

Model pricing is from the Claude API reference bundled with this toolchain
(cached 24 June 2026): Claude Opus 5 at $5 / $25 per million input / output
tokens.

The concurrency figures in section 3 were measured on this machine on 30 August
2026 with `Promise.allSettled` bursts against the real engines — not estimated.
