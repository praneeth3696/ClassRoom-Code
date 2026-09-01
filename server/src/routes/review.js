import { Router } from 'express';
import { z } from 'zod';
import { parseBody, wrap } from '../lib/http.js';
import { requireAuth, requireTeacher } from '../middleware/auth.js';
import { assertCanTeachCourse, assertCanViewWorksheet, loadQuestionContext, loadWorksheetCourse } from '../services/access.js';
import {
  deleteFeedback, listMissingStudents, listQuestionSubmissions,
  loadSubmissionContext, upsertFeedback, worksheetProgress,
} from '../services/review.js';

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
