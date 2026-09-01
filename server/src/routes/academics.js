import { Router } from 'express';
import { z } from 'zod';
import { parseBody, wrap } from '../lib/http.js';
import { requireAuth, requireTeacher } from '../middleware/auth.js';
import { assertCanTeachCourse } from '../services/access.js';
import {
  enrollBatch, joinCourseByCode, listBatches, listDepartments,
  listProgrammes, listSubjects, rotateJoinCode, setJoinEnabled,
} from '../services/academics.js';

export const academicsRouter = Router();

const uuid = z.string().uuid('Must be a valid id');

academicsRouter.get(
  '/departments',
  requireAuth,
  wrap(async (req, res) => {
    res.json({ departments: await listDepartments() });
  }),
);

academicsRouter.get(
  '/programmes',
  requireAuth,
  wrap(async (req, res) => {
    const departmentId = req.query.departmentId ? uuid.parse(req.query.departmentId) : undefined;
    res.json({ programmes: await listProgrammes({ departmentId }) });
  }),
);

academicsRouter.get(
  '/batches',
  requireAuth,
  wrap(async (req, res) => {
    const programmeId = req.query.programmeId ? uuid.parse(req.query.programmeId) : undefined;
    res.json({ batches: await listBatches({ programmeId }) });
  }),
);

academicsRouter.get(
  '/subjects',
  requireAuth,
  wrap(async (req, res) => {
    res.json({
      subjects: await listSubjects({
        programmeId: req.query.programmeId ? uuid.parse(req.query.programmeId) : undefined,
        semester: req.query.semester ? Number(req.query.semester) : undefined,
        kind: req.query.kind === 'lab' || req.query.kind === 'theory' ? req.query.kind : undefined,
      }),
    });
  }),
);

// --- Joining a class ---------------------------------------------------------

const joinSchema = z.object({ code: z.string().trim().min(4).max(16) });

/** Google Classroom style: a student enters the code the teacher shared. */
academicsRouter.post(
  '/courses/join',
  requireAuth,
  wrap(async (req, res) => {
    const { code } = parseBody(joinSchema, req.body);
    const course = await joinCourseByCode(req.user, code);
    res.json({ course });
  }),
);

academicsRouter.post(
  '/courses/:courseId/join-code/rotate',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanTeachCourse(req.user, courseId);
    res.json({ joinCode: await rotateJoinCode(courseId) });
  }),
);

const joinToggleSchema = z.object({ enabled: z.boolean() });

academicsRouter.post(
  '/courses/:courseId/join-code/enabled',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanTeachCourse(req.user, courseId);
    const { enabled } = parseBody(joinToggleSchema, req.body);
    res.json({ joinEnabled: await setJoinEnabled(courseId, enabled) });
  }),
);

const enrollBatchSchema = z.object({ batchId: z.string().uuid() });

/** Enrols a whole batch, which is how a real lab class gets its roster. */
academicsRouter.post(
  '/courses/:courseId/enroll-batch',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanTeachCourse(req.user, courseId);
    const { batchId } = parseBody(enrollBatchSchema, req.body);
    res.json(await enrollBatch(courseId, batchId));
  }),
);
