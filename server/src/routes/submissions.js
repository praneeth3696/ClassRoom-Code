import { Router } from 'express';
import { z } from 'zod';
import { parseBody, wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { LANGUAGE_IDS } from '../lib/languages.js';
import { assertStudentMayAttempt, getSubmission, loadTestCases, runCode, saveDraft, submitAnswer } from '../services/submissions.js';
import { one } from '../db/index.js';

export const submissionsRouter = Router();

const uuid = z.string().uuid('Must be a valid id');

const codeSchema = z.object({
  code: z.string().max(200_000, 'That is too much code'),
  language: z.enum(LANGUAGE_IDS),
});

submissionsRouter.use(requireAuth);

/**
 * Everything the question workspace needs in one call: the question text and
 * its visible test cases, the caller's own submission, and whether the
 * submission window is open.
 */
submissionsRouter.get(
  '/:questionId',
  wrap(async (req, res) => {
    const questionId = uuid.parse(req.params.questionId);
    const { context, window } = await assertStudentMayAttempt(req.user, questionId);
    const question = await one(
      `SELECT q.id, q.worksheet_id, q.position, q.title, q.description, q.reference_notes,
              q.allowed_languages, q.points, q.kind, q.setup_script, q.ordered_comparison,
              w.title AS worksheet_title, w.course_id, w.deadline,
              w.dataset_script, w.dataset_engine
       FROM questions q JOIN worksheets w ON w.id = q.worksheet_id
       WHERE q.id = $1`,
      [context.question_id],
    );
    const testCases = await loadTestCases(context.question_id);
    res.json({
      question: {
        id: question.id,
        worksheetId: question.worksheet_id,
        worksheetTitle: question.worksheet_title,
        courseId: question.course_id,
        deadline: question.deadline,
        position: question.position,
        title: question.title,
        description: question.description,
        referenceNotes: question.reference_notes,
        allowedLanguages: question.allowed_languages,
        points: question.points === null ? null : Number(question.points),
        kind: question.kind,
        // Database questions show the schema and seed data they run against, so
        // a student can see the table and field names without guessing.
        datasetScript: question.kind === 'database' ? (question.dataset_script ?? null) : null,
        datasetEngine: question.dataset_engine ?? null,
        setupScript: question.kind === 'database' ? (question.setup_script ?? null) : null,
        orderedComparison: question.ordered_comparison,
        testCases,
      },
      submission: await getSubmission(context.question_id, req.user.id),
      submissionOpen: window.open,
      submissionClosedReason: window.reason,
    });
  }),
);

/** The caller's own submission for a question, with the live submission window. */
submissionsRouter.get(
  '/:questionId/submission',
  wrap(async (req, res) => {
    const questionId = uuid.parse(req.params.questionId);
    const { context, window } = await assertStudentMayAttempt(req.user, questionId);
    res.json({
      submission: await getSubmission(context.question_id, req.user.id),
      submissionOpen: window.open,
      submissionClosedReason: window.reason,
      allowedLanguages: context.allowed_languages,
    });
  }),
);

/** Self-check: run against the visible test cases without submitting (§8.3). */
submissionsRouter.post(
  '/:questionId/run',
  wrap(async (req, res) => {
    const questionId = uuid.parse(req.params.questionId);
    const { code, language } = parseBody(codeSchema, req.body);
    const result = await runCode({ user: req.user, questionId, code, language });
    res.json({ result });
  }),
);

/** Save without submitting, so work in progress survives a reload. */
submissionsRouter.put(
  '/:questionId/submission',
  wrap(async (req, res) => {
    const questionId = uuid.parse(req.params.questionId);
    const { code, language } = parseBody(codeSchema, req.body);
    res.json({ submission: await saveDraft({ user: req.user, questionId, code, language }) });
  }),
);

/** Submit, or re-submit a revision (§8.4). */
submissionsRouter.post(
  '/:questionId/submit',
  wrap(async (req, res) => {
    const questionId = uuid.parse(req.params.questionId);
    const { code, language } = parseBody(codeSchema, req.body);
    const out = await submitAnswer({ user: req.user, questionId, code, language });
    res.json(out);
  }),
);
