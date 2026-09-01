-- Phase 9: building a worksheet from an uploaded problem sheet.
--
-- A teacher uploads the .docx or .pdf they already hand out, the platform
-- extracts its text, a model drafts the worksheet structure, and the platform
-- computes the expected outputs by *running* a reference solution against the
-- real engine. The draft is stored here so the teacher can review and edit it
-- before it becomes a real worksheet - nothing reaches students unreviewed.

CREATE TABLE worksheet_imports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id      uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,

  source_name    text NOT NULL,
  source_type    text NOT NULL,
  source_bytes   integer NOT NULL DEFAULT 0,
  -- What the extractor pulled out of the document, kept so a teacher can see
  -- what the model was actually given when a draft looks wrong.
  extracted_text text,

  status         text NOT NULL DEFAULT 'extracted'
                 CHECK (status IN ('extracted', 'analyzing', 'drafted', 'failed', 'applied')),
  -- The draft worksheet, in the same shape the seed loader accepts.
  draft          jsonb,
  -- Per-question outcome of running the reference solutions.
  solve_report   jsonb,
  error          text,

  model          text,
  usage          jsonb,

  -- Set once the draft has been turned into a real worksheet.
  worksheet_id   uuid REFERENCES worksheets(id) ON DELETE SET NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX worksheet_imports_course_idx ON worksheet_imports (course_id, created_at DESC);
