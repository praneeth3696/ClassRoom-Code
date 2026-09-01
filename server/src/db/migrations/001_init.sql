-- Core schema for the classroom code platform (SPEC.md §6).
-- Postgres 13+ : gen_random_uuid() is built in, no pgcrypto needed.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub    text UNIQUE,
  email         text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher', 'admin')),
  department    text,
  avatar_url    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE courses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  code          text,
  department    text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  archived      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- A course may be co-taught: many teachers per course (SPEC.md §5).
CREATE TABLE course_teachers (
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, user_id)
);

CREATE TABLE course_enrollments (
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section       text,
  enrolled_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, user_id)
);

CREATE TABLE worksheets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text,
  deadline      timestamptz,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  -- Answers SPEC.md §14 "submission cutoff": submissions stay revisable until
  -- the deadline; after it they lock unless the teacher allows late edits.
  allow_late_submissions boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worksheets_course_idx ON worksheets (course_id, status);

CREATE TABLE questions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worksheet_id      uuid NOT NULL REFERENCES worksheets(id) ON DELETE CASCADE,
  position          integer NOT NULL DEFAULT 0,
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  reference_notes   text,
  allowed_languages text[] NOT NULL DEFAULT '{}',
  starter_code      jsonb NOT NULL DEFAULT '{}'::jsonb,
  points            numeric(6,2),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questions_worksheet_idx ON questions (worksheet_id, position);

-- Every test case is visible to the student (SPEC.md §4) — no hidden flag.
CREATE TABLE test_cases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id   uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position      integer NOT NULL DEFAULT 0,
  label         text,
  input         text NOT NULL DEFAULT '',
  expected_output text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX test_cases_question_idx ON test_cases (question_id, position);

-- One row per (question, student): only the latest revision is kept.
-- Versioning is Phase 2 (SPEC.md §13).
CREATE TABLE submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id     uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code            text NOT NULL DEFAULT '',
  language        text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  last_run_result jsonb,
  auto_passed     boolean,
  submitted_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (question_id, student_id)
);
CREATE INDEX submissions_student_idx ON submissions (student_id, status);

CREATE TABLE feedback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   uuid NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  teacher_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  comment         text,
  marks           numeric(6,2),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
