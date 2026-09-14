/**
 * A strict RFC 4180 parser for asserting on exported CSV in tests: quoted fields,
 * doubled quotes, embedded commas and newlines. Strips a leading UTF-8 BOM.
 */
export function parseCsv(text) {
  const input = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r' && input[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
