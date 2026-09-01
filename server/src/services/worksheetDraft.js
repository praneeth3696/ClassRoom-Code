import { z } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { DATABASE_LANGUAGE_IDS, LANGUAGE_IDS, kindOfLanguageSet } from '../lib/languages.js';

/**
 * Drafts a worksheet from the text of a problem sheet.
 *
 * The model is asked for structure and for a *reference solution* per question.
 * It is deliberately never asked what a question's expected output is: a model
 * asked "what does this query return?" produces something plausible, and when
 * that is wrong a student who wrote a correct answer is marked wrong with no
 * way to argue. Expected outputs are computed instead by running the reference
 * solution against the real engine (see `draftSolver.js`).
 *
 * The draft is a proposal. It reaches students only after a teacher reviews it.
 */

const testInputSchema = z.object({
  label: z.string().max(120).describe('Short name for this case, e.g. "handles negatives".'),
  input: z.string().max(20_000).describe(
    'For a program question: the stdin fed to the program. '
    + 'For a database question: an optional verification query run AFTER the student script, '
    + 'used when the question asks the student to create or insert something. Empty otherwise.',
  ),
});

const draftQuestionSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).describe(
    'What the student must do, as an instruction. State the exact input and output format. '
    + 'Do not include the answer.',
  ),
  referenceNotes: z.string().max(20_000).nullable().describe(
    'Hints, textbook sections or reminders taken from the sheet. Null if the sheet gives none.',
  ),
  allowedLanguages: z.array(z.enum(LANGUAGE_IDS)).min(1).describe(
    'All entries must be program languages (c, cpp, java, python) OR database engines '
    + '(sqlite, postgres, oracle, mongodb) - never a mix, because the two are judged differently.',
  ),
  points: z.number().min(0).max(100).nullable(),
  setupScript: z.string().max(50_000).nullable().describe(
    'Database questions only: extra schema or seed data this question alone needs, run after the '
    + 'worksheet dataset. Null when the shared dataset is enough, which is the usual case.',
  ),
  orderedComparison: z.boolean().describe(
    'True only when the question is specifically about ORDER BY or $sort. A query without an '
    + 'explicit ordering requirement has no defined row order, so this must be false for it.',
  ),
  autoGradable: z.boolean().describe(
    'False for questions a teacher must read - "explain your approach", "comment on your method", '
    + 'design questions, anything with no single checkable answer. These get no test cases.',
  ),
  referenceSolution: z.string().max(50_000).describe(
    'A correct, complete answer to this question, in the first of allowedLanguages. This is run to '
    + 'compute the expected output, so it must be runnable as-is against the dataset. '
    + 'Empty string when autoGradable is false.',
  ),
  testInputs: z.array(testInputSchema).max(20).describe(
    'Empty when autoGradable is false. For program questions, one entry per case covering normal, '
    + 'boundary and negative inputs. For database questions, usually a single entry with an empty '
    + 'input, or one verification query when the student is asked to create something.',
  ),
});

const computedTestCaseSchema = z.object({
  label: z.string().max(120).nullable().optional(),
  input: z.string().max(64_000).default(''),
  expectedOutput: z.string().max(64_000).default(''),
});

const draftSchema = z.object({
  title: z.string().min(2).max(300).describe('Worksheet title, taken from the sheet where it has one.'),
  description: z.string().max(20_000).nullable(),
  datasetEngine: z.enum(DATABASE_LANGUAGE_IDS).nullable().describe(
    'The database engine for this worksheet, or null for a programming worksheet. '
    + 'Use oracle only when the sheet needs Oracle-specific features: object types, VARRAY, '
    + 'nested tables, REF or type inheritance. Prefer postgres for composite types and arrays.',
  ),
  datasetScript: z.string().max(200_000).nullable().describe(
    'The schema and seed data every database question runs against. When the sheet describes the '
    + 'entities but gives no sample data, invent a small, realistic dataset that makes every '
    + 'question answerable and produces interesting results - not all-empty, not all-identical. '
    + 'Null for a programming worksheet.',
  ),
  questions: z.array(draftQuestionSchema).min(1).max(60),
  notesForTeacher: z.array(z.string().max(500)).max(20).describe(
    'Anything you had to guess, could not express, or that needs the teacher to decide. '
    + 'Be specific and name the question.',
  ),
});

/**
 * The shape of a *stored* draft, which is the model's output plus the expected
 * outputs the solver computed by running the reference solutions.
 *
 * This is deliberately a different schema from the one the model is constrained
 * to: `testCases` must never be something the model can fill in, but it must
 * survive a teacher editing and re-saving the draft. Validating a stored draft
 * against the model's schema silently dropped every computed expectation.
 */
const storedDraftSchema = draftSchema.extend({
  questions: z.array(draftQuestionSchema.extend({
    testCases: z.array(computedTestCaseSchema).max(50).optional().default([]),
  })).min(1).max(60),
});

const SYSTEM_PROMPT = `You convert a lab problem sheet into a structured worksheet for a coding
platform used by a college computer science department.

The platform runs student answers automatically:
- Program questions (C, C++, Java, Python) are judged on what the program prints for a given stdin.
- Database questions (SQLite, PostgreSQL, Oracle, MongoDB) are judged on the rows a script returns.

Rules that matter:

1. Never state what a question's expected output is. You supply a reference solution and the
   platform runs it to find out. Inventing an expected result would mark correct students wrong.

2. Reference solutions must actually run against the dataset you supply. Use the exact collection,
   table and field names from your own datasetScript. This is the single most important thing you
   produce: if it does not run, the question cannot be auto-graded.

3. A question's languages are all program languages or all database engines, never both.

4. Mark a question autoGradable: false when it has no single checkable answer - "explain your
   approach", "comment on your method", "design a schema and justify it". Give those an empty
   reference solution and no test inputs. Do not force them into a test case.

5. Where a sheet describes entities without giving data, invent a small realistic dataset. Aim for
   the smallest data that still makes every question produce a distinguishable, non-trivial result.
   A question whose answer is an empty set teaches nothing.

6. Keep the teacher's wording where it is already clear. Tidy it into an instruction, state the
   exact input and output format, but do not invent new requirements or extra questions.

7. Put anything you guessed or could not represent into notesForTeacher, naming the question.`;

export function isConfigured() {
  return Boolean(config.ai.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Validates a stored draft - the model's output plus any computed expectations.
 * Use this for anything read back from the database or edited by a teacher.
 */
export function validateDraft(draft) {
  const result = storedDraftSchema.safeParse(draft);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    }));
    throw new HttpError(422, 'The generated worksheet did not match the expected shape', details);
  }

  const value = result.data;
  for (const [i, q] of value.questions.entries()) {
    if (kindOfLanguageSet(q.allowedLanguages) === null) {
      throw new HttpError(422, `Question ${i + 1} ("${q.title}") mixes program languages with database engines`);
    }
  }
  return value;
}

function buildUserContent({ text, pdf }) {
  const instruction = 'Convert this lab problem sheet into a worksheet. '
    + 'Follow every rule in the system prompt, especially the one about not stating expected outputs.';

  if (pdf) {
    // The API reads PDF natively, which keeps layout that text extraction flattens.
    return [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } },
      { type: 'text', text: instruction },
    ];
  }
  return [{ type: 'text', text: `${instruction}\n\n<problem_sheet>\n${text}\n</problem_sheet>` }];
}

/**
 * Asks Claude to draft the worksheet.
 *
 * Uses structured outputs so the response is constrained to the schema above -
 * the same shape the seed loader already validates, so a draft can be applied
 * without a translation step.
 */
export async function draftWorksheet({ text, pdf, signal }) {
  if (!isConfigured()) {
    throw new HttpError(
      503,
      'Worksheet import needs an Anthropic API key. Set ANTHROPIC_API_KEY on the server, '
      + 'or add the questions by hand with "New worksheet".',
      undefined,
      { expose: true },
    );
  }

  const [{ default: Anthropic }, { zodOutputFormat }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('@anthropic-ai/sdk/helpers/zod'),
  ]);

  const client = new Anthropic({
    ...(config.ai.apiKey ? { apiKey: config.ai.apiKey } : {}),
    maxRetries: 2,
  });

  let response;
  try {
    response = await client.messages.parse({
      model: config.ai.model,
      // Generous, because a worksheet with a dataset and twenty reference
      // solutions is a long output and truncation loses the whole draft. The
      // TypeScript SDK scales its own timeout up for large max_tokens.
      max_tokens: 32000,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserContent({ text, pdf }) }],
      output_config: { format: zodOutputFormat(draftSchema) },
    }, { signal });
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      throw new HttpError(502, 'The Anthropic API rejected the server credentials.');
    }
    if (err?.status === 429) {
      throw new HttpError(503, 'The Anthropic API is rate limiting this server. Try again shortly.');
    }
    throw new HttpError(502, `Worksheet import failed: ${err?.message ?? String(err)}`);
  }

  if (response.stop_reason === 'max_tokens') {
    throw new HttpError(
      502,
      'The problem sheet produced more than one response could hold. Split it into two documents '
      + 'and import them separately.',
    );
  }
  if (response.stop_reason === 'refusal') {
    throw new HttpError(502, 'The model declined to process this document.');
  }
  if (!response.parsed_output) {
    throw new HttpError(502, 'The model returned a response that did not parse as a worksheet.');
  }

  return {
    draft: validateDraft(response.parsed_output),
    model: response.model,
    usage: {
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    },
  };
}

export const _schemas = { draftSchema, storedDraftSchema, draftQuestionSchema };
