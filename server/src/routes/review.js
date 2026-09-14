import { Router } from 'express';
import { z } from 'zod';
import { notFound, parseBody, wrap } from '../lib/http.js';
import { requireAuth, requireTeacher } from '../middleware/auth.js';
import { assertCanTeachCourse, assertCanViewWorksheet, loadQuestionContext, loadWorksheetCourse } from '../services/access.js';
import {
  deleteFeedback, listMissingStudents, listQuestionSubmissions,
  loadSubmissionContext, upsertFeedback, worksheetProgress,
} from '../services/review.js';
import { listRevisions } from '../services/revisions.js';
import { exportWorksheetCsv } from '../services/exports.js';

export const reviewRouter = Router();
export const feedbackRouter = Router();

const uuid = z.string().uuid('Must be a valid id');

const feedbackSchema = z.object({
  comment: z.string().max(20_000).optional().nullable(),
  marks: z.number().min(0).max(1000).optional().nullable(),
}).refine(
  // An empty body must not create a feedback row: that would mark the
  // submission reviewed while telling the student nothing. Checking only
  // `!== null` let `undefined` through, so both are tested explicitly.
  (v) => {
    const hasComment = typeof v.comment === 'string' && v.comment.trim() !== '';
    const hasMarks = typeof v.marks === 'number';
    return hasComment || hasMarks;
  },
  { message: 'Leave a comment, a mark, or both' },
);

/** Progress across a worksheet: class-wide for teachers, personal for students. */
reviewRouter.get(
  '/worksheets/:worksheetId/progress',
  requireAuth,
  wrap(async (req, res) => {
    const worksheet = await loadWorksheetCourse(uuid.parse(req.params.worksheetId));
    await assertCanViewWorksheet(req.user, worksheet);
    res.json(await worksheetProgress(worksheet.id, req.user));
  }),
);

/** A worksheet's results as a CSV attachment, for the department's marks sheet. */
reviewRouter.get(
  '/worksheets/:worksheetId/export.csv',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    const worksheet = await loadWorksheetCourse(uuid.parse(req.params.worksheetId));
    await assertCanTeachCourse(req.user, worksheet.course_id);
    const { filename, csv } = await exportWorksheetCsv(worksheet.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    // Marks are personal data; do not leave copies in shared caches.
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  }),
);

/** Every submission for a question, with who has not submitted (§7.4). */
reviewRouter.get(
  '/questions/:questionId/submissions',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    const context = await loadQuestionContext(uuid.parse(req.params.questionId));
    await assertCanTeachCourse(req.user, context.course_id);
    const [submissions, missing] = await Promise.all([
      listQuestionSubmissions(context.question_id),
      listMissingStudents(context.question_id),
    ]);
    res.json({
      question: {
        id: context.question_id,
        title: context.title,
        worksheetId: context.worksheet_id,
        allowedLanguages: context.allowed_languages,
      },
      submissions,
      notSubmitted: missing,
    });
  }),
);

/** Leave or update feedback on one submission (§7.4, §9). */
feedbackRouter.put(
  '/:submissionId/feedback',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    const context = await loadSubmissionContext(uuid.parse(req.params.submissionId));
    await assertCanTeachCourse(req.user, context.course_id);
    const body = parseBody(feedbackSchema, req.body);
    const feedback = await upsertFeedback({
      submissionId: context.id,
      teacherId: req.user.id,
      comment: body.comment ?? null,
      marks: body.marks ?? null,
      maxPoints: context.points === null ? null : Number(context.points),
    });
    res.json({ feedback });
  }),
);

/**
 * Every submitted revision of a submission (SPEC.md §13), newest first. The
 * student who owns it and the course's teachers may read it; anyone else gets
 * a 404, as elsewhere, so the submission's existence is not confirmed.
 */
feedbackRouter.get(
  '/:submissionId/revisions',
  requireAuth,
  wrap(async (req, res) => {
    const context = await loadSubmissionContext(uuid.parse(req.params.submissionId));
    if (req.user.role === 'student') {
      if (context.student_id !== req.user.id) throw notFound('Submission not found');
    } else {
      await assertCanTeachCourse(req.user, context.course_id);
    }
    res.json({ revisions: await listRevisions(context.id) });
  }),
);

feedbackRouter.delete(
  '/:submissionId/feedback',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    const context = await loadSubmissionContext(uuid.parse(req.params.submissionId));
    await assertCanTeachCourse(req.user, context.course_id);
    await deleteFeedback(context.id);
    res.json({ ok: true });
  }),
);
