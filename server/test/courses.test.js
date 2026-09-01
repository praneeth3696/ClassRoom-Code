import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { one, query } from '../src/db/index.js';
import { prepareTestDb, teardownTestDb } from './setup.js';
import { startTestServer, TEACHER_A, TEACHER_B, STUDENT_A, STUDENT_B } from './helpers.js';

let api;
let teacherA, teacherB, studentA, studentB;
let seededCourseId;

before(async () => {
  await prepareTestDb();
  api = await startTestServer();
  [teacherA, teacherB, studentA, studentB] = await Promise.all([
    api.signIn(TEACHER_A), api.signIn(TEACHER_B), api.signIn(STUDENT_A), api.signIn(STUDENT_B),
  ]);
  seededCourseId = (await one('SELECT id FROM courses WHERE name = $1', ['Programming Lab I'])).id;
});

after(async () => {
  api?.close();
  await teardownTestDb();
});

describe('course creation and visibility', () => {
  let ownCourseId;

  test('a teacher can create a course and is assigned to it', async () => {
    const res = await api.post('/api/courses', { name: 'Data Structures Lab', code: 'CS-L201' }, { cookie: teacherA });
    assert.equal(res.status, 201);
    ownCourseId = res.body.course.id;

    const detail = await api.get(`/api/courses/${ownCourseId}`, { cookie: teacherA });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.course.teachers.length, 1);
    assert.equal(detail.body.course.teachers[0].email, TEACHER_A);
  });

  test('a student cannot create a course', async () => {
    const res = await api.post('/api/courses', { name: 'Sneaky Course' }, { cookie: studentA });
    assert.equal(res.status, 403);
  });

  test('an anonymous request is rejected', async () => {
    assert.equal((await api.get('/api/courses')).status, 401);
    assert.equal((await api.post('/api/courses', { name: 'X' })).status, 401);
  });

  test('a teacher only lists courses they teach', async () => {
    const mine = await api.get('/api/courses', { cookie: teacherA });
    const names = mine.body.courses.map((c) => c.name);
    assert.ok(names.includes('Data Structures Lab'));

    const theirs = await api.get('/api/courses', { cookie: teacherB });
    assert.ok(!theirs.body.courses.some((c) => c.id === ownCourseId),
      'teacher B must not see a course they are not assigned to');
  });

  test('an unassigned teacher gets 404, not 403, for someone else’s course', async () => {
    const res = await api.get(`/api/courses/${ownCourseId}`, { cookie: teacherB });
    assert.equal(res.status, 404, 'must not confirm the course exists');
  });

  test('an unassigned teacher cannot modify the course', async () => {
    const res = await api.patch(`/api/courses/${ownCourseId}`, { name: 'Hijacked' }, { cookie: teacherB });
    assert.equal(res.status, 404);
    const still = await api.get(`/api/courses/${ownCourseId}`, { cookie: teacherA });
    assert.equal(still.body.course.name, 'Data Structures Lab');
  });

  test('a malformed course id is a 400, not a 500', async () => {
    const res = await api.get('/api/courses/not-a-uuid', { cookie: teacherA });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message, 'Validation failed');
  });

  test('students see the seeded course they are enrolled in', async () => {
    const res = await api.get('/api/courses', { cookie: studentA });
    assert.equal(res.status, 200);
    assert.ok(res.body.courses.some((c) => c.id === seededCourseId));
  });

  test('students see teaching staff but not the class roster', async () => {
    const res = await api.get(`/api/courses/${seededCourseId}`, { cookie: studentA });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.course.teachers));
    assert.equal(res.body.course.students, undefined, 'a student must not receive the roster');
  });
});

describe('roster management', () => {
  let courseId;

  before(async () => {
    const res = await api.post('/api/courses', { name: 'Roster Course' }, { cookie: teacherA });
    courseId = res.body.course.id;
  });

  test('adding a co-teacher grants them access', async () => {
    const before = await api.get(`/api/courses/${courseId}`, { cookie: teacherB });
    assert.equal(before.status, 404);

    const add = await api.post(`/api/courses/${courseId}/teachers`, { people: [{ email: TEACHER_B }] }, { cookie: teacherA });
    assert.equal(add.status, 201);

    const after = await api.get(`/api/courses/${courseId}`, { cookie: teacherB });
    assert.equal(after.status, 200, 'a co-teacher must now see the course');
    assert.equal(after.body.course.teachers.length, 2);
  });

  test('enrolling an unknown email provisions a claimable student', async () => {
    const email = `rollno-${Date.now()}@college.edu`;
    const res = await api.post(`/api/courses/${courseId}/students`, { people: [{ email, name: 'Roll Number 42' }] }, { cookie: teacherA });
    assert.equal(res.status, 201);
    assert.equal(res.body.students[0].role, 'student');

    const row = await one('SELECT google_sub FROM users WHERE lower(email) = lower($1)', [email]);
    assert.equal(row.google_sub, null, 'placeholder must have no google_sub so Google sign-in can claim it');
  });

  test('enrolling the same student twice is harmless', async () => {
    const email = `dupe-${Date.now()}@college.edu`;
    await api.post(`/api/courses/${courseId}/students`, { people: [{ email }] }, { cookie: teacherA });
    const again = await api.post(`/api/courses/${courseId}/students`, { people: [{ email }] }, { cookie: teacherA });
    assert.equal(again.status, 201);
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM course_enrollments ce JOIN users u ON u.id = ce.user_id
       WHERE ce.course_id = $1 AND lower(u.email) = lower($2)`, [courseId, email]);
    assert.equal(rows[0].n, 1);
  });

  test('a teacher cannot be enrolled as a student', async () => {
    const res = await api.post(`/api/courses/${courseId}/students`, { people: [{ email: TEACHER_B }] }, { cookie: teacherA });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /cannot be enrolled as a student/);
  });

  test('the last teacher cannot be removed', async () => {
    const solo = await api.post('/api/courses', { name: 'Solo Course' }, { cookie: teacherA });
    const soloId = solo.body.course.id;
    const me = (await api.get('/api/auth/me', { cookie: teacherA })).body.user;

    const res = await api.del(`/api/courses/${soloId}/teachers/${me.id}`, { cookie: teacherA });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /at least one teacher/);
  });

  test('a co-teacher can be removed once another remains', async () => {
    const teacherBUser = (await api.get('/api/auth/me', { cookie: teacherB })).body.user;
    const res = await api.del(`/api/courses/${courseId}/teachers/${teacherBUser.id}`, { cookie: teacherA });
    assert.equal(res.status, 200);
    assert.equal((await api.get(`/api/courses/${courseId}`, { cookie: teacherB })).status, 404);
  });

  test('roster input is validated', async () => {
    assert.equal((await api.post(`/api/courses/${courseId}/students`, { people: [] }, { cookie: teacherA })).status, 400);
    assert.equal((await api.post(`/api/courses/${courseId}/students`, { people: [{ email: 'nope' }] }, { cookie: teacherA })).status, 400);
  });

  test('a student cannot manage the roster', async () => {
    const res = await api.post(`/api/courses/${seededCourseId}/students`, { people: [{ email: 'x@college.edu' }] }, { cookie: studentA });
    assert.equal(res.status, 403);
  });
});
