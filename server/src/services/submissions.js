import { many, one } from '../db/index.js';
import { badRequest, forbidden, notFound } from '../lib/http.js';
import { autoPassedFrom, runAgainstTestCases } from './execution.js';
import { isEnrolled, loadQuestionContext, submissionWindow } from './access.js';
import { getLanguage, isDatabaseLanguage, kindOfLanguageSet } from '../lib/languages.js';
import { one as queryOne } from '../db/index.js';

function shapeSubmission(row) {
  if (!row) return null;
  return {
    id: row.id,
    questionId: row.question_id,
    studentId: row.student_id,
    code: row.code,
    language: row.language,
    status: row.status,
    autoPassed: row.auto_passed,
    lastRunResult: row.last_run_result ?? null,
    submittedAt: row.submitted_at ?? null,
    updatedAt: row.updated_at,
  };
}

/**
 * The schema and seed data a database question runs against: the worksheet's
 * shared dataset plus any setup belonging to this question alone.
 */
export async function loadDatabaseContext(questionId) {
  const row = await queryOne(
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
  const row = await one(
    `SELECT s.*,
            f.id AS feedback_id, f.comment, f.marks, f.updated_at AS feedback_updated_at,
            t.name AS teacher_name
     FROM submissions s
     LEFT JOIN feedback f ON f.submission_id = s.id
     LEFT JOIN users t ON t.id = f.teacher_id
     WHERE s.question_id = $1 AND s.student_id = $2`,
    [questionId, studentId],
  );
  if (!row) return null;
  return {
    ...shapeSubmission(row),
    feedback: row.feedback_id
      ? {
          comment: row.comment ?? null,
          marks: row.marks === null || row.marks === undefined ? null : Number(row.marks),
          teacherName: row.teacher_name ?? null,
          updatedAt: row.feedback_updated_at,
        }
      : null,
  };
}

/**
 * Runs code against the question's test cases without recording an answer.
 * This is the student's self-check (SPEC.md §8.3) — it is not a grade, but the
 * result is cached on any existing submission so the teacher sees the latest
 * state and the student does not lose it on reload.
 */
export async function runCode({ user, questionId, code, language }) {
  const { context } = await assertStudentMayAttempt(user, questionId, { language });
  const [testCases, dbContext] = await Promise.all([
    loadTestCases(context.question_id),
    loadDatabaseContext(context.question_id),
  ]);
  const result = await runAgainstTestCases({
    code, language, testCases,
    datasetScript: dbContext.datasetScript,
    setupScript: dbContext.setupScript,
    ordered: dbContext.ordered,
  });

  await one(
    `INSERT INTO submissions (question_id, student_id, code, language, status, last_run_result, auto_passed)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6)
     ON CONFLICT (question_id, student_id) DO UPDATE
       SET code = EXCLUDED.code,
           language = EXCLUDED.language,
           last_run_result = EXCLUDED.last_run_result,
           auto_passed = EXCLUDED.auto_passed,
           updated_at = now()
     RETURNING id`,
    [context.question_id, user.id, code, language, JSON.stringify(result), autoPassedFrom(result)],
  );

  return result;
}

/** Saves work in progress without running it or marking it submitted. */
export async function saveDraft({ user, questionId, code, language }) {
  const { context, window } = await assertStudentMayAttempt(user, questionId, { language });
  if (!window.open) throw forbidden(window.reason);

  const row = await one(
    `INSERT INTO submissions (question_id, student_id, code, language, status)
     VALUES ($1, $2, $3, $4, 'draft')
     ON CONFLICT (question_id, student_id) DO UPDATE
       SET code = EXCLUDED.code, language = EXCLUDED.language, updated_at = now()
     RETURNING *`,
    [context.question_id, user.id, code, language],
  );
  return shapeSubmission(row);
}

/**
 * Marks the current code as the student's answer (SPEC.md §8.4).
 *
 * The code is executed as part of submitting, so the recorded automated
 * pass/fail always describes the code that was actually submitted rather than
 * whatever the student last happened to press Run on.
 *
 * A submission stays revisable: re-submitting overwrites it, until the
 * worksheet's deadline closes the window (SPEC.md §14, resolved).
 */
export async function submitAnswer({ user, questionId, code, language }) {
  const { context, window } = await assertStudentMayAttempt(user, questionId, { language });
  if (!window.open) throw forbidden(window.reason);

  const [testCases, dbContext] = await Promise.all([
    loadTestCases(context.question_id),
    loadDatabaseContext(context.question_id),
  ]);
  const result = await runAgainstTestCases({
    code, language, testCases,
    datasetScript: dbContext.datasetScript,
    setupScript: dbContext.setupScript,
    ordered: dbContext.ordered,
  });

  const row = await one(
    `INSERT INTO submissions (question_id, student_id, code, language, status, last_run_result, auto_passed, submitted_at)
     VALUES ($1, $2, $3, $4, 'submitted', $5, $6, now())
     ON CONFLICT (question_id, student_id) DO UPDATE
       SET code = EXCLUDED.code,
           language = EXCLUDED.language,
           status = 'submitted',
           last_run_result = EXCLUDED.last_run_result,
           auto_passed = EXCLUDED.auto_passed,
           submitted_at = now(),
           updated_at = now()
     RETURNING *`,
    [context.question_id, user.id, code, language, JSON.stringify(result), autoPassedFrom(result)],
  );

  return { submission: shapeSubmission(row), result, late: Boolean(window.late) };
}
