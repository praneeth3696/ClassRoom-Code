import { many } from '../db/index.js';

/**
 * Submission revisions (SPEC.md §13).
 *
 * A `submissions` row is the student's working copy: what is in their editor
 * and what their last Run returned. Each Submit also writes an immutable row to
 * `submission_revisions`, and the latest of those is the graded answer. Keeping
 * the two apart is what stops a Run or Save after submitting from changing what
 * the teacher reviews.
 */

const numberOrNull = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * Joins the latest revision onto a query over `submissions s`. The window count
 * is evaluated before LIMIT, so it is the total number of revisions.
 */
export const LATEST_REVISION_JOIN = `
  LEFT JOIN LATERAL (
    SELECT r.revision, r.code, r.language, r.result, r.auto_passed, r.late, r.submitted_at,
           count(*) OVER () AS revision_count
    FROM submission_revisions r
    WHERE r.submission_id = s.id
    ORDER BY r.revision DESC
    LIMIT 1
  ) rev ON true`;

export const LATEST_REVISION_COLUMNS = `
  rev.revision AS rev_revision, rev.code AS rev_code, rev.language AS rev_language,
  rev.result AS rev_result, rev.auto_passed AS rev_auto_passed, rev.late AS rev_late,
  rev.submitted_at AS rev_submitted_at, rev.revision_count AS rev_count`;

/** The graded answer, or null when the student has never submitted. */
export function shapeLatestRevision(row) {
  if (!row?.rev_revision) return null;
  return {
    revision: row.rev_revision,
    code: row.rev_code,
    language: row.rev_language,
    autoPassed: row.rev_auto_passed ?? null,
    late: Boolean(row.rev_late),
    submittedAt: row.rev_submitted_at,
    result: row.rev_result ?? null,
  };
}

export function revisionCountOf(row) {
  return Number(row?.rev_count ?? 0);
}

/**
 * Feedback, with the revision it was written against. `outdated` means the
 * student has submitted again since, so the comment may no longer apply.
 * Expects `feedback_*` columns and, for `outdated`, the latest revision columns.
 */
export function shapeFeedback(row) {
  if (!row?.feedback_id) return null;
  const revision = row.feedback_revision ?? null;
  return {
    id: row.feedback_id,
    comment: row.comment ?? null,
    marks: numberOrNull(row.marks),
    teacherName: row.teacher_name ?? null,
    updatedAt: row.feedback_updated_at,
    revision,
    outdated: revision !== null && row.rev_revision != null && Number(row.rev_revision) > Number(revision),
  };
}

/** Every revision of one submission, newest first. */
export async function listRevisions(submissionId) {
  const rows = await many(
    `SELECT revision, code, language, result, auto_passed, late, submitted_at
     FROM submission_revisions
     WHERE submission_id = $1
     ORDER BY revision DESC`,
    [submissionId],
  );
  return rows.map((r) => ({
    revision: r.revision,
    code: r.code,
    language: r.language,
    autoPassed: r.auto_passed ?? null,
    late: r.late,
    submittedAt: r.submitted_at,
    result: r.result ?? null,
  }));
}
