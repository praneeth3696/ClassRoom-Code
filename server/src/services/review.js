import { many, one } from '../db/index.js';
import { badRequest, notFound } from '../lib/http.js';
import { isAdmin, teachesCourse } from './access.js';
import {
  LATEST_REVISION_COLUMNS, LATEST_REVISION_JOIN, revisionCountOf, shapeFeedback, shapeLatestRevision,
} from './revisions.js';

/**
 * Teacher-side review of submissions, and the progress summaries both roles
 * need (SPEC.md §7.4, §8.5).
 */

const SUBMISSION_SELECT = `
  s.id, s.question_id, s.student_id, s.code, s.language, s.status,
  s.auto_passed, s.last_run_result, s.submitted_at, s.updated_at,
  ${LATEST_REVISION_COLUMNS},
  u.name AS student_name, u.email AS student_email,
  f.id AS feedback_id, f.comment, f.marks, f.revision AS feedback_revision,
  f.updated_at AS feedback_updated_at, t.name AS teacher_name`;

const SUBMISSION_JOINS = `
  FROM submissions s
  ${LATEST_REVISION_JOIN}
  JOIN users u ON u.id = s.student_id
  LEFT JOIN feedback f ON f.submission_id = s.id
  LEFT JOIN users t ON t.id = f.teacher_id`;

/**
 * A submission as the teacher reviews it. Once the student has submitted, the
 * code and automated result are those of the latest revision — never the
 * student's later, unsubmitted edits. A student who has only run or saved shows
 * as a draft with their working copy.
 */
function shapeSubmissionRow(row, { includeCode = true } = {}) {
  const graded = shapeLatestRevision(row);
  return {
    id: row.id,
    questionId: row.question_id,
    student: { id: row.student_id, name: row.student_name, email: row.student_email },
    code: includeCode ? (graded ? graded.code : row.code) : undefined,
    language: graded ? graded.language : row.language,
    status: row.status,
    autoPassed: graded ? graded.autoPassed : row.auto_passed,
    lastRunResult: graded ? graded.result : (row.last_run_result ?? null),
    submittedAt: graded?.submittedAt ?? row.submitted_at ?? null,
    updatedAt: row.updated_at,
    revision: graded?.revision ?? null,
    revisionCount: revisionCountOf(row),
    late: graded?.late ?? false,
    hasUnsubmittedChanges: Boolean(graded) && (row.code !== graded.code || row.language !== graded.language),
    feedback: shapeFeedback(row),
  };
}

/** Every submission for one question, for the teacher's review screen. */
export async function listQuestionSubmissions(questionId) {
  const rows = await many(
    `SELECT ${SUBMISSION_SELECT} ${SUBMISSION_JOINS}
     WHERE s.question_id = $1
     ORDER BY u.name`,
    [questionId],
  );
  return rows.map((r) => shapeSubmissionRow(r));
}

/** Students enrolled in the course who have no submission for this question. */
export async function listMissingStudents(questionId) {
  return many(
    `SELECT u.id, u.name, u.email
     FROM questions q
     JOIN worksheets w ON w.id = q.worksheet_id
     JOIN course_enrollments ce ON ce.course_id = w.course_id
     JOIN users u ON u.id = ce.user_id
     WHERE q.id = $1
       AND NOT EXISTS (
         SELECT 1 FROM submissions s WHERE s.question_id = q.id AND s.student_id = u.id
       )
     ORDER BY u.name`,
    [questionId],
  );
}

/**
 * Per-question progress across a worksheet.
 *
 * A teacher sees class-wide counts; a student sees only their own state. The
 * same endpoint serves both so the worksheet page has one thing to call.
 */
export async function worksheetProgress(worksheetId, user) {
  const questions = await many(
    `SELECT q.id, q.position, q.title, q.points,
            (SELECT count(*)::int FROM test_cases tc WHERE tc.question_id = q.id) AS test_case_count
     FROM questions q WHERE q.worksheet_id = $1 ORDER BY q.position, q.created_at`,
    [worksheetId],
  );
  if (questions.length === 0) return { questions: [], enrolledCount: 0 };

  const ids = questions.map((q) => q.id);
  const isTeacher = user.role === 'teacher' || isAdmin(user);

  if (!isTeacher) {
    const mine = await many(
      `SELECT s.question_id, s.status, s.auto_passed, s.updated_at, ${LATEST_REVISION_COLUMNS},
              f.id AS feedback_id, f.comment, f.marks, f.revision AS feedback_revision,
              f.updated_at AS feedback_updated_at, t.name AS teacher_name
       FROM submissions s
       ${LATEST_REVISION_JOIN}
       LEFT JOIN feedback f ON f.submission_id = s.id
       LEFT JOIN users t ON t.id = f.teacher_id
       WHERE s.question_id = ANY($1) AND s.student_id = $2`,
      [ids, user.id],
    );
    const byQuestion = new Map(mine.map((r) => [r.question_id, r]));
    return {
      questions: questions.map((q) => {
        const row = byQuestion.get(q.id);
        return {
          id: q.id,
          position: q.position,
          title: q.title,
          points: q.points === null ? null : Number(q.points),
          testCaseCount: q.test_case_count,
          mine: row
            ? {
                status: row.status,
                autoPassed: row.auto_passed,
                updatedAt: row.updated_at,
                revisionCount: revisionCountOf(row),
                late: Boolean(row.rev_late),
                feedback: shapeFeedback(row),
              }
            : null,
        };
      }),
    };
  }

  const stats = await many(
    `SELECT s.question_id,
            count(*) FILTER (WHERE s.status = 'submitted')::int AS submitted,
            count(*) FILTER (WHERE s.auto_passed IS TRUE)::int AS passed,
            count(*) FILTER (WHERE s.auto_passed IS FALSE)::int AS failed,
            count(f.id)::int AS reviewed
     FROM submissions s
     LEFT JOIN feedback f ON f.submission_id = s.id
     WHERE s.question_id = ANY($1)
     GROUP BY s.question_id`,
    [ids],
  );
  const byQuestion = new Map(stats.map((r) => [r.question_id, r]));

  const enrolled = await one(
    `SELECT count(*)::int AS n
     FROM worksheets w JOIN course_enrollments ce ON ce.course_id = w.course_id
     WHERE w.id = $1`,
    [worksheetId],
  );

  return {
    enrolledCount: enrolled.n,
    questions: questions.map((q) => {
      const row = byQuestion.get(q.id);
      return {
        id: q.id,
        position: q.position,
        title: q.title,
        points: q.points === null ? null : Number(q.points),
        testCaseCount: q.test_case_count,
        stats: {
          submitted: row?.submitted ?? 0,
          passed: row?.passed ?? 0,
          failed: row?.failed ?? 0,
          reviewed: row?.reviewed ?? 0,
        },
      };
    }),
  };
}

/** Resolves a submission to its course, for permission checks. */
export async function loadSubmissionContext(submissionId) {
  const row = await one(
    `SELECT s.id, s.question_id, s.student_id, w.course_id, q.points
     FROM submissions s
     JOIN questions q ON q.id = s.question_id
     JOIN worksheets w ON w.id = q.worksheet_id
     WHERE s.id = $1`,
    [submissionId],
  );
  if (!row) throw notFound('Submission not found');
  return row;
}

/**
 * Saves the teacher's feedback (SPEC.md §6, §9). One feedback row per
 * submission — editing replaces it rather than appending. It records the
 * revision it was written against, so a later resubmission shows as new work.
 */
export async function upsertFeedback({ submissionId, teacherId, comment, marks, maxPoints }) {
  if (marks !== null && marks !== undefined && maxPoints !== null && maxPoints !== undefined) {
    if (Number(marks) > Number(maxPoints)) {
      throw badRequest(`Marks cannot exceed the question's ${maxPoints} points`);
    }
  }
  const row = await one(
    `INSERT INTO feedback (submission_id, teacher_id, comment, marks, revision)
     VALUES ($1, $2, $3, $4, (SELECT max(revision) FROM submission_revisions WHERE submission_id = $1))
     ON CONFLICT (submission_id) DO UPDATE
       SET teacher_id = EXCLUDED.teacher_id,
           comment = EXCLUDED.comment,
           marks = EXCLUDED.marks,
           revision = EXCLUDED.revision,
           updated_at = now()
     RETURNING id, comment, marks, revision, updated_at`,
    [submissionId, teacherId, comment ?? null, marks ?? null],
  );
  return {
    id: row.id,
    comment: row.comment ?? null,
    marks: row.marks === null ? null : Number(row.marks),
    revision: row.revision ?? null,
    outdated: false,
    updatedAt: row.updated_at,
  };
}

export async function deleteFeedback(submissionId) {
  await one('DELETE FROM feedback WHERE submission_id = $1 RETURNING id', [submissionId]);
}

export { teachesCourse };
