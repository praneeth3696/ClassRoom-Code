-- Submission history (SPEC.md §13).
--
-- A `submissions` row is the student's working copy for a question: the code in
-- their editor and the result of their last Run. It used to be the graded answer
-- too, which meant pressing Run or Save after submitting silently replaced what
-- the teacher reviews - even after the deadline.
--
-- Every Submit is now also recorded here as an immutable revision. The latest
-- revision is the graded answer; earlier ones stay readable.

CREATE TABLE submission_revisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  revision       integer NOT NULL CHECK (revision > 0),
  code           text NOT NULL,
  language       text NOT NULL,
  result         jsonb,
  auto_passed    boolean,
  -- Submitted after the deadline while late submissions were allowed.
  late           boolean NOT NULL DEFAULT false,
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, revision)
);

-- Which revision a teacher's feedback was written against, so a resubmission
-- after feedback is visible to both sides.
ALTER TABLE feedback ADD COLUMN revision integer;

-- Existing submitted answers become revision 1. Before this migration the row
-- held the submitted code unless the student had since pressed Run or Save,
-- which cannot be told apart now; the current row is the best record there is.
INSERT INTO submission_revisions (submission_id, revision, code, language, result, auto_passed, late, submitted_at)
SELECT s.id, 1, s.code, s.language, s.last_run_result, s.auto_passed,
       coalesce(w.deadline IS NOT NULL AND s.submitted_at > w.deadline, false),
       coalesce(s.submitted_at, s.updated_at)
FROM submissions s
JOIN questions q ON q.id = s.question_id
JOIN worksheets w ON w.id = q.worksheet_id
WHERE s.status = 'submitted';

UPDATE feedback f SET revision = 1
FROM submissions s
WHERE s.id = f.submission_id AND s.status = 'submitted';
