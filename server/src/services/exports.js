import { many, one } from '../db/index.js';
import { notFound } from '../lib/http.js';

/**
 * A worksheet's results as CSV, for the marks spreadsheet a department already
 * keeps (QUESTIONS.md #10): one row per enrolled student, a result and a marks
 * column per question, and totals.
 */

// Spreadsheets evaluate a cell that starts with one of these as a formula, so a
// student named `=HYPERLINK(...)` could otherwise run one on the teacher's
// machine (CSV injection). A leading apostrophe makes it plain text.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const formatNumber = (n) => String(Number(n));

/** A safe ASCII filename for Content-Disposition. */
export function csvFilename(title) {
  const base = String(title ?? '')
    .replace(/"/g, '')
    .replace(/[\\/:*?<>|]+/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || 'worksheet'}.csv`;
}

function resultLabel(row) {
  if (!row || row.status !== 'submitted') return 'not submitted';
  if (row.auto_passed === true) return 'passed';
  if (row.auto_passed === false) return 'failed';
  return 'teacher-graded';
}

export async function exportWorksheetCsv(worksheetId) {
  const worksheet = await one('SELECT id, title, course_id FROM worksheets WHERE id = $1', [worksheetId]);
  if (!worksheet) throw notFound('Worksheet not found');

  const [questions, students, submissions] = await Promise.all([
    many(
      'SELECT id, title, points FROM questions WHERE worksheet_id = $1 ORDER BY position, created_at',
      [worksheetId],
    ),
    many(
      `SELECT u.id, u.name, u.email, u.roll_number
       FROM course_enrollments ce JOIN users u ON u.id = ce.user_id
       WHERE ce.course_id = $1
       ORDER BY u.roll_number NULLS LAST, u.name`,
      [worksheet.course_id],
    ),
    many(
      `SELECT s.question_id, s.student_id, s.status, s.auto_passed, f.marks,
              coalesce((SELECT r.late FROM submission_revisions r
                        WHERE r.submission_id = s.id ORDER BY r.revision DESC LIMIT 1), false) AS late
       FROM submissions s
       JOIN questions q ON q.id = s.question_id
       LEFT JOIN feedback f ON f.submission_id = s.id
       WHERE q.worksheet_id = $1`,
      [worksheetId],
    ),
  ]);

  const byStudentQuestion = new Map(submissions.map((s) => [`${s.student_id}:${s.question_id}`, s]));
  const totalPoints = questions.reduce((sum, q) => sum + (q.points === null ? 0 : Number(q.points)), 0);
  const outOf = (points) => (points === null || points === undefined ? '' : ` (/${formatNumber(points)})`);

  const header = ['Student', 'Email', 'Roll number'];
  questions.forEach((q, i) => {
    header.push(`Q${i + 1} ${q.title}: result`, `Q${i + 1} ${q.title}: marks${outOf(q.points)}`);
  });
  header.push(`Total marks${totalPoints > 0 ? outOf(totalPoints) : ''}`, 'Late submissions');

  const rows = students.map((student) => {
    let total = 0;
    let late = 0;
    const cells = [student.name, student.email, student.roll_number ?? ''];
    for (const q of questions) {
      const row = byStudentQuestion.get(`${student.id}:${q.id}`);
      cells.push(resultLabel(row));
      const marks = row?.status === 'submitted' && row.marks !== null && row.marks !== undefined ? Number(row.marks) : null;
      cells.push(marks === null ? '' : marks);
      if (marks !== null) total += marks;
      if (row?.status === 'submitted' && row.late) late += 1;
    }
    cells.push(total, late);
    return cells;
  });

  const lines = [header, ...rows].map((cells) => cells.map(csvCell).join(','));
  // The BOM makes Excel read the file as UTF-8, so names are not garbled.
  return { filename: csvFilename(worksheet.title), csv: `﻿${lines.join('\r\n')}\r\n` };
}
