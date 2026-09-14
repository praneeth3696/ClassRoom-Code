import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { one } from '../src/db/index.js';
import { prepareTestDb, teardownTestDb } from './setup.js';
import { startTestServer, TEACHER_A, STUDENT_A, STUDENT_B } from './helpers.js';
import { parseCsv } from './csv.js';

const PY_SUM = 'a, b = map(int, input().split())\nprint(a + b)';
const PY_WRONG = 'a, b = map(int, input().split())\nprint(a - b)';

let api, teacher, studentA, studentB, courseId, worksheetId, sumId, essayId;

before(async () => {
  await prepareTestDb();
  api = await startTestServer();
  [teacher, studentA, studentB] = await Promise.all([
    api.signIn(TEACHER_A), api.signIn(STUDENT_A), api.signIn(STUDENT_B),
  ]);
  courseId = (await one('SELECT id FROM courses WHERE name = $1', ['Programming Lab I'])).id;

  const ws = await api.post(`/api/courses/${courseId}/worksheets`, {
    title: 'Week 3: loops, and "quotes"',
    questions: [
      { title: 'Sum', allowedLanguages: ['python'], points: 10, testCases: [{ input: '2 3\n', expectedOutput: '5\n' }] },
      { title: 'Explain, briefly', allowedLanguages: ['python'], points: 5, testCases: [] },
    ],
  }, { cookie: teacher });
  worksheetId = ws.body.worksheet.id;
  [sumId, essayId] = ws.body.worksheet.questions.map((q) => q.id);
  await api.post(`/api/worksheets/${worksheetId}/publish`, {}, { cookie: teacher });

  await api.post(`/api/questions/${sumId}/submit`, { code: PY_SUM, language: 'python' }, { cookie: studentA });
  await api.post(`/api/questions/${essayId}/submit`, { code: 'print("loops repeat")', language: 'python' }, { cookie: studentA });
  await api.post(`/api/questions/${sumId}/submit`, { code: PY_WRONG, language: 'python' }, { cookie: studentB });

  const list = await api.get(`/api/questions/${sumId}/submissions`, { cookie: teacher });
  const aSum = list.body.submissions.find((s) => s.student.email === STUDENT_A);
  await api.put(`/api/submissions/${aSum.id}/feedback`, { marks: 9, comment: 'Good' }, { cookie: teacher });
  const essays = await api.get(`/api/questions/${essayId}/submissions`, { cookie: teacher });
  await api.put(`/api/submissions/${essays.body.submissions[0].id}/feedback`, { marks: 4 }, { cookie: teacher });
});

after(async () => {
  api?.close();
  await teardownTestDb();
});

const exportCsv = (cookie) => api.get(`/api/worksheets/${worksheetId}/export.csv`, { cookie });

describe('exporting a worksheet’s results (QUESTIONS.md #10)', () => {
  test('a teacher downloads a CSV attachment named after the worksheet', async () => {
    const res = await exportCsv(teacher);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/csv; charset=utf-8/);
    const disposition = res.headers.get('content-disposition');
    assert.match(disposition, /^attachment; filename="Week 3- loops, and quotes\.csv"/);
  });

  test('one row per enrolled student, one result and marks column per question', async () => {
    const rows = parseCsv((await exportCsv(teacher)).body.raw);
    assert.deepEqual(rows[0], [
      'Student', 'Email', 'Roll number',
      'Q1 Sum: result', 'Q1 Sum: marks (/10)',
      'Q2 Explain, briefly: result', 'Q2 Explain, briefly: marks (/5)',
      'Total marks (/15)', 'Late submissions',
    ]);

    const byEmail = Object.fromEntries(rows.slice(1).map((r) => [r[1], r]));
    assert.equal(rows.length - 1, 3, 'every enrolled student appears, including one who submitted nothing');
    assert.deepEqual(byEmail[STUDENT_A].slice(3), ['passed', '9', 'teacher-graded', '4', '13', '0']);
    assert.deepEqual(byEmail[STUDENT_B].slice(3), ['failed', '', 'not submitted', '', '0', '0']);
    assert.deepEqual(byEmail['chetan.kulkarni@college.edu'].slice(3), ['not submitted', '', 'not submitted', '', '0', '0']);
  });

  test('a student cannot export, and neither can a teacher outside the course', async () => {
    assert.equal((await exportCsv(studentA)).status, 403);

    const email = `outsider-export-${Date.now()}@college.edu`;
    const other = await api.post('/api/courses', { name: 'Unrelated export course' }, { cookie: teacher });
    await api.post(`/api/courses/${other.body.course.id}/teachers`, { people: [{ email }] }, { cookie: teacher });
    assert.equal((await exportCsv(await api.signIn(email))).status, 404);
  });

  test('a name that looks like a spreadsheet formula is neutralised', async () => {
    const email = `formula-${Date.now()}@college.edu`;
    await api.post(`/api/courses/${courseId}/students`, {
      people: [{ email, name: '=HYPERLINK("http://evil.example","click")' }],
    }, { cookie: teacher });

    const rows = parseCsv((await exportCsv(teacher)).body.raw);
    const row = rows.find((r) => r[1] === email);
    assert.equal(row[0], `'=HYPERLINK("http://evil.example","click")`,
      'a leading apostrophe stops Excel and Sheets evaluating it');
  });
});
