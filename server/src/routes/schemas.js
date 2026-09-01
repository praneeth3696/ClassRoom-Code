import { z } from 'zod';
import { DATABASE_LANGUAGE_IDS, LANGUAGE_IDS, kindOfLanguageSet } from '../lib/languages.js';

export const testCaseSchema = z.object({
  label: z.string().trim().max(120).optional().nullable(),
  input: z.string().max(64_000).default(''),
  expectedOutput: z.string().max(64_000).default(''),
});

const questionBaseSchema = z.object({
  title: z.string().trim().min(1, 'A question needs a title').max(300),
  description: z.string().max(20_000).default(''),
  referenceNotes: z.string().max(20_000).optional().nullable(),
  // Not every question has test cases — open-ended and SQL-style ones do not
  // (SPEC.md §7). An empty array is valid and means "teacher-graded only".
  allowedLanguages: z
    .array(z.enum(LANGUAGE_IDS))
    .min(1, 'Choose at least one language')
    .max(LANGUAGE_IDS.length),
  points: z.number().min(0).max(1000).optional().nullable(),
  // Database questions only: extra schema or seed data for this question alone,
  // run after the worksheet's shared dataset.
  setupScript: z.string().max(200_000).optional().nullable(),
  // Turn on when the question is about ORDER BY. Off by default, because a
  // query without ORDER BY has no defined row order.
  orderedComparison: z.boolean().optional(),
  testCases: z.array(testCaseSchema).max(50, 'At most 50 test cases per question').default([]),
});

// A question is judged either on stdout or on returned rows, so its languages
// cannot mix the two kinds.
const oneLanguageKind = {
  message: 'A question cannot mix program languages with database engines',
  path: ['allowedLanguages'],
};

export const questionInputSchema = questionBaseSchema.refine(
  (q) => kindOfLanguageSet(q.allowedLanguages) !== null,
  oneLanguageKind,
);

// An ISO date string, rejected if it is not a real instant.
const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Must be a valid date'));

export const worksheetCreateSchema = z.object({
  title: z.string().trim().min(2, 'A worksheet needs a title').max(300),
  description: z.string().max(20_000).optional().nullable(),
  deadline: isoDate.optional().nullable(),
  status: z.enum(['draft', 'published']).default('draft'),
  allowLateSubmissions: z.boolean().default(false),
  // The schema and seed data every database question on this worksheet runs
  // against, so twenty queries over one dataset do not each repeat it.
  datasetScript: z.string().max(500_000).optional().nullable(),
  datasetEngine: z.enum(DATABASE_LANGUAGE_IDS).optional().nullable(),
  questions: z.array(questionInputSchema).max(100).default([]),
});

export const worksheetUpdateSchema = z.object({
  title: z.string().trim().min(2).max(300).optional(),
  description: z.string().max(20_000).optional().nullable(),
  deadline: isoDate.optional().nullable(),
  allowLateSubmissions: z.boolean().optional(),
  datasetScript: z.string().max(500_000).optional().nullable(),
  datasetEngine: z.enum(DATABASE_LANGUAGE_IDS).optional().nullable(),
});

// Partial updates come from the base object, with the cross-field check
// re-applied only when the languages are actually being changed.
export const questionUpdateSchema = questionBaseSchema.partial().refine(
  (q) => q.allowedLanguages === undefined || kindOfLanguageSet(q.allowedLanguages) !== null,
  oneLanguageKind,
);

export const reorderSchema = z.object({
  questionIds: z.array(z.string().uuid()).min(1),
});
