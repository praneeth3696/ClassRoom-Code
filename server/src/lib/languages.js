/**
 * Everything a student can write an answer in.
 *
 * Two kinds, because they are judged differently:
 *
 *   - `program`  — source code run against stdin, compared on stdout.
 *                  C, C++, Java, Python (SPEC.md §9).
 *   - `database` — a script run against a seeded database, compared on the
 *                  result set it produces. SQL and the MongoDB shell.
 *
 * `judge0Id` values are the well-known Judge0 CE ids for program languages,
 * used as a fallback only: the Judge0 client resolves real ids from the
 * instance's own /languages endpoint, since a self-hosted instance may differ.
 */
export const LANGUAGES = [
  // --- Programs -------------------------------------------------------------
  {
    id: 'c',
    kind: 'program',
    label: 'C',
    judge0Id: 50,
    judge0Match: /^c\b(?!\+\+)/i,
    monaco: 'c',
    extension: 'c',
    sample: '#include <stdio.h>\n\nint main(void) {\n    printf("Hello\\n");\n    return 0;\n}\n',
  },
  {
    id: 'cpp',
    kind: 'program',
    label: 'C++',
    judge0Id: 54,
    judge0Match: /^c\+\+/i,
    monaco: 'cpp',
    extension: 'cpp',
    sample: '#include <iostream>\n\nint main() {\n    std::cout << "Hello" << std::endl;\n    return 0;\n}\n',
  },
  {
    id: 'java',
    kind: 'program',
    label: 'Java',
    judge0Id: 62,
    judge0Match: /^java\b/i,
    monaco: 'java',
    extension: 'java',
    sample: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello");\n    }\n}\n',
  },
  {
    id: 'python',
    kind: 'program',
    label: 'Python',
    judge0Id: 71,
    judge0Match: /^python\s*\(?3/i,
    monaco: 'python',
    extension: 'py',
    sample: 'print("Hello")\n',
  },

  // --- Databases ------------------------------------------------------------
  {
    id: 'sqlite',
    kind: 'database',
    label: 'SQL (SQLite)',
    engine: 'sqlite',
    monaco: 'sql',
    extension: 'sql',
    sample: '-- Write your SQL below.\nSELECT * FROM customer;\n',
    blurb: 'Standard SQL. Runs on SQLite — good for plain relational exercises.',
  },
  {
    id: 'postgres',
    kind: 'database',
    label: 'SQL (PostgreSQL)',
    engine: 'postgres',
    monaco: 'sql',
    extension: 'sql',
    sample: '-- Write your SQL below.\nSELECT * FROM customer;\n',
    blurb: 'PostgreSQL, which supports composite types and arrays — the closest '
      + 'engine available for object-relational exercises when Oracle is not connected.',
  },
  {
    id: 'oracle',
    kind: 'database',
    label: 'SQL (Oracle)',
    engine: 'oracle',
    monaco: 'sql',
    extension: 'sql',
    sample: '-- Write your PL/SQL/Oracle SQL below.\nSELECT * FROM customer;\n',
    blurb: 'Oracle Database — required for object types, VARRAY, nested tables and REF. '
      + 'Needs ORACLE_CONNECT_STRING to point at the department server.',
  },
  {
    id: 'mongodb',
    kind: 'database',
    label: 'MongoDB Shell',
    engine: 'mongodb',
    monaco: 'javascript',
    extension: 'js',
    sample: '// Write mongosh commands below.\ndb.book.find({});\n',
    blurb: 'Runs through mongosh against a real MongoDB, so aggregation pipelines, '
      + '$lookup and $unwind behave exactly as in the shell.',
  },
];

export const LANGUAGE_IDS = LANGUAGES.map((l) => l.id);
export const PROGRAM_LANGUAGE_IDS = LANGUAGES.filter((l) => l.kind === 'program').map((l) => l.id);
export const DATABASE_LANGUAGE_IDS = LANGUAGES.filter((l) => l.kind === 'database').map((l) => l.id);

export function getLanguage(id) {
  return LANGUAGES.find((l) => l.id === String(id || '').toLowerCase()) || null;
}

export function isSupportedLanguage(id) {
  return Boolean(getLanguage(id));
}

export function languageKind(id) {
  return getLanguage(id)?.kind ?? null;
}

export function isDatabaseLanguage(id) {
  return languageKind(id) === 'database';
}

/**
 * A question is either a program question or a database question — its
 * languages cannot mix the two, because the two are judged differently.
 * Returns the single kind, or null if the list is mixed or empty.
 */
export function kindOfLanguageSet(ids) {
  const kinds = new Set((ids || []).map(languageKind).filter(Boolean));
  if (kinds.size !== 1) return null;
  return [...kinds][0];
}

/** Shape sent to the frontend — no server-side matching internals. */
export function publicLanguages() {
  return LANGUAGES.map(({ id, kind, label, monaco, extension, sample, blurb }) => ({
    id, kind, label, monaco, extension, sample, blurb: blurb ?? null,
  }));
}
