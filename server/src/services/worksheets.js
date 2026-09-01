import { many, one, query, transaction } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { isSupportedLanguage, kindOfLanguageSet } from '../lib/languages.js';
import { submissionWindow } from './access.js';

function shapeWorksheet(row, { forStudent = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    description: row.description ?? null,
    deadline: row.deadline ?? null,
    status: row.status,
    allowLateSubmissions: row.allow_late_submissions,
    datasetScript: row.dataset_script ?? null,
    datasetEngine: row.dataset_engine ?? null,
    publishedAt: row.published_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    questionCount: row.question_count ?? undefined,
  };
  if (forStudent) {
    const window = submissionWindow(row);
    out.submissionOpen = window.open;
    out.submissionClosedReason = window.reason;
  }
  return out;
}

function shapeQuestion(row, testCases = []) {
  return {
    id: row.id,
    worksheetId: row.worksheet_id,
    position: row.position,
    title: row.title,
    description: row.description,
    referenceNotes: row.reference_notes ?? null,
    allowedLanguages: row.allowed_languages ?? [],
    kind: row.kind ?? 'program',
    setupScript: row.setup_script ?? null,
    orderedComparison: row.ordered_comparison ?? false,
    points: row.points === null || row.points === undefined ? null : Number(row.points),
    testCases: testCases.map((tc) => ({
      id: tc.id,
      position: tc.position,
      label: tc.label ?? null,
      input: tc.input,
      expectedOutput: tc.expected_output,
    })),
  };
}

export async function listWorksheets(courseId, user) {
  const studentOnly = user.role === 'student' ? "AND w.status = 'published'" : '';
  const rows = await many(
    `SELECT w.*, (SELECT count(*)::int FROM questions q WHERE q.worksheet_id = w.id) AS question_count
     FROM worksheets w
     WHERE w.course_id = $1 ${studentOnly}
     ORDER BY w.deadline NULLS LAST, w.created_at DESC`,
    [courseId],
  );
  return rows.map((r) => shapeWorksheet(r, { forStudent: user.role === 'student' }));
}

export async function getWorksheetDetail(worksheetId, user) {
  const worksheet = await one('SELECT * FROM worksheets WHERE id = $1', [worksheetId]);
  if (!worksheet) throw notFound('Worksheet not found');

  const questions = await many(
    'SELECT * FROM questions WHERE worksheet_id = $1 ORDER BY position, created_at',
    [worksheetId],
  );
  const ids = questions.map((q) => q.id);
  const testCases = ids.length
    ? await many('SELECT * FROM test_cases WHERE question_id = ANY($1) ORDER BY position, created_at', [ids])
    : [];
  const byQuestion = new Map();
  for (const tc of testCases) {
    if (!byQuestion.has(tc.question_id)) byQuestion.set(tc.question_id, []);
    byQuestion.get(tc.question_id).push(tc);
  }

  const detail = shapeWorksheet(worksheet, { forStudent: user.role === 'student' });
  detail.questions = questions.map((q) => shapeQuestion(q, byQuestion.get(q.id) ?? []));
  return detail;
}

function validateLanguages(languages, questionTitle) {
  const langs = [...new Set((languages || []).map((l) => String(l).toLowerCase()))];
  if (langs.length === 0) {
    throw badRequest(`Question "${questionTitle}" must allow at least one language`);
  }
  const bad = langs.filter((l) => !isSupportedLanguage(l));
  if (bad.length) {
    throw badRequest(`Question "${questionTitle}" lists unsupported language(s): ${bad.join(', ')}`);
  }
  if (kindOfLanguageSet(langs) === null) {
    throw badRequest(
      `Question "${questionTitle}" mixes program languages with database engines. `
      + 'They are judged differently, so a question must use one or the other.',
    );
  }
  return langs;
}

/** Whether a question is judged on stdout or on returned rows. */
function kindFor(languages) {
  return kindOfLanguageSet(languages) === 'database' ? 'database' : 'program';
}

async function insertQuestion(tx, worksheetId, question, position) {
  const langs = validateLanguages(question.allowedLanguages, question.title);
  const { rows } = await tx.query(
    `INSERT INTO questions
       (worksheet_id, position, title, description, reference_notes, allowed_languages,
        points, kind, setup_script, ordered_comparison)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      worksheetId,
      position,
      question.title,
      question.description ?? '',
      question.referenceNotes ?? null,
      langs,
      question.points ?? null,
      kindFor(langs),
      question.setupScript ?? null,
      Boolean(question.orderedComparison),
    ],
  );
  const row = rows[0];
  await replaceTestCases(tx, row.id, question.testCases ?? []);
  return row;
}

async function replaceTestCases(tx, questionId, testCases) {
  await tx.query('DELETE FROM test_cases WHERE question_id = $1', [questionId]);
  let position = 0;
  for (const tc of testCases) {
    await tx.query(
      `INSERT INTO test_cases (question_id, position, label, input, expected_output)
       VALUES ($1, $2, $3, $4, $5)`,
      [questionId, position++, tc.label ?? null, tc.input ?? '', tc.expectedOutput ?? ''],
    );
  }
}

export async function createWorksheet(courseId, body, creator) {
  return transaction(async (tx) => {
    const status = body.status === 'published' ? 'published' : 'draft';
    const { rows } = await tx.query(
      `INSERT INTO worksheets
         (course_id, title, description, deadline, status, allow_late_submissions,
          dataset_script, dataset_engine, created_by, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $5 = 'published' THEN now() ELSE NULL END)
       RETURNING *`,
      [
        courseId,
        body.title,
        body.description ?? null,
        body.deadline ?? null,
        status,
        Boolean(body.allowLateSubmissions),
        body.datasetScript ?? null,
        body.datasetEngine ?? null,
        creator.id,
      ],
    );
    const worksheet = rows[0];
    let position = 0;
    for (const question of body.questions ?? []) {
      await insertQuestion(tx, worksheet.id, question, position++);
    }
    return worksheet.id;
  });
}

const WORKSHEET_COLUMNS = {
  title: 'title',
  description: 'description',
  deadline: 'deadline',
  allowLateSubmissions: 'allow_late_submissions',
  datasetScript: 'dataset_script',
  datasetEngine: 'dataset_engine',
};

export async function updateWorksheet(worksheetId, patch) {
  const fields = [];
  const values = [worksheetId];
  for (const [key, column] of Object.entries(WORKSHEET_COLUMNS)) {
    if (patch[key] === undefined) continue;
    values.push(patch[key]);
    fields.push(`${column} = $${values.length}`);
  }
  if (fields.length === 0) return;
  const row = await one(
    `UPDATE worksheets SET ${fields.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`,
    values,
  );
  if (!row) throw notFound('Worksheet not found');
}

export async function setWorksheetStatus(worksheetId, status) {
  if (status === 'published') {
    const counts = await one(
      'SELECT count(*)::int AS n FROM questions WHERE worksheet_id = $1',
      [worksheetId],
    );
    if (counts.n === 0) {
      throw badRequest('A worksheet needs at least one question before it can be published');
    }
  }
  const row = await one(
    `UPDATE worksheets
     SET status = $2,
         published_at = CASE WHEN $2 = 'published' THEN coalesce(published_at, now()) ELSE published_at END,
         updated_at = now()
     WHERE id = $1 RETURNING id, status`,
    [worksheetId, status],
  );
  if (!row) throw notFound('Worksheet not found');
  return row;
}

async function countSubmissions(worksheetId) {
  const row = await one(
    `SELECT count(*)::int AS n FROM submissions s
     JOIN questions q ON q.id = s.question_id
     WHERE q.worksheet_id = $1`,
    [worksheetId],
  );
  return row.n;
}

/**
 * Deleting a worksheet cascades to its questions, test cases and every
 * submission against them. Student work is not discarded on a single click:
 * the caller has to pass `force` once told what would be lost.
 */
export async function deleteWorksheet(worksheetId, { force = false } = {}) {
  const submissions = await countSubmissions(worksheetId);
  if (submissions > 0 && !force) {
    throw conflict(
      `This worksheet has ${submissions} student submission(s), which would be deleted with it. ` +
        'Re-send with ?force=true to confirm, or unpublish it instead to hide it from students.',
    );
  }
  const res = await query('DELETE FROM worksheets WHERE id = $1', [worksheetId]);
  if (res.rowCount === 0) throw notFound('Worksheet not found');
  return { deletedSubmissions: submissions };
}

export async function addQuestion(worksheetId, question) {
  return transaction(async (tx) => {
    const { rows } = await tx.query(
      'SELECT coalesce(max(position), -1) + 1 AS next FROM questions WHERE worksheet_id = $1',
      [worksheetId],
    );
    const row = await insertQuestion(tx, worksheetId, question, rows[0].next);
    return row.id;
  });
}

const QUESTION_COLUMNS = {
  title: 'title',
  description: 'description',
  referenceNotes: 'reference_notes',
  points: 'points',
  setupScript: 'setup_script',
  orderedComparison: 'ordered_comparison',
};

export async function updateQuestion(questionId, patch) {
  return transaction(async (tx) => {
    const fields = [];
    const values = [questionId];
    for (const [key, column] of Object.entries(QUESTION_COLUMNS)) {
      if (patch[key] === undefined) continue;
      values.push(patch[key]);
      fields.push(`${column} = $${values.length}`);
    }
    if (patch.allowedLanguages !== undefined) {
      const current = await tx.query('SELECT title FROM questions WHERE id = $1', [questionId]);
      if (!current.rows[0]) throw notFound('Question not found');
      const langs = validateLanguages(patch.allowedLanguages, patch.title ?? current.rows[0].title);
      values.push(langs);
      fields.push(`allowed_languages = $${values.length}`);
      // The kind follows the languages, so switching a question from C to SQL
      // switches how it is judged.
      values.push(kindFor(langs));
      fields.push(`kind = $${values.length}`);
    }
    if (fields.length) {
      const { rows } = await tx.query(
        `UPDATE questions SET ${fields.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id`,
        values,
      );
      if (!rows[0]) throw notFound('Question not found');
    }
    if (patch.testCases !== undefined) {
      await replaceTestCases(tx, questionId, patch.testCases);
    }
  });
}

export async function deleteQuestion(questionId, { force = false } = {}) {
  const row = await one('SELECT count(*)::int AS n FROM submissions WHERE question_id = $1', [questionId]);
  if (row.n > 0 && !force) {
    throw conflict(
      `This question has ${row.n} student submission(s), which would be deleted with it. Re-send with ?force=true to confirm.`,
    );
  }
  const res = await query('DELETE FROM questions WHERE id = $1', [questionId]);
  if (res.rowCount === 0) throw notFound('Question not found');
  return { deletedSubmissions: row.n };
}

/** Reorders questions within a worksheet. The id list must be the full set. */
export async function reorderQuestions(worksheetId, orderedIds) {
  return transaction(async (tx) => {
    const { rows } = await tx.query('SELECT id FROM questions WHERE worksheet_id = $1', [worksheetId]);
    const existing = new Set(rows.map((r) => r.id));
    if (existing.size !== orderedIds.length || orderedIds.some((id) => !existing.has(id))) {
      throw badRequest('The reorder list must contain every question in this worksheet exactly once');
    }
    let position = 0;
    for (const id of orderedIds) {
      await tx.query('UPDATE questions SET position = $2, updated_at = now() WHERE id = $1', [id, position++]);
    }
  });
}
