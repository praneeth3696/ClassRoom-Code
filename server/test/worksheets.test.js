import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { one, query } from '../src/db/index.js';
import { prepareTestDb, teardownTestDb } from './setup.js';
import { startTestServer, TEACHER_A, TEACHER_B, STUDENT_A } from './helpers.js';
import { submissionWindow } from '../src/services/access.js';

let api, teacherA, teacherB, studentA, courseId;

const sampleQuestion = (overrides = {}) => ({
  title: 'Add two numbers',
  description: 'Read two integers and print their sum.',
  allowedLanguages: ['c', 'python'],
  points: 10,
  testCases: [{ label: 'basic', input: '2 3\n', expectedOutput: '5\n' }],
  ...overrides,
});

before(async () => {
  await prepareTestDb();
  api = await startTestServer();
  [teacherA, teacherB, studentA] = await Promise.all([
    api.signIn(TEACHER_A), api.signIn(TEACHER_B), api.signIn(STUDENT_A),
  ]);
  courseId = (await one('SELECT id FROM courses WHERE name = $1', ['Programming Lab I'])).id;
});

after(async () => {
  api?.close();
  await teardownTestDb();
});

describe('worksheet authoring', () => {
  let worksheetId;

  test('a teacher creates a draft worksheet with questions', async () => {
    const res = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Worksheet 3 — Functions',
      description: 'Practice with functions.',
      deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
      questions: [sampleQuestion(), sampleQuestion({ title: 'Second question', testCases: [] })],
    }, { cookie: teacherA });

    assert.equal(res.status, 201);
    worksheetId = res.body.worksheet.id;
    assert.equal(res.body.worksheet.status, 'draft');
    assert.equal(res.body.worksheet.questions.length, 2);
    assert.equal(res.body.worksheet.questions[0].testCases.length, 1);
    assert.equal(res.body.worksheet.questions[1].testCases.length, 0,
      'a question with no test cases is valid — open-ended questions have none');
    assert.deepEqual(res.body.worksheet.questions.map((q) => q.position), [0, 1]);
  });

  test('an unassigned teacher cannot create a worksheet in the course', async () => {
    const soloCourse = await api.post('/api/courses', { name: 'Private Course' }, { cookie: teacherB });
    const res = await api.post(`/api/courses/${soloCourse.body.course.id}/worksheets`, {
      title: 'Intruding worksheet', questions: [sampleQuestion()],
    }, { cookie: teacherA });
    assert.equal(res.status, 404);
  });

  test('a student cannot create a worksheet', async () => {
    const res = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Student worksheet', questions: [sampleQuestion()],
    }, { cookie: studentA });
    assert.equal(res.status, 403);
  });

  test('rejects an unsupported language', async () => {
    const res = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Bad language sheet',
      questions: [sampleQuestion({ allowedLanguages: ['rust'] })],
    }, { cookie: teacherA });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details[0].field, 'questions.0.allowedLanguages.0');
  });

  test('rejects a question with no languages', async () => {
    const res = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'No language sheet', questions: [sampleQuestion({ allowedLanguages: [] })],
    }, { cookie: teacherA });
    assert.equal(res.status, 400);
  });

  test('rejects an invalid deadline', async () => {
    const res = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Bad date sheet', deadline: 'next tuesday', questions: [sampleQuestion()],
    }, { cookie: teacherA });
    assert.equal(res.status, 400);
  });

  test('a question can be added, edited and reordered', async () => {
    const added = await api.post(`/api/worksheets/${worksheetId}/questions`,
      sampleQuestion({ title: 'Third question' }), { cookie: teacherA });
    assert.equal(added.status, 201);
    assert.equal(added.body.question.position, 2, 'new questions go to the end');

    const edited = await api.patch(`/api/questions/${added.body.question.id}`, {
      title: 'Third question (revised)',
      testCases: [
        { input: '1 1\n', expectedOutput: '2\n' },
        { input: '5 5\n', expectedOutput: '10\n' },
      ],
    }, { cookie: teacherA });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.question.title, 'Third question (revised)');
    assert.equal(edited.body.question.testCases.length, 2, 'test cases are replaced wholesale');

    const detail = await api.get(`/api/worksheets/${worksheetId}`, { cookie: teacherA });
    const ids = detail.body.worksheet.questions.map((q) => q.id);
    const reordered = await api.post(`/api/worksheets/${worksheetId}/questions/reorder`,
      { questionIds: [...ids].reverse() }, { cookie: teacherA });
    assert.equal(reordered.status, 200);
    assert.deepEqual(reordered.body.worksheet.questions.map((q) => q.id), [...ids].reverse());
  });

  test('a partial reorder list is rejected', async () => {
    const detail = await api.get(`/api/worksheets/${worksheetId}`, { cookie: teacherA });
    const ids = detail.body.worksheet.questions.map((q) => q.id);
    const res = await api.post(`/api/worksheets/${worksheetId}/questions/reorder`,
      { questionIds: [ids[0]] }, { cookie: teacherA });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /every question/);
  });

  test('editing a question in another teacher’s course is refused', async () => {
    // The seeded course is deliberately co-taught, so this needs a course only
    // teacher A is assigned to.
    const solo = await api.post('/api/courses', { name: 'Solo Authoring Course' }, { cookie: teacherA });
    const sheet = await api.post(`/api/courses/${solo.body.course.id}/worksheets`, {
      title: 'Private sheet', questions: [sampleQuestion()],
    }, { cookie: teacherA });
    const questionId = sheet.body.worksheet.questions[0].id;

    const res = await api.patch(`/api/questions/${questionId}`, { title: 'Hijacked' }, { cookie: teacherB });
    assert.equal(res.status, 404);
    assert.equal((await api.del(`/api/questions/${questionId}`, { cookie: teacherB })).status, 404);

    const unchanged = await api.get(`/api/worksheets/${sheet.body.worksheet.id}`, { cookie: teacherA });
    assert.equal(unchanged.body.worksheet.questions[0].title, 'Add two numbers');
  });

  test('a co-teacher can edit the shared course’s questions', async () => {
    // The flip side: co-teaching is the unit of permission (SPEC.md §5), and
    // both seeded teachers are assigned to this course.
    const detail = await api.get(`/api/worksheets/${worksheetId}`, { cookie: teacherA });
    const questionId = detail.body.worksheet.questions[0].id;
    const res = await api.patch(`/api/questions/${questionId}`, { points: 15 }, { cookie: teacherB });
    assert.equal(res.status, 200);
    assert.equal(res.body.question.points, 15);
  });
});

describe('publishing and student visibility', () => {
  let draftId, publishedId;

  before(async () => {
    const draft = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Unpublished draft', questions: [sampleQuestion()],
    }, { cookie: teacherA });
    draftId = draft.body.worksheet.id;

    const pub = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Published sheet',
      deadline: new Date(Date.now() + 86400000).toISOString(),
      questions: [sampleQuestion()],
    }, { cookie: teacherA });
    publishedId = pub.body.worksheet.id;
    await api.post(`/api/worksheets/${publishedId}/publish`, {}, { cookie: teacherA });
  });

  test('a student cannot see a draft worksheet', async () => {
    const res = await api.get(`/api/worksheets/${draftId}`, { cookie: studentA });
    assert.equal(res.status, 404, 'a draft must be invisible, not merely forbidden');

    const list = await api.get(`/api/courses/${courseId}/worksheets`, { cookie: studentA });
    assert.ok(!list.body.worksheets.some((w) => w.id === draftId));
  });

  test('a student sees a published worksheet with its test cases', async () => {
    const res = await api.get(`/api/worksheets/${publishedId}`, { cookie: studentA });
    assert.equal(res.status, 200);
    assert.equal(res.body.worksheet.submissionOpen, true);
    // SPEC.md §4: every test case is visible to the student.
    assert.equal(res.body.worksheet.questions[0].testCases.length, 1);
    assert.equal(res.body.worksheet.questions[0].testCases[0].expectedOutput, '5\n');
  });

  test('a teacher sees drafts in the list, a student does not', async () => {
    const teacherList = await api.get(`/api/courses/${courseId}/worksheets`, { cookie: teacherA });
    const studentList = await api.get(`/api/courses/${courseId}/worksheets`, { cookie: studentA });
    assert.ok(teacherList.body.worksheets.length > studentList.body.worksheets.length);
    assert.ok(studentList.body.worksheets.every((w) => w.status === 'published'));
  });

  test('an empty worksheet cannot be published', async () => {
    const empty = await api.post(`/api/courses/${courseId}/worksheets`, { title: 'Empty sheet' }, { cookie: teacherA });
    const res = await api.post(`/api/worksheets/${empty.body.worksheet.id}/publish`, {}, { cookie: teacherA });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /at least one question/);
  });

  test('unpublishing hides it from students again', async () => {
    await api.post(`/api/worksheets/${publishedId}/unpublish`, {}, { cookie: teacherA });
    assert.equal((await api.get(`/api/worksheets/${publishedId}`, { cookie: studentA })).status, 404);
    await api.post(`/api/worksheets/${publishedId}/publish`, {}, { cookie: teacherA });
    assert.equal((await api.get(`/api/worksheets/${publishedId}`, { cookie: studentA })).status, 200);
  });

  test('a student enrolled elsewhere cannot reach this worksheet', async () => {
    const otherCourse = await api.post('/api/courses', { name: 'Other Course' }, { cookie: teacherB });
    const email = `outsider-${Date.now()}@college.edu`;
    await api.post(`/api/courses/${otherCourse.body.course.id}/students`, { people: [{ email }] }, { cookie: teacherB });
    const outsider = await api.signIn(email);
    assert.equal((await api.get(`/api/worksheets/${publishedId}`, { cookie: outsider })).status, 404);
  });
});

describe('the submission window (SPEC.md §14)', () => {
  const base = { status: 'published', allow_late_submissions: false };

  test('an unpublished worksheet is always closed', () => {
    assert.equal(submissionWindow({ ...base, status: 'draft', deadline: null }).open, false);
  });

  test('no deadline means it never closes', () => {
    assert.equal(submissionWindow({ ...base, deadline: null }).open, true);
  });

  test('open before the deadline, closed after', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();
    assert.equal(submissionWindow({ ...base, deadline: future }).open, true);
    const closed = submissionWindow({ ...base, deadline: past });
    assert.equal(closed.open, false);
    assert.match(closed.reason, /deadline/);
  });

  test('late submissions stay open past the deadline and are flagged', () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const window = submissionWindow({ ...base, allow_late_submissions: true, deadline: past });
    assert.equal(window.open, true);
    assert.equal(window.late, true);
  });

  test('an expired worksheet reports as closed to the student', async () => {
    const expired = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Expired sheet',
      deadline: new Date(Date.now() - 86400000).toISOString(),
      questions: [sampleQuestion()],
    }, { cookie: teacherA });
    const id = expired.body.worksheet.id;
    await api.post(`/api/worksheets/${id}/publish`, {}, { cookie: teacherA });

    const res = await api.get(`/api/worksheets/${id}`, { cookie: studentA });
    assert.equal(res.status, 200, 'a student can still read an expired worksheet');
    assert.equal(res.body.worksheet.submissionOpen, false);
    assert.match(res.body.worksheet.submissionClosedReason, /deadline/);
  });
});

describe('destructive edits protect student work', () => {
  let worksheetId, questionId, studentId;

  before(async () => {
    const res = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Sheet with submissions', questions: [sampleQuestion()],
    }, { cookie: teacherA });
    worksheetId = res.body.worksheet.id;
    questionId = res.body.worksheet.questions[0].id;
    studentId = (await one('SELECT id FROM users WHERE email = $1', [STUDENT_A])).id;
    await query(
      `INSERT INTO submissions (question_id, student_id, code, language, status)
       VALUES ($1, $2, 'print(1)', 'python', 'submitted')`,
      [questionId, studentId],
    );
  });

  test('deleting a worksheet with submissions needs confirmation', async () => {
    const res = await api.del(`/api/worksheets/${worksheetId}`, { cookie: teacherA });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /1 student submission/);
    assert.ok(await one('SELECT id FROM worksheets WHERE id = $1', [worksheetId]), 'must not have deleted');
  });

  test('deleting a question with submissions needs confirmation', async () => {
    const res = await api.del(`/api/questions/${questionId}`, { cookie: teacherA });
    assert.equal(res.status, 409);
  });

  test('force deletes and reports what was removed', async () => {
    const res = await api.del(`/api/worksheets/${worksheetId}?force=true`, { cookie: teacherA });
    assert.equal(res.status, 200);
    assert.equal(res.body.deletedSubmissions, 1);
    assert.equal(await one('SELECT id FROM worksheets WHERE id = $1', [worksheetId]), null);
    assert.equal(await one('SELECT id FROM submissions WHERE question_id = $1', [questionId]), null);
  });

  test('an empty worksheet deletes without confirmation', async () => {
    const created = await api.post(`/api/courses/${courseId}/worksheets`, {
      title: 'Disposable', questions: [sampleQuestion()],
    }, { cookie: teacherA });
    const res = await api.del(`/api/worksheets/${created.body.worksheet.id}`, { cookie: teacherA });
    assert.equal(res.status, 200);
    assert.equal(res.body.deletedSubmissions, 0);
  });
});
