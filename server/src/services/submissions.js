import { many, one, transaction } from '../db/index.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { autoPassedFrom, runAgainstTestCases } from './execution.js';
import { isEnrolled, loadQuestionContext, submissionWindow } from './access.js';
import { getLanguage } from '../lib/languages.js';
import {
  LATEST_REVISION_COLUMNS, LATEST_REVISION_JOIN, revisionCountOf, shapeFeedback, shapeLatestRevision,
} from './revisions.js';

/**
 * The student's view of their own submission.
 *
 * `code`, `language` and `lastRunResult` are the working copy, so the editor
 * restores exactly what they were doing. `submitted` is the graded revision,
 * and `autoPassed` / `submittedAt` describe it once one exists.
 */
function shapeSubmission(row) {
  if (!row) return null;
  const submitted = shapeLatestRevision(row);
  return {
    id: row.id,
    questionId: row.question_id,
    studentId: row.student_id,
    code: row.code,
    language: row.language,
    status: row.status,
    autoPassed: submitted ? submitted.autoPassed : row.auto_passed,
    lastRunResult: row.last_run_result ?? null,
    submittedAt: submitted?.submittedAt ?? row.submitted_at ?? null,
    updatedAt: row.updated_at,
    submitted,
    revisionCount: revisionCountOf(row),
    hasUnsubmittedChanges: Boolean(submitted) && (row.code !== submitted.code || row.language !== submitted.language),
    feedback: shapeFeedback(row),
  };
}

const OWN_SUBMISSION_SELECT = `
  SELECT s.*, ${LATEST_REVISION_COLUMNS},
         f.id AS feedback_id, f.comment, f.marks, f.revision AS feedback_revision,
         f.updated_at AS feedback_updated_at, t.name AS teacher_name
  FROM submissions s
  ${LATEST_REVISION_JOIN}
  LEFT JOIN feedback f ON f.submission_id = s.id
  LEFT JOIN users t ON t.id = f.teacher_id`;

/**
 * The schema and seed data a database question runs against: the worksheet's
 * shared dataset plus any setup belonging to this question alone.
 */
export async function loadDatabaseContext(questionId) {
  const row = await one(
    `SELECT q.kind, q.setup_script, q.ordered_comparison,
            w.dataset_script, w.dataset_engine
     FROM questions q JOIN worksheets w ON w.id = q.worksheet_id
     WHERE q.id = $1`,
    [questionId],
  );
  if (!row) return { kind: 'program', datasetScript: null, setupScript: null, ordered: false };
  return {
    kind: row.kind,
    datasetScript: row.dataset_script ?? null,
    datasetEngine: row.dataset_engine ?? null,
    setupScript: row.setup_script ?? null,
    ordered: row.ordered_comparison,
  };
}

export async function loadTestCases(questionId) {
  return many('SELECT * FROM test_cases WHERE question_id = $1 ORDER BY position, created_at', [questionId]).then(
    (rows) => rows.map((r) => ({ id: r.id, label: r.label, input: r.input, expectedOutput: r.expected_output })),
  );
}

/**
 * Resolves the question and checks the student may work on it: enrolled in the
 * course, worksheet published, language allowed. Returns the question context
 * plus the submission window.
 */
export async function assertStudentMayAttempt(user, questionId, { language } = {}) {
  const context = await loadQuestionContext(questionId);
  if (user.role === 'student' && !(await isEnrolled(user.id, context.course_id))) {
    throw notFound('Question not found');
  }
  if (user.role === 'student' && context.status !== 'published') {
    throw notFound('Question not found');
  }
  if (language !== undefined) {
    if (!getLanguage(language)) throw badRequest(`Unsupported language: ${language}`);
    if (!context.allowed_languages.includes(language)) {
      throw badRequest(
        `This question does not allow ${language}. Allowed: ${context.allowed_languages.join(', ')}.`,
      );
    }
  }
  return { context, window: submissionWindow(context) };
}

/**
 * The student's own submission, including the teacher's feedback once left
 * (SPEC.md §8.5 — the student sees the auto pass/fail and the comment).
 */
export async function getSubmission(questionId, studentId) {
  const row = await one(`${OWN_SUBMISSION_SELECT} WHERE s.question_id = $1 AND s.student_id = $2`, [
    questionId,
    studentId,
  ]);
  return shapeSubmission(row);
}

async function executeAgainstQuestion(questionId, code, language) {
  const [testCases, dbContext] = await Promise.all([
    loadTestCases(questionId),
    loadDatabaseContext(questionId),
  ]);
  return runAgainstTestCases({
    code, language, testCases,
    datasetScript: dbContext.datasetScript,
    setupScript: dbContext.setupScript,
    ordered: dbContext.ordered,
  });
}

/**
 * Runs code against the question's test cases without recording an answer.
 * This is the student's self-check (SPEC.md §8.3) — it is not a grade. The code
 * and result are kept as the working copy so nothing is lost on reload, but an
 * existing submission's graded revision and automated result are never touched.
 */
export async function runCode({ user, questionId, code, language }) {
  const { context } = await assertStudentMayAttempt(user, questionId, { language });
  const result = await executeAgainstQuestion(context.question_id, code, language);

  await one(
    `INSERT INTO submissions (question_id, student_id, code, language, status, last_run_result, auto_passed)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6)
     ON CONFLICT (question_id, student_id) DO UPDATE
       SET code = EXCLUDED.code,
           language = EXCLUDED.language,
           last_run_result = EXCLUDED.last_run_result,
           auto_passed = CASE WHEN submissions.status = 'submitted'
                              THEN submissions.auto_passed ELSE EXCLUDED.auto_passed END,
           updated_at = now()
     RETURNING id`,
    [context.question_id, user.id, code, language, JSON.stringify(result), autoPassedFrom(result)],
  );

  return result;
}

/** Saves work in progress to the working copy without running or submitting it. */
export async function saveDraft({ user, questionId, code, language }) {
  const { context, window } = await assertStudentMayAttempt(user, questionId, { language });
  if (!window.open) throw forbidden(window.reason);

  await one(
    `INSERT INTO submissions (question_id, student_id, code, language, status)
     VALUES ($1, $2, $3, $4, 'draft')
     ON CONFLICT (question_id, student_id) DO UPDATE
       SET code = EXCLUDED.code, language = EXCLUDED.language, updated_at = now()
     RETURNING id`,
    [context.question_id, user.id, code, language],
  );
  return getSubmission(context.question_id, user.id);
}

const UNIQUE_VIOLATION = '23505';

/**
 * Marks the current code as the student's answer (SPEC.md §8.4).
 *
 * The code is executed as part of submitting, so the recorded automated
 * pass/fail always describes the code that was actually submitted rather than
 * whatever the student last happened to press Run on.
 *
 * Every submit is kept as the next revision (SPEC.md §13); the student can keep
 * revising until the worksheet's deadline closes the window (SPEC.md §14).
 */
export async function submitAnswer({ user, questionId, code, language }) {
  const { context, window } = await assertStudentMayAttempt(user, questionId, { language });
  if (!window.open) throw forbidden(window.reason);

  const result = await executeAgainstQuestion(context.question_id, code, language);
  const late = Boolean(window.late);

  // Two submits racing for the same revision number collide on the unique
  // constraint; the loser simply takes the next number.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await transaction(async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO submissions
             (question_id, student_id, code, language, status, last_run_result, auto_passed, submitted_at)
           VALUES ($1, $2, $3, $4, 'submitted', $5, $6, now())
           ON CONFLICT (question_id, student_id) DO UPDATE
             SET code = EXCLUDED.code,
                 language = EXCLUDED.language,
                 status = 'submitted',
                 last_run_result = EXCLUDED.last_run_result,
                 auto_passed = EXCLUDED.auto_passed,
                 submitted_at = now(),
                 updated_at = now()
           RETURNING id`,
          [context.question_id, user.id, code, language, JSON.stringify(result), autoPassedFrom(result)],
        );
        await tx.query(
          `INSERT INTO submission_revisions (submission_id, revision, code, language, result, auto_passed, late)
           SELECT $1, coalesce(max(revision), 0) + 1, $2, $3, $4, $5, $6
           FROM submission_revisions WHERE submission_id = $1`,
          [rows[0].id, code, language, JSON.stringify(result), autoPassedFrom(result), late],
        );
      });
      break;
    } catch (err) {
      if (err?.code !== UNIQUE_VIOLATION || attempt >= 3) throw err;
    }
  }

  return { submission: await getSubmission(context.question_id, user.id), result, late };
}
