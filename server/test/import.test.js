import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { one } from '../src/db/index.js';
import { prepareTestDb, teardownTestDb } from './setup.js';
import { startTestServer, TEACHER_A, TEACHER_B, STUDENT_A } from './helpers.js';
import { htmlToText, detectType, extractDocument } from '../src/services/documentText.js';
import { validateDraft } from '../src/services/worksheetDraft.js';
import { solveDraft } from '../src/services/draftSolver.js';
import { shutdownEngines } from '../src/services/dbEngines/index.js';

let api, teacher, otherTeacher, student, courseId;

/**
 * A draft in exactly the shape the model is constrained to produce, standing in
 * for the API call. Everything after the model - solving, review, apply - is
 * exercised for real.
 *
 * Note what is *not* here: expected outputs. That is the point.
 */
const MONGO_DRAFT = {
  title: 'Imported - MongoDB library queries',
  description: 'Drafted from the lab sheet.',
  datasetEngine: 'mongodb',
  datasetScript:
    "db.book.insertMany(["
    + "{ title: 'Database Concepts', language: 'English', available: 'Y' },"
    + "{ title: 'Computer Networks', language: 'English', available: 'N' },"
    + "{ title: 'Tamil Ilakkiyam', language: 'Tamil', available: 'Y' }]);",
  notesForTeacher: ['Sample data was invented; the sheet gave none.'],
  questions: [
    {
      title: 'Available books',
      description: "Return the title of every book whose available field is 'Y'.",
      referenceNotes: 'A simple find with a projection.',
      allowedLanguages: ['mongodb'],
      points: 3,
      setupScript: null,
      orderedComparison: false,
      autoGradable: true,
      referenceSolution: "db.book.find({ available: 'Y' }, { _id: 0, title: 1 })",
      testInputs: [{ label: 'Two available books', input: '' }],
    },
    {
      title: 'Language-wise count',
      description: 'Group the books by language and return the count for each.',
      referenceNotes: '$group then $project.',
      allowedLanguages: ['mongodb'],
      points: 5,
      setupScript: null,
      orderedComparison: false,
      autoGradable: true,
      referenceSolution:
        "db.book.aggregate([\n"
        + "  { $group: { _id: '$language', count: { $sum: 1 } } },\n"
        + "  { $project: { _id: 0, language: '$_id', count: 1 } }\n"
        + '])',
      testInputs: [{ label: 'English 2, Tamil 1', input: '' }],
    },
    {
      title: 'Explain your approach',
      description: 'In comments, explain why $unwind was needed. Then print your roll number.',
      referenceNotes: 'Read by your teacher.',
      allowedLanguages: ['mongodb'],
      points: 5,
      setupScript: null,
      orderedComparison: false,
      autoGradable: false,
      referenceSolution: '',
      testInputs: [],
    },
    {
      title: 'Broken reference solution',
      description: 'This one is here to prove a bad reference solution is caught.',
      referenceNotes: null,
      allowedLanguages: ['mongodb'],
      points: 4,
      setupScript: null,
      orderedComparison: false,
      autoGradable: true,
      referenceSolution: 'db.book.aggregate([{ $nonsenseStage: 1 }])',
      testInputs: [{ label: 'Should fail', input: '' }],
    },
  ],
};

const PROGRAM_DRAFT = {
  title: 'Imported - basic C programs',
  description: null,
  datasetEngine: null,
  datasetScript: null,
  notesForTeacher: [],
  questions: [
    {
      title: 'Sum of two integers',
      description: 'Read two integers and print their sum.',
      referenceNotes: null,
      allowedLanguages: ['python'],
      points: 5,
      setupScript: null,
      orderedComparison: false,
      autoGradable: true,
      referenceSolution: 'a, b = map(int, input().split())\nprint(a + b)',
      testInputs: [
        { label: 'Small positives', input: '3 4\n' },
        { label: 'With a negative', input: '-10 2\n' },
        { label: 'Zeroes', input: '0 0\n' },
      ],
    },
  ],
};

before(async () => {
  await prepareTestDb();
  api = await startTestServer();
  [teacher, otherTeacher, student] = await Promise.all([
    api.signIn(TEACHER_A), api.signIn(TEACHER_B), api.signIn(STUDENT_A),
  ]);
  courseId = (await one('SELECT id FROM courses WHERE name = $1', ['Programming Lab I'])).id;
});

after(async () => {
  api?.close();
  await shutdownEngines();
  await teardownTestDb();
});

describe('document extraction', () => {
  test('recognises the formats a teacher would upload', () => {
    assert.equal(detectType('sheet.docx', ''), 'docx');
    assert.equal(detectType('sheet.pdf', ''), 'pdf');
    assert.equal(detectType('sheet.txt', ''), 'text');
    assert.equal(detectType('sheet.md', ''), 'text');
    assert.equal(detectType('photo.png', 'image/png'), null);
    assert.equal(detectType('x', 'application/pdf'), 'pdf', 'mime type wins when there is no extension');
  });

  test('keeps a table row on one line', () => {
    const html = '<table><tr><td><p>Create type</p></td><td><p>create type T as object</p>'
      + '<p>(a NUMBER);</p></td><td><p>makes a type</p></td></tr></table>';
    const text = htmlToText(html);
    assert.equal(text.split('\n').filter((l) => l.trim()).length, 1, 'one row, one line');
    assert.match(text, /Create type \| create type T as object \(a NUMBER\); \| makes a type/);
  });

  test('does not escape punctuation in code', () => {
    // mammoth's markdown converter emits \( and \_ , which corrupts SQL.
    const text = htmlToText('<p>create table CUSTOMER (Customer_ID NUMBER);</p>');
    assert.equal(text, 'create table CUSTOMER (Customer_ID NUMBER);');
    assert.ok(!text.includes('\\'), 'no backslash escapes');
  });

  test('reads plain text and refuses an unsupported type', async () => {
    const txt = await extractDocument({
      buffer: Buffer.from('Question 1: print hello'), filename: 'sheet.txt', mimeType: 'text/plain',
    });
    assert.equal(txt.kind, 'text');
    assert.match(txt.text, /print hello/);

    await assert.rejects(
      () => extractDocument({ buffer: Buffer.from('x'), filename: 'sheet.png', mimeType: 'image/png' }),
      /Unsupported file type/,
    );
  });

  test('a PDF is passed through rather than extracted', async () => {
    const pdf = await extractDocument({
      buffer: Buffer.from('%PDF-1.4'), filename: 'sheet.pdf', mimeType: 'application/pdf',
    });
    assert.equal(pdf.kind, 'pdf');
    assert.equal(pdf.text, null, 'the model reads the PDF itself');
  });

  test('an old .doc file is refused with a usable instruction', async () => {
    await assert.rejects(
      () => extractDocument({ buffer: Buffer.from('x'), filename: 'sheet.doc', mimeType: 'application/msword' }),
      /save as \.docx/,
    );
  });
});

describe('draft validation', () => {
  test('accepts a well-formed draft', () => {
    assert.equal(validateDraft(MONGO_DRAFT).questions.length, 4);
  });

  test('rejects a draft that mixes program languages with database engines', () => {
    const bad = structuredClone(MONGO_DRAFT);
    bad.questions[0].allowedLanguages = ['python', 'mongodb'];
    assert.throws(() => validateDraft(bad), /mixes program languages/);
  });

  test('rejects a draft missing required fields', () => {
    assert.throws(() => validateDraft({ title: 'x' }), /did not match the expected shape/);
  });
});

describe('computing expected outputs by running the reference solution', () => {
  let solved;

  before(async () => {
    solved = await solveDraft(validateDraft(MONGO_DRAFT));
  });

  test('a working reference solution produces a verified expectation', () => {
    const q = solved.draft.questions[0];
    assert.equal(q.testCases.length, 1);
    // The expectation is whatever the solution actually returned - not text the
    // model wrote.
    assert.match(q.testCases[0].expectedOutput, /Database Concepts/);
    assert.match(q.testCases[0].expectedOutput, /Tamil Ilakkiyam/);
    assert.ok(!q.testCases[0].expectedOutput.includes('Computer Networks'), 'that book is unavailable');
    assert.equal(solved.report.questions[0].status, 'verified');
  });

  test('an aggregation expectation is computed from the real engine', () => {
    const q = solved.draft.questions[1];
    assert.equal(q.testCases.length, 1);
    assert.match(q.testCases[0].expectedOutput, /English/);
    assert.match(q.testCases[0].expectedOutput, /Tamil/);
    assert.match(q.testCases[0].expectedOutput, /2/);
  });

  test('an open-ended question is imported as teacher-graded, with no test cases', () => {
    const q = solved.draft.questions[2];
    assert.equal(q.autoGradable, false);
    assert.equal(q.testCases.length, 0);
    assert.equal(solved.report.questions[2].status, 'teacher_graded');
  });

  test('a broken reference solution never becomes a made-up expectation', () => {
    // The failure that would ruin this feature is inventing an expected output
    // for a question whose solution does not run.
    const q = solved.draft.questions[3];
    assert.equal(q.testCases.length, 0, 'no test cases at all');
    assert.equal(q.autoGradable, false, 'downgraded to teacher-graded');
    assert.equal(solved.report.questions[3].status, 'failed');
    assert.match(solved.report.questions[3].detail ?? '', /nonsenseStage/i);
  });

  test('the report summarises what a teacher needs to look at', () => {
    assert.equal(solved.report.verified, 2);
    assert.equal(solved.report.failed, 1);
    assert.equal(solved.report.teacherGraded, 1);
  });

  test('program questions get one expectation per input', async () => {
    const out = await solveDraft(validateDraft(PROGRAM_DRAFT));
    const q = out.draft.questions[0];
    assert.equal(q.testCases.length, 3);
    assert.equal(q.testCases[0].expectedOutput.trim(), '7');
    assert.equal(q.testCases[1].expectedOutput.trim(), '-8');
    assert.equal(q.testCases[2].expectedOutput.trim(), '0');
    assert.equal(q.testCases[0].input, '3 4\n', 'the input is preserved');
  });
});

describe('the import API', () => {
  let importId;

  test('a teacher uploads a problem sheet and gets its text back', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('Question 1. Print the sum of two integers.')],
      { type: 'text/plain' }), 'sheet.txt');
    const res = await fetch(`${api.base}/api/courses/${courseId}/imports`, {
      method: 'POST', headers: { Cookie: teacher }, body: form,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    importId = body.import.id;
    assert.equal(body.import.status, 'extracted');
    assert.match(body.import.extractedText, /Print the sum/);
  });

  test('the upload is listed on the course', async () => {
    const res = await api.get(`/api/courses/${courseId}/imports`, { cookie: teacher });
    assert.equal(res.status, 200);
    assert.ok(res.body.imports.some((i) => i.id === importId));
    assert.equal(typeof res.body.available, 'boolean', 'reports whether an API key is configured');
  });

  test('an unsupported file is refused before anything is stored', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('binary')], { type: 'image/png' }), 'scan.png');
    const res = await fetch(`${api.base}/api/courses/${courseId}/imports`, {
      method: 'POST', headers: { Cookie: teacher }, body: form,
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /Unsupported file type/);
  });

  test('a real .docx lab sheet extracts if one is available', async (t) => {
    const sheet = '/Users/praneeth/Work/Academic/PSG/SEM5/SS-BIG DATA/LAB ASSIGNMENTS/Lab Exercise-1_Mongo DB.docx';
    if (!fs.existsSync(sheet)) return t.skip('lab sheet not present on this machine');

    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(sheet)]), path.basename(sheet));
    const res = await fetch(`${api.base}/api/courses/${courseId}/imports`, {
      method: 'POST', headers: { Cookie: teacher }, body: form,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.import.sourceType, 'docx');
    assert.match(body.import.extractedText, /USER/);
    assert.match(body.import.extractedText, /aggregate|Retrieve/i);
  });

  test('a student cannot import, and an unassigned teacher cannot either', async () => {
    const form = () => {
      const f = new FormData();
      f.append('file', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'a.txt');
      return f;
    };
    const asStudent = await fetch(`${api.base}/api/courses/${courseId}/imports`, {
      method: 'POST', headers: { Cookie: student }, body: form(),
    });
    assert.equal(asStudent.status, 403);

    const solo = await api.post('/api/courses', { name: 'Import Private Course' }, { cookie: teacher });
    const outsider = await fetch(`${api.base}/api/courses/${solo.body.course.id}/imports`, {
      method: 'POST', headers: { Cookie: otherTeacher }, body: form(),
    });
    assert.equal(outsider.status, 404, 'not confirmed to exist');
  });

  test('analysing without an API key reports it clearly rather than half-failing', async (t) => {
    const { isConfigured } = await import('../src/services/worksheetDraft.js');
    if (isConfigured()) return t.skip('an API key is configured, so this path is not exercised');

    const res = await api.post(`/api/imports/${importId}/analyze`, {}, { cookie: teacher });
    assert.equal(res.status, 503);
    assert.match(res.body.error.message, /ANTHROPIC_API_KEY/);

    const after = await api.get(`/api/imports/${importId}`, { cookie: teacher });
    assert.equal(after.body.import.status, 'failed');
    assert.ok(after.body.import.error, 'the reason is recorded on the import');
  });
});

describe('applying a reviewed draft', () => {
  let importId;

  before(async () => {
    // Stand in for the analyse step, which needs the API, then exercise
    // everything after it for real.
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('placeholder sheet')], { type: 'text/plain' }), 's.txt');
    const created = await fetch(`${api.base}/api/courses/${courseId}/imports`, {
      method: 'POST', headers: { Cookie: teacher }, body: form,
    }).then((r) => r.json());
    importId = created.import.id;

    const { draft, report } = await solveDraft(validateDraft(MONGO_DRAFT));
    await one(
      `UPDATE worksheet_imports SET draft = $2, solve_report = $3, status = 'drafted' WHERE id = $1 RETURNING id`,
      [importId, JSON.stringify(draft), JSON.stringify(report)],
    );
  });

  test('the teacher can edit the draft before applying it', async () => {
    const current = await api.get(`/api/imports/${importId}`, { cookie: teacher });
    const draft = current.body.import.draft;
    draft.title = 'Renamed by the teacher';
    draft.questions[0].points = 9;

    const saved = await api.patch(`/api/imports/${importId}`, { draft }, { cookie: teacher });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.import.draft.title, 'Renamed by the teacher');
    assert.equal(saved.body.import.draft.questions[0].points, 9);
  });

  test('an invalid edit is rejected', async () => {
    const res = await api.patch(`/api/imports/${importId}`, { draft: { title: 'no questions' } }, { cookie: teacher });
    assert.equal(res.status, 422);
  });

  test('applying creates a worksheet as a draft, never published', async () => {
    const res = await api.post(`/api/imports/${importId}/apply`, {}, { cookie: teacher });
    assert.equal(res.status, 200);
    assert.equal(res.body.questionCount, 4);

    const ws = await api.get(`/api/worksheets/${res.body.worksheetId}`, { cookie: teacher });
    assert.equal(ws.body.worksheet.status, 'draft', 'students must not see it until the teacher publishes');
    assert.equal(ws.body.worksheet.title, 'Renamed by the teacher');
    assert.equal(ws.body.worksheet.datasetEngine, 'mongodb');
    assert.equal(ws.body.worksheet.questions.length, 4);

    // The verified questions carry computed expectations; the others carry none.
    assert.equal(ws.body.worksheet.questions[0].testCases.length, 1);
    assert.equal(ws.body.worksheet.questions[2].testCases.length, 0, 'open-ended');
    assert.equal(ws.body.worksheet.questions[3].testCases.length, 0, 'broken reference solution');
  });

  test('the computed expectation actually grades a student correctly', async () => {
    // The proof the whole feature rests on: an expectation produced by running
    // the reference solution must accept a correct student answer and reject a
    // wrong one.
    const applied = await api.get(`/api/imports/${importId}`, { cookie: teacher });
    const ws = await api.get(`/api/worksheets/${applied.body.import.worksheetId}`, { cookie: teacher });
    await api.post(`/api/worksheets/${ws.body.worksheet.id}/publish`, {}, { cookie: teacher });
    const questionId = ws.body.worksheet.questions[0].id;

    const right = await api.post(`/api/questions/${questionId}/run`,
      { language: 'mongodb', code: "db.book.find({ available: 'Y' }, { _id: 0, title: 1 })" },
      { cookie: student });
    assert.equal(right.body.result.verdict, 'passed', JSON.stringify(right.body.result?.cases?.[0]));

    const wrong = await api.post(`/api/questions/${questionId}/run`,
      { language: 'mongodb', code: 'db.book.find({}, { _id: 0, title: 1 })' },
      { cookie: student });
    assert.equal(wrong.body.result.verdict, 'failed');
  });

  test('an import cannot be applied twice', async () => {
    const res = await api.post(`/api/imports/${importId}/apply`, {}, { cookie: teacher });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /already been turned into a worksheet/);
  });
});
