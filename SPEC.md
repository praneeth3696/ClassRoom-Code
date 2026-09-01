# Classroom Code Platform — Product Specification

**Status:** Draft v1 — requirements gathered from a planning conversation, ready to start Phase 1 build. Last updated August 27, 2026.

## 1. Overview

A web platform that replaces the current manual lab-worksheet workflow (Google Classroom + WhatsApp + Word docs) with a purpose-built tool for coding labs. Teachers create structured worksheets containing coding questions; students solve them in an in-browser code editor, run their code against test cases, and submit; teachers review submissions and leave feedback so students can see and fix their mistakes.

Think of it as Google Classroom's assignment flow crossed with LeetCode's editor and judge, scoped specifically to a college department's lab courses.

**One platform, role-based views** — not two separate apps. A single application shows a different interface depending on whether the logged-in user is a student, a teacher, or (later) an admin/HOD.

## 2. Problem

Lab worksheets are currently distributed informally (Classroom posts, WhatsApp messages) and submitted as Word documents pasting in the question, the student's code, and its output. This is inconsistent and gives students no fast feedback loop — they write code, get some output, and have no way to check it's actually correct until a teacher eventually reviews it.

## 3. Goals

- Structured worksheet creation: a teacher publishes a worksheet (title, deadline, a list of questions) to a specific course.
- In-browser coding environment for students, with immediate self-checking against test cases.
- Feedback-oriented grading: teachers review submissions and leave comments aimed at helping students understand their mistakes, not just assign a score.
- Support multiple faculty per course/lab (labs are often co-taught or split across sections).
- Real pilot content is available: worksheet/question content from an actual lab course can be supplied to test the platform end to end, rather than relying on placeholder data.

## 4. Non-Goals (for now)

- **Not** a replacement for the college's formal, proctored examinations — those go through a separate process. This platform covers lab worksheets/assignments, not invigilated tests.
- No hidden test cases — every test case a question has is visible to the student.
- No plagiarism detection, proctoring, or lockdown-browser features in the initial scope.
- No separate ungraded "practice" mode — every question in the system is a graded assignment (grading here means feedback, not necessarily an official college mark).

## 5. User Roles

| Role | Purpose |
|---|---|
| **Student** | Views assigned worksheets, writes/runs/submits code, sees feedback |
| **Teacher** | Creates worksheets and questions, reviews submissions, leaves feedback |
| **Admin/HOD** *(Phase 2, not MVP-critical)* | Oversight across courses; useful for the bigger picture, not required to launch |

A course/lab can have **multiple teachers** assigned — don't model it as one-teacher-per-course.

## 6. Core Data Model (sketch)

Conceptual, not a schema — settle field types and constraints during implementation.

- **User** — id, name, email, role (student / teacher / admin), department
- **Course** — id, name, department; many-to-many with User via a teacher assignment, and via student enrollment
- **Worksheet** — id, course_id, title, deadline, created_by; has many Questions
- **Question** — id, worksheet_id, description, references, allowed_languages, points (optional); has many TestCases
- **TestCase** — id, question_id, input, expected_output *(no hidden/visible flag needed — all test cases show to students)*
- **Submission** — id, question_id, student_id, code, language, last_run_result, status (draft/submitted), updated_at *(stays editable after "submit" — see Open Questions for the exact cutoff)*
- **Feedback** — submission_id, auto_pass_fail, teacher_comment, marks (optional)

## 7. Teacher Flow

1. Create or select a Course, and assign it one or more teachers.
2. Create a Worksheet under that course: title, deadline, list of Questions.
3. Per Question: description, references, allowed language(s), and test cases (input/expected output) if the question has any — not every question needs them (open-ended or SQL-style questions might not).
4. Once students submit, view submissions per question with the automated pass/fail result, read the code, and leave feedback (comment and/or marks) focused on helping the student see their mistake.

## 8. Student Flow

1. See worksheets assigned to their course, with questions and deadline.
2. Open a question: read the description/references, pick a language, write code in an in-browser editor.
3. **Run** — executes the code against the question's test cases (if any), shows pass/fail and actual output. Self-check only, not a grade.
4. **Submit** — marks the current code as the answer for that question. Not locked: the student can keep revising and re-submitting (see Open Questions for exactly when this should stop).
5. After teacher review, the student sees the auto pass/fail result and the teacher's feedback.

## 9. Grading Model

Hybrid, and feedback-oriented rather than purely score-driven:

- **Automated:** does the submission pass the question's test cases, when it has any?
- **Manual:** the teacher reads the code and output and leaves comments/marks — the point is for the student to understand *why* something's wrong, not just that it is.

Languages at launch: **C, C++, Java, Python.**

DBMS work (SQL, Oracle, MongoDB) doesn't map cleanly onto a stdin/stdout code judge — treat it as a **separate sub-system in Phase 2** (see §11) rather than forcing it into the same test-case model as the other languages.

## 10. Recommended Technical Architecture

Treat as a strong starting point — confirm exact setup steps against current docs when integrating.

**The one architecturally significant decision here is code execution.** Running arbitrary student code safely — sandboxing, timeouts, memory limits, isolating one submission from another — is a real security problem, and not worth building yourself.

- **Code execution: Judge0** (https://judge0.com/ , https://github.com/judge0/judge0) — open-source, MIT-licensed (CE edition), self-hostable via Docker, exposes a REST API, and supports 60+ languages including C, C++, Java, and Python out of the box, sandboxed via Linux isolate/cgroups. Self-hosted CE has no per-execution fees.
  - **Alternative:** Piston (https://github.com/engineer-man/piston) is lighter-weight. Its public hosted instance is rate-limited and not issuing new unlimited API keys — if you go this route, plan to self-host it too.
- **Code editor (frontend): Monaco Editor** (https://microsoft.github.io/monaco-editor/) via the **`@monaco-editor/react`** npm package — actively maintained wrapper that avoids manual webpack configuration. CodeMirror 6 is a lighter alternative if Monaco's bundle size becomes a problem.
- **Frontend: React** — already known; used in past projects (LifeLink, SlotSync).
- **Backend: Node.js + Express** — talks to Judge0's JSON API naturally, and matches the SlotSync stack. Spring Boot would work too — this choice matters far less than the Judge0 decision.
- **Database: PostgreSQL** for the app's own data (users, courses, worksheets, questions, submissions). MySQL works equally well.
- **Auth: Google OAuth 2.0**, restricted to the college's email domain. If the college issues Google Workspace accounts, restrict sign-in to that domain at the OAuth level; otherwise check the email domain suffix after login. Confirm against current Google OAuth documentation.

## 11. Infrastructure Notes

The college already runs a Linux server setup with separate IPs configured for Oracle and MongoDB. Two implications:

- Once there's a working product worth showing, this is a realistic path to real deployment rather than self-hosting indefinitely.
- For the DBMS sub-system (Phase 2), this existing infrastructure is the more realistic target — students connecting to real, pre-configured DB instances with restricted per-assignment credentials — rather than sandboxing a generic SQL executor.

## 12. MVP Scope (Phase 1)

Build this, end to end, before anything else:

- Auth (Google login) + 2 roles: Student, Teacher
- Teacher: create a Course, create a Worksheet with Questions (description, references, deadline, allowed language, optional test cases)
- Student: view assigned worksheets, write code in-browser, Run against test cases, Submit (revisable)
- Judge0 integration for C, C++, Java, Python
- Teacher: view submissions per question, leave a comment + optional marks
- Student: see their own submission status and teacher feedback
- Seed the pilot course with real worksheet content once available, instead of placeholder data

## 13. Phase 2

- Admin/HOD role and cross-course oversight
- DBMS/SQL question type, tied to the college's existing Oracle/MongoDB servers
- Submission history/versioning (only "latest revision" is specified so far)
- Deployment onto college infrastructure

## 14. Open Questions

Genuinely undecided — worth resolving during Phase 1, not before starting:

- **Submission cutoff:** a submission stays editable after "Submit" — does it lock at the worksheet deadline, or stay editable indefinitely? Affects the Submission model in §6.
- **Auth specifics:** Google OAuth is the direction, but domain-restriction mechanics depend on how the college's accounts are actually set up (Google Workspace vs. plain addresses) — confirm before building the login flow.
- **Test-case authoring:** who writes test cases per question — the teacher, by hand, per question? Worth deciding before building the worksheet-creation UI.
- **Product name** — this spec is still functional-only; naming it isn't required to start building.
