-- Phase 8: the academic structure a college actually has, and database questions.
--
-- Hierarchy, using the department that supplied the pilot content:
--
--   Department  AMCS (Applied Mathematics and Computational Sciences)
--     Programme   M.Sc Software Systems (5-year integrated), Theoretical CS, ...
--       Batch       the 2023 intake of that programme — the group of students
--         Course      one subject taught to one batch in one semester. This is
--                     the "class" a student joins and a teacher handles.
--
-- A subject exists in the catalogue independently of who teaches it, because
-- the same subject is offered to a new batch every year.

CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  code        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE programmes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id  uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name           text NOT NULL,
  code           text NOT NULL,
  degree         text NOT NULL DEFAULT 'M.Sc',
  duration_years integer NOT NULL DEFAULT 5,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, code)
);

-- A batch is the cohort: "M.Sc Software Systems, 2023 intake, section A".
CREATE TABLE batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id     uuid NOT NULL REFERENCES programmes(id) ON DELETE CASCADE,
  admission_year   integer NOT NULL,
  section          text,
  current_semester integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (programme_id, admission_year, section)
);

CREATE TABLE subjects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id  uuid REFERENCES programmes(id) ON DELETE CASCADE,
  code          text NOT NULL,
  name          text NOT NULL,
  -- Lab subjects carry the worksheets; theory subjects are modelled so the
  -- timetable is complete, and may still hold assignments.
  kind          text NOT NULL DEFAULT 'lab' CHECK (kind IN ('lab', 'theory')),
  semester      integer,
  credits       numeric(4,1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (programme_id, code)
);

-- Courses become subject offerings. The existing name/code/department columns
-- stay as display fields so a course can still be created standalone.
ALTER TABLE courses ADD COLUMN subject_id     uuid REFERENCES subjects(id) ON DELETE SET NULL;
ALTER TABLE courses ADD COLUMN batch_id       uuid REFERENCES batches(id) ON DELETE SET NULL;
ALTER TABLE courses ADD COLUMN academic_year  text;
ALTER TABLE courses ADD COLUMN semester       integer;
-- Google Classroom style: the teacher shares a code and students join with it,
-- instead of the teacher typing out a roster of a hundred emails.
ALTER TABLE courses ADD COLUMN join_code      text UNIQUE;
ALTER TABLE courses ADD COLUMN join_enabled   boolean NOT NULL DEFAULT true;

CREATE INDEX courses_subject_idx ON courses (subject_id);
CREATE INDEX courses_batch_idx ON courses (batch_id);

-- Students belong to a batch and have a roll number.
ALTER TABLE users ADD COLUMN batch_id    uuid REFERENCES batches(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN roll_number text;
CREATE UNIQUE INDEX users_roll_number_idx ON users (lower(roll_number)) WHERE roll_number IS NOT NULL;

-- --- Database questions -----------------------------------------------------
--
-- A database question is judged on the result set a script produces, not on
-- stdout, so it needs a schema to run against and an engine to run on.

ALTER TABLE questions ADD COLUMN kind text NOT NULL DEFAULT 'program'
  CHECK (kind IN ('program', 'database'));
-- Extra setup for this question alone, run after the worksheet's dataset.
ALTER TABLE questions ADD COLUMN setup_script text;
-- When false (the default), rows are compared as a set: a correct query is not
-- marked wrong because the engine returned rows in another order. A teacher
-- asking for ORDER BY turns this on.
ALTER TABLE questions ADD COLUMN ordered_comparison boolean NOT NULL DEFAULT false;

-- The shared schema and seed data for a worksheet, so twenty query questions
-- over one dataset do not each repeat it.
ALTER TABLE worksheets ADD COLUMN dataset_script text;
ALTER TABLE worksheets ADD COLUMN dataset_engine text;

-- For a database question, a test case's `input` holds an optional verification
-- query run after the student's script — which is how "create the table and
-- insert five rows" is checked. Empty means: judge the student's own output.
COMMENT ON COLUMN test_cases.input IS
  'Program questions: stdin. Database questions: an optional verification query run after the student script.';
