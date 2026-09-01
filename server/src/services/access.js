import { one } from '../db/index.js';
import { forbidden, notFound } from '../lib/http.js';

/**
 * Course-scoped authorization.
 *
 * Having the `teacher` role is not enough to touch a given course — a teacher
 * may only act on courses they are assigned to (SPEC.md §5: courses are
 * co-taught, so assignment is the unit of permission, not the role). Admins are
 * unrestricted (SPEC.md §5, Phase 2 role).
 */

export function isAdmin(user) {
  return user?.role === 'admin';
}

export async function teachesCourse(userId, courseId) {
  const row = await one('SELECT 1 AS ok FROM course_teachers WHERE course_id = $1 AND user_id = $2', [
    courseId,
    userId,
  ]);
  return Boolean(row);
}

export async function isEnrolled(userId, courseId) {
  const row = await one('SELECT 1 AS ok FROM course_enrollments WHERE course_id = $1 AND user_id = $2', [
    courseId,
    userId,
  ]);
  return Boolean(row);
}

async function courseExists(courseId) {
  return Boolean(await one('SELECT 1 AS ok FROM courses WHERE id = $1', [courseId]));
}

/**
 * Asserts the user may teach this course. Throws 404 rather than 403 when the
 * course exists but the user has nothing to do with it, so the API does not
 * confirm the existence of courses to people outside them.
 */
export async function assertCanTeachCourse(user, courseId) {
  if (isAdmin(user)) {
    if (!(await courseExists(courseId))) throw notFound('Course not found');
    return;
  }
  if (user.role !== 'teacher') throw forbidden('This action requires the teacher role');
  if (!(await teachesCourse(user.id, courseId))) {
    throw notFound('Course not found');
  }
}

/** Asserts the user may read this course: any assigned teacher, enrolled student, or admin. */
export async function assertCanViewCourse(user, courseId) {
  if (isAdmin(user)) {
    if (!(await courseExists(courseId))) throw notFound('Course not found');
    return;
  }
  const allowed =
    user.role === 'teacher'
      ? await teachesCourse(user.id, courseId)
      : await isEnrolled(user.id, courseId);
  if (!allowed) throw notFound('Course not found');
}

/** Resolves a worksheet to its course, or 404s. */
export async function loadWorksheetCourse(worksheetId) {
  const row = await one(
    `SELECT w.id, w.course_id, w.status, w.deadline, w.allow_late_submissions, w.title
     FROM worksheets w WHERE w.id = $1`,
    [worksheetId],
  );
  if (!row) throw notFound('Worksheet not found');
  return row;
}

/** Resolves a question to its worksheet and course, or 404s. */
export async function loadQuestionContext(questionId) {
  const row = await one(
    `SELECT q.id AS question_id, q.worksheet_id, w.course_id, w.status, w.deadline,
            w.allow_late_submissions, q.allowed_languages, q.title
     FROM questions q
     JOIN worksheets w ON w.id = q.worksheet_id
     WHERE q.id = $1`,
    [questionId],
  );
  if (!row) throw notFound('Question not found');
  return row;
}

/**
 * A student may only see a worksheet once it is published. An unpublished
 * worksheet is reported as missing rather than forbidden, so a draft the
 * teacher is still writing is invisible.
 */
export async function assertCanViewWorksheet(user, worksheet) {
  if (isAdmin(user)) return;
  if (user.role === 'teacher') {
    if (!(await teachesCourse(user.id, worksheet.course_id))) throw notFound('Worksheet not found');
    return;
  }
  if (!(await isEnrolled(user.id, worksheet.course_id))) throw notFound('Worksheet not found');
  if (worksheet.status !== 'published') throw notFound('Worksheet not found');
}

/**
 * Whether a student may still edit their answer (SPEC.md §14, resolved):
 * revisable until the deadline, then locked unless the teacher allowed late
 * submissions. A worksheet with no deadline never locks.
 */
export function submissionWindow(worksheet, now = new Date()) {
  if (worksheet.status !== 'published') {
    return { open: false, reason: 'This worksheet has not been published yet.' };
  }
  if (!worksheet.deadline) return { open: true, reason: null, late: false };

  const deadline = new Date(worksheet.deadline);
  const past = now > deadline;
  if (!past) return { open: true, reason: null, late: false };
  if (worksheet.allow_late_submissions) return { open: true, reason: null, late: true };
  return {
    open: false,
    late: true,
    reason: `The deadline for this worksheet passed on ${deadline.toISOString()}.`,
  };
}
