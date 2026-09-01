import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { parseBody, wrap, badRequest } from '../lib/http.js';
import { requireAuth, requireTeacher } from '../middleware/auth.js';
import { assertCanTeachCourse } from '../services/access.js';
import {
  analyzeImport, applyImport, createImport, getImport,
  listImports, loadImportCourse, resolveDraft, updateDraft,
} from '../services/imports.js';
import { isConfigured } from '../services/worksheetDraft.js';

export const importsRouter = Router();
export const courseImportsRouter = Router({ mergeParams: true });

const uuid = z.string().uuid('Must be a valid id');

// Uploads are held in memory and discarded: the extracted text is what gets
// stored, not the original file.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.ai.maxUploadBytes, files: 1 },
});

/** Multer's own errors are not HttpErrors, so they need translating. */
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(badRequest(
        `That file is larger than the ${Math.round(config.ai.maxUploadBytes / 1024 / 1024)} MB limit.`,
      ));
    }
    return next(badRequest(err.message));
  });
}

async function assertCanEditImport(req) {
  const row = await loadImportCourse(uuid.parse(req.params.importId));
  await assertCanTeachCourse(req.user, row.course_id);
  return row;
}

// --- Per-course --------------------------------------------------------------

courseImportsRouter.get(
  '/',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanTeachCourse(req.user, courseId);
    res.json({ imports: await listImports(courseId), available: isConfigured() });
  }),
);

/** Step one: upload the problem sheet and extract its text. */
courseImportsRouter.post(
  '/',
  requireAuth,
  requireTeacher,
  handleUpload,
  wrap(async (req, res) => {
    const courseId = uuid.parse(req.params.courseId);
    await assertCanTeachCourse(req.user, courseId);
    if (!req.file) throw badRequest('Attach a problem sheet to upload.');
    const result = await createImport({ courseId, user: req.user, file: req.file });
    res.status(201).json(result);
  }),
);

// --- Per-import --------------------------------------------------------------

importsRouter.get(
  '/:importId',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    await assertCanEditImport(req);
    res.json({
      import: await getImport(req.params.importId, { includeText: req.query.text === 'true' }),
    });
  }),
);

const analyzeSchema = z.object({
  // PDFs are read by the model directly and are not stored, so re-analysing one
  // needs the file again.
  pdfBase64: z.string().max(30_000_000).optional().nullable(),
});

/** Step two: draft the worksheet, then run the reference solutions. */
importsRouter.post(
  '/:importId/analyze',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    await assertCanEditImport(req);
    const body = parseBody(analyzeSchema, req.body ?? {});
    res.json({ import: await analyzeImport({ importId: req.params.importId, pdfBase64: body.pdfBase64 ?? null }) });
  }),
);

importsRouter.patch(
  '/:importId',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    await assertCanEditImport(req);
    if (!req.body?.draft) throw badRequest('Send the edited draft as { draft: ... }');
    res.json({ import: await updateDraft(req.params.importId, req.body.draft) });
  }),
);

/** Re-runs the reference solutions after the teacher edits the draft. */
importsRouter.post(
  '/:importId/recheck',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    await assertCanEditImport(req);
    res.json({ import: await resolveDraft(req.params.importId) });
  }),
);

/** Step three: create the worksheet, as a draft for the teacher to publish. */
importsRouter.post(
  '/:importId/apply',
  requireAuth,
  requireTeacher,
  wrap(async (req, res) => {
    await assertCanEditImport(req);
    res.json(await applyImport({ importId: req.params.importId, user: req.user }));
  }),
);
