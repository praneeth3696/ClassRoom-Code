import { Router } from 'express';
import { z } from 'zod';
import { parseBody, wrap } from '../lib/http.js';
import { requireAuth, requireTeacher } from '../middleware/auth.js';
import {
  assertCanTeachCourse, assertCanViewWorksheet, loadQuestionContext, loadWorksheetCourse,
} from '../services/access.js';
import {
  addQuestion, deleteQuestion, deleteWorksheet, getWorksheetDetail,
  reorderQuestions, setWorksheetStatus, updateQuestion, updateWorksheet,
} from '../services/worksheets.js';
import { questionInputSchema, questionUpdateSchema, reorderSchema, worksheetUpdateSchema } from './schemas.js';

export const worksheetsRouter = Router();
export const questionsRouter = Router();

const uuid = z.string().uuid('Must be a valid id');
const forced = (req) => req.query.force === 'true';

worksheetsRouter.use(requireAuth);
questionsRouter.use(requireAuth);

worksheetsRouter.get(
  '/:worksheetId',
  wrap(async (req, res) => {
    const worksheet = await loadWorksheetCourse(uuid.parse(req.params.worksheetId));
    await assertCanViewWorksheet(req.user, worksheet);
    res.json({ worksheet: await getWorksheetDetail(worksheet.id, req.user) });
  }),
);

/** Loads a worksheet and asserts the caller teaches its course. */
async function editableWorksheet(req) {
  const worksheet = await loadWorksheetCourse(uuid.parse(req.params.worksheetId));
  await assertCanTeachCourse(req.user, worksheet.course_id);
  return worksheet;
}

worksheetsRouter.patch(
  '/:worksheetId',
  requireTeacher,
  wrap(async (req, res) => {
    const worksheet = await editableWorksheet(req);
    await updateWorksheet(worksheet.id, parseBody(worksheetUpdateSchema, req.body));
    res.json({ worksheet: await getWorksheetDetail(worksheet.id, req.user) });
  }),
);

worksheetsRouter.post(
  '/:worksheetId/publish',
  requireTeacher,
  wrap(async (req, res) => {
    const worksheet = await editableWorksheet(req);
    await setWorksheetStatus(worksheet.id, 'published');
    res.json({ worksheet: await getWorksheetDetail(worksheet.id, req.user) });
  }),
);

worksheetsRouter.post(
  '/:worksheetId/unpublish',
  requireTeacher,
  wrap(async (req, res) => {
    const worksheet = await editableWorksheet(req);
    await setWorksheetStatus(worksheet.id, 'draft');
    res.json({ worksheet: await getWorksheetDetail(worksheet.id, req.user) });
  }),
);

worksheetsRouter.delete(
  '/:worksheetId',
  requireTeacher,
  wrap(async (req, res) => {
    const worksheet = await editableWorksheet(req);
    const result = await deleteWorksheet(worksheet.id, { force: forced(req) });
    res.json({ ok: true, ...result });
  }),
);

worksheetsRouter.post(
  '/:worksheetId/questions',
  requireTeacher,
  wrap(async (req, res) => {
    const worksheet = await editableWorksheet(req);
    const questionId = await addQuestion(worksheet.id, parseBody(questionInputSchema, req.body));
    const detail = await getWorksheetDetail(worksheet.id, req.user);
    res.status(201).json({ question: detail.questions.find((q) => q.id === questionId) });
  }),
);

worksheetsRouter.post(
  '/:worksheetId/questions/reorder',
  requireTeacher,
  wrap(async (req, res) => {
    const worksheet = await editableWorksheet(req);
    const { questionIds } = parseBody(reorderSchema, req.body);
    await reorderQuestions(worksheet.id, questionIds);
    res.json({ worksheet: await getWorksheetDetail(worksheet.id, req.user) });
  }),
);

// --- Individual questions ----------------------------------------------------

async function editableQuestion(req) {
  const context = await loadQuestionContext(uuid.parse(req.params.questionId));
  await assertCanTeachCourse(req.user, context.course_id);
  return context;
}

questionsRouter.patch(
  '/:questionId',
  requireTeacher,
  wrap(async (req, res) => {
    const context = await editableQuestion(req);
    await updateQuestion(context.question_id, parseBody(questionUpdateSchema, req.body));
    const detail = await getWorksheetDetail(context.worksheet_id, req.user);
    res.json({ question: detail.questions.find((q) => q.id === context.question_id) });
  }),
);

questionsRouter.delete(
  '/:questionId',
  requireTeacher,
  wrap(async (req, res) => {
    const context = await editableQuestion(req);
    const result = await deleteQuestion(context.question_id, { force: forced(req) });
    res.json({ ok: true, ...result });
  }),
);
