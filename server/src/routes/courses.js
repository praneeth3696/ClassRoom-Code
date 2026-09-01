import { Router } from 'express';
import { z } from 'zod';
import { parseBody, wrap, badRequest } from '../lib/http.js';
import { requireAuth, requireTeacher } from '../middleware/auth.js';
import { assertCanTeachCourse, assertCanViewCourse } from '../services/access.js';
import {
  addStudents, addTeachers, createCourse, getCourseDetail, listCoursesFor,
  removeStudent, removeTeacher, updateCourse,
} from '../services/courses.js';
import { createWorksheet, getWorksheetDetail, listWorksheets } from '../services/worksheets.js';
import { worksheetCreateSchema } from './schemas.js';

export const coursesRouter = Router();

const uuid = z.string().uuid('Must be a valid id');

const courseCreateSchema = z.object({
  // A class made from the catalogue takes its name from the subject, so the
  // name is optional when a subject is chosen.
  name: z.string().trim().min(2).max(200).optional(),
  code: z.string().trim().max(50).optional().nullable(),
  department: z.string().trim().max(120).optional().nullable(),
  subjectId: z.string().uuid().optional().nullable(),
  batchId: z.string().uuid().optional().nullable(),
  academicYear: z.string().trim().max(20).optional().nullable(),
  semester: z.number().int().min(1).max(10).optional().nullable(),
}).refine((c) => Boolean(c.name || c.subjectId), {
  message: 'Choose a subject, or give the class a name',
  path: ['name'],
});

const courseUpdateSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  code: z.string().trim().max(50).optional().nullable(),
  department: z.string().trim().max(120).optional().nullable(),
  archived: z.boolean().optional(),
});

const rosterSchema = z.object({
  people: z
    .array(
      z.object({
        email: z.string().email(),
        name: z.string().trim().max(200).optional(),
        section: z.string().trim().max(50).optional(),
      }),
    )
    .min(1, 'Provide at least one person')
    .max(500, 'Add at most 500 people at a time'),
});

coursesRouter.use(requireAuth);

coursesRouter.get(
  '/',
  wrap(async (req, res) => {
    const courses = await listCoursesFor(req.user, { includeArchived: req.query.archived === 'true' });
    res.json({ courses });
  }),
);

coursesRouter.post(
  '/',
  requireTeacher,
  wrap(async (req, res) => {
    const body = parseBody(courseCreateSchema, req.body);
    const course = await createCourse(body, req.user);
    res.status(201).json({ course });
  }),
);

coursesRouter.get(
  '/:courseId',
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanViewCourse(req.user, courseId);
    const isTeacher = req.user.role === 'teacher' || req.user.role === 'admin';
    // Students see the teaching staff, but not the class roster and not the
    // join code, which would let them pull in students from other sections.
    const detail = await getCourseDetail(courseId, { includeJoinCode: isTeacher });
    if (!isTeacher) delete detail.students;
    res.json({ course: detail });
  }),
);

coursesRouter.patch(
  '/:courseId',
  requireTeacher,
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanTeachCourse(req.user, courseId);
    const body = parseBody(courseUpdateSchema, req.body);
    const course = await updateCourse(courseId, {
      name: body.name,
      code: body.code,
      department: body.department,
      archived: body.archived,
    });
    res.json({ course });
  }),
);

// --- Roster ------------------------------------------------------------------

coursesRouter.post(
  '/:courseId/teachers',
  requireTeacher,
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanTeachCourse(req.user, courseId);
    const { people } = parseBody(rosterSchema, req.body);
    const added = await addTeachers(courseId, people);
    res.status(201).json({ teachers: added });
  }),
);

coursesRouter.delete(
  '/:courseId/teachers/:userId',
  requireTeacher,
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanTeachCourse(req.user, courseId);
    await removeTeacher(courseId, uuid.parse(req.params.userId));
    res.json({ ok: true });
  }),
);

coursesRouter.post(
  '/:courseId/students',
  requireTeacher,
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanTeachCourse(req.user, courseId);
    const { people } = parseBody(rosterSchema, req.body);
    const added = await addStudents(courseId, people);
    res.status(201).json({ students: added });
  }),
);

coursesRouter.delete(
  '/:courseId/students/:userId',
  requireTeacher,
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanTeachCourse(req.user, courseId);
    await removeStudent(courseId, uuid.parse(req.params.userId));
    res.json({ ok: true });
  }),
);

// --- Worksheets within a course ----------------------------------------------

coursesRouter.get(
  '/:courseId/worksheets',
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanViewCourse(req.user, courseId);
    const worksheets = await listWorksheets(courseId, req.user);
    res.json({ worksheets });
  }),
);

coursesRouter.post(
  '/:courseId/worksheets',
  requireTeacher,
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanTeachCourse(req.user, courseId);
    const body = parseBody(worksheetCreateSchema, req.body);
    if (body.status === 'published' && (body.questions ?? []).length === 0) {
      throw badRequest('A worksheet needs at least one question before it can be published');
    }
    const worksheetId = await createWorksheet(courseId, body, req.user);
    res.status(201).json({ worksheet: await getWorksheetDetail(worksheetId, req.user) });
  }),
);
