import { many, one, transaction } from '../db/index.js';
import { badRequest, notFound } from '../lib/http.js';
import { extractDocument } from './documentText.js';
import { draftWorksheet, validateDraft } from './worksheetDraft.js';
import { solveDraft } from './draftSolver.js';
import { kindOfLanguageSet } from '../lib/languages.js';

/**
 * Orchestrates importing a worksheet from an uploaded problem sheet:
 * extract -> draft -> run the reference solutions -> teacher reviews -> apply.
 *
 * The draft lives in its own table rather than being written straight into
 * `worksheets`, so a half-finished or wrong import is never something students
 * can see. Only `applyImport` creates a worksheet, and it creates it as a draft.
 */

function shapeImport(row, { includeText = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    courseId: row.course_id,
    sourceName: row.source_name,
    sourceType: row.source_type,
    sourceBytes: row.source_bytes,
    status: row.status,
    draft: row.draft ?? null,
    solveReport: row.solve_report ?? null,
    error: row.error ?? null,
    model: row.model ?? null,
    usage: row.usage ?? null,
    worksheetId: row.worksheet_id ?? null,
    extractedText: includeText ? (row.extracted_text ?? null) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listImports(courseId) {
  const rows = await many(
    `SELECT id, course_id, source_name, source_type, source_bytes, status,
            worksheet_id, error, created_at, updated_at
     FROM worksheet_imports WHERE course_id = $1 ORDER BY created_at DESC LIMIT 25`,
    [courseId],
  );
  return rows.map((r) => shapeImport(r));
}

export async function getImport(importId, { includeText = false } = {}) {
  const row = await one('SELECT * FROM worksheet_imports WHERE id = $1', [importId]);
  if (!row) throw notFound('Import not found');
  return shapeImport(row, { includeText });
}

/** Needed for the permission check, before the caller is allowed to see anything. */
export async function loadImportCourse(importId) {
  const row = await one('SELECT id, course_id, status FROM worksheet_imports WHERE id = $1', [importId]);
  if (!row) throw notFound('Import not found');
  return row;
}

/**
 * Step one: store the upload and pull its text out.
 *
 * Extraction is separated from analysis so a teacher whose document produced
 * nothing useful finds out immediately, without spending an API call.
 */
export async function createImport({ courseId, user, file }) {
  const extracted = await extractDocument({
    buffer: file.buffer,
    filename: file.originalname,
    mimeType: file.mimetype,
  });

  const row = await one(
    `INSERT INTO worksheet_imports
       (course_id, created_by, source_name, source_type, source_bytes, extracted_text, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'extracted') RETURNING *`,
    [courseId, user.id, file.originalname, extracted.kind, file.size, extracted.text],
  );

  return {
    import: shapeImport(row, { includeText: true }),
    warnings: extracted.warnings,
  };
}

/**
 * Step two: draft the worksheet, then compute the expected outputs by running
 * the reference solutions.
 *
 * PDFs are re-read from the uploaded buffer because the model reads them
 * natively; everything else uses the text stored at extraction time.
 */
export async function analyzeImport({ importId, pdfBase64 = null }) {
  const row = await one('SELECT * FROM worksheet_imports WHERE id = $1', [importId]);
  if (!row) throw notFound('Import not found');
  if (row.status === 'applied') throw badRequest('This import has already been turned into a worksheet');
  if (row.source_type === 'pdf' && !pdfBase64) {
    throw badRequest('Re-upload the PDF to analyse it: PDFs are read by the model directly and are not stored.');
  }

  await one("UPDATE worksheet_imports SET status = 'analyzing', error = NULL, updated_at = now() WHERE id = $1 RETURNING id", [importId]);

  try {
    const { draft, model, usage } = await draftWorksheet({
      text: row.extracted_text,
      pdf: pdfBase64,
    });

    // Nothing the model said about results is believed; every expectation here
    // is the output of a real run.
    const { draft: solved, report } = await solveDraft(draft);

    const updated = await one(
      `UPDATE worksheet_imports
       SET draft = $2, solve_report = $3, model = $4, usage = $5, status = 'drafted',
           error = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [importId, JSON.stringify(solved), JSON.stringify(report), model, JSON.stringify(usage)],
    );
    return shapeImport(updated);
  } catch (err) {
    await one(
      "UPDATE worksheet_imports SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 RETURNING id",
      [importId, err.message?.slice(0, 2000) ?? String(err)],
    );
    throw err;
  }
}

/** Saves the teacher's edits to a draft. */
export async function updateDraft(importId, draft) {
  const validated = validateDraft(draft);
  const row = await one(
    `UPDATE worksheet_imports SET draft = $2, updated_at = now()
     WHERE id = $1 AND status <> 'applied' RETURNING *`,
    [importId, JSON.stringify(validated)],
  );
  if (!row) throw badRequest('This import has already been turned into a worksheet');
  return shapeImport(row);
}

/** Re-runs the reference solutions after the teacher has edited the draft. */
export async function resolveDraft(importId) {
  const row = await one('SELECT * FROM worksheet_imports WHERE id = $1', [importId]);
  if (!row) throw notFound('Import not found');
  if (!row.draft) throw badRequest('This import has no draft yet');

  const { draft, report } = await solveDraft(validateDraft(row.draft));
  const updated = await one(
    `UPDATE worksheet_imports SET draft = $2, solve_report = $3, status = 'drafted', updated_at = now()
     WHERE id = $1 RETURNING *`,
    [importId, JSON.stringify(draft), JSON.stringify(report)],
  );
  return shapeImport(updated);
}

/**
 * Step three: turn the reviewed draft into a real worksheet.
 *
 * The worksheet is always created as a draft, never published: the teacher
 * publishes it themselves once they have looked at it in the normal editor.
 */
export async function applyImport({ importId, user }) {
  const row = await one('SELECT * FROM worksheet_imports WHERE id = $1', [importId]);
  if (!row) throw notFound('Import not found');
  if (row.status === 'applied') throw badRequest('This import has already been turned into a worksheet');
  if (!row.draft) throw badRequest('Analyse the document before creating a worksheet from it');

  const draft = validateDraft(row.draft);

  return transaction(async (tx) => {
    const { rows: wsRows } = await tx.query(
      `INSERT INTO worksheets
         (course_id, title, description, status, allow_late_submissions,
          dataset_script, dataset_engine, created_by)
       VALUES ($1, $2, $3, 'draft', false, $4, $5, $6) RETURNING id`,
      [
        row.course_id,
        draft.title,
        draft.description ?? null,
        draft.datasetScript ?? null,
        draft.datasetEngine ?? null,
        user.id,
      ],
    );
    const worksheetId = wsRows[0].id;

    let position = 0;
    for (const q of draft.questions) {
      const kind = kindOfLanguageSet(q.allowedLanguages) === 'database' ? 'database' : 'program';
      const { rows: qRows } = await tx.query(
        `INSERT INTO questions
           (worksheet_id, position, title, description, reference_notes, allowed_languages,
            points, kind, setup_script, ordered_comparison)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          worksheetId, position, q.title, q.description, q.referenceNotes ?? null,
          q.allowedLanguages, q.points ?? null, kind, q.setupScript ?? null,
          Boolean(q.orderedComparison),
        ],
      );
      position += 1;

      let tcPosition = 0;
      for (const tc of q.testCases ?? []) {
        await tx.query(
          `INSERT INTO test_cases (question_id, position, label, input, expected_output)
           VALUES ($1, $2, $3, $4, $5)`,
          [qRows[0].id, tcPosition, tc.label ?? null, tc.input ?? '', tc.expectedOutput ?? ''],
        );
        tcPosition += 1;
      }
    }

    await tx.query(
      "UPDATE worksheet_imports SET status = 'applied', worksheet_id = $2, updated_at = now() WHERE id = $1",
      [importId, worksheetId],
    );

    return { worksheetId, questionCount: draft.questions.length };
  });
}
