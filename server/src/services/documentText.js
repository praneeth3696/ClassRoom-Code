import mammoth from 'mammoth';
import { badRequest } from '../lib/http.js';

/**
 * Turns an uploaded problem sheet into something a model can read.
 *
 * Word documents are converted through HTML rather than mammoth's markdown
 * output: the markdown converter escapes punctuation (`\(`, `\_`, `\-`), which
 * mangles the SQL and shell snippets these sheets are full of, and it drops
 * tables entirely. The lab command references are largely tables, so losing
 * them loses the document.
 *
 * PDFs are not extracted here at all - the Claude API reads PDF natively, and
 * handing it the original file preserves layout that any text extraction would
 * flatten.
 */

export const SUPPORTED_TYPES = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/pdf': 'pdf',
  'text/plain': 'text',
  'text/markdown': 'text',
};

export function detectType(filename, mimeType) {
  const byMime = SUPPORTED_TYPES[mimeType];
  if (byMime) return byMime;
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'docx') return 'docx';
  if (ext === 'doc') return 'doc';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'txt' || ext === 'md') return 'text';
  return null;
}

const BLOCK_TAGS = /<\/(p|div|h[1-6]|li|tr|table|thead|tbody)>/gi;

/** Decodes the handful of entities mammoth emits. */
function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Flattens mammoth's HTML to text, keeping table rows as pipe-separated lines
 * so a two-column "command | what it does" reference survives the conversion.
 */
export function htmlToText(html) {
  let text = String(html ?? '');

  text = text.replace(/<a id="[^"]*"><\/a>/g, '');

  // Tables get their own pass so that one row becomes one line. Doing it with
  // the generic block-tag rules instead leaves the cell separators stranded on
  // their own lines, and a "command | what it does" reference then reads as an
  // undifferentiated wall of text. Newlines inside a cell collapse to spaces:
  // a SQL statement on one line is still valid SQL and still readable, whereas
  // a row split across lines loses which cell each part belonged to.
  text = text.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_match, rowHtml) => {
    const cells = [...rowHtml.matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)].map(([, , cell]) =>
      decodeEntities(cell.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
    if (cells.every((c) => c === '')) return '\n';
    return `\n${cells.join(' | ')}\n`;
  });
  text = text.replace(/<\/?(table|thead|tbody)[^>]*>/gi, '\n');

  // Headings keep a marker so section structure survives.
  text = text.replace(/<h([1-6])[^>]*>/gi, (_m, level) => `\n${'#'.repeat(Number(level))} `);
  text = text.replace(/<li[^>]*>/gi, '\n- ');

  text = text.replace(BLOCK_TAGS, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n')
    .trim();
}

/**
 * Extracts text from an uploaded buffer.
 *
 * Returns `{ kind, text, warnings }` for anything text-shaped, or
 * `{ kind: 'pdf', text: null }` for a PDF, which the caller passes to the model
 * as a document block instead.
 */
export async function extractDocument({ buffer, filename, mimeType }) {
  const kind = detectType(filename, mimeType);
  if (!kind) {
    throw badRequest(
      `Unsupported file type. Upload a .docx, .pdf, .txt or .md problem sheet (received "${filename}").`,
    );
  }

  if (kind === 'pdf') {
    return { kind, text: null, warnings: [] };
  }

  if (kind === 'text') {
    return { kind, text: buffer.toString('utf8').trim(), warnings: [] };
  }

  if (kind === 'doc') {
    throw badRequest(
      'This is an old-format .doc file, which cannot be read directly. '
      + 'Open it in Word and save as .docx (or export a PDF), then upload that.',
    );
  }

  let result;
  try {
    result = await mammoth.convertToHtml({ buffer });
  } catch (err) {
    throw badRequest(`That Word file could not be read: ${err.message}`);
  }

  const text = htmlToText(result.value);
  if (!text) {
    throw badRequest('No text was found in that document. Is it a scan or an image-only file?');
  }

  // mammoth reports unconvertible elements; surface them so a teacher knows
  // if a diagram or embedded object was silently dropped.
  const warnings = (result.messages ?? [])
    .filter((m) => m.type === 'warning')
    .map((m) => m.message)
    .slice(0, 10);

  return { kind, text, warnings };
}
