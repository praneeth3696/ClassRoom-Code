import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitSqlStatements, renderTable } from '../src/services/dbEngines/common.js';
import { canonicalRows, parseExpected, resultsMatch } from '../src/services/dbJudge.js';
import { runAgainstTestCases } from '../src/services/execution.js';
import { shutdownEngines } from '../src/services/dbEngines/index.js';
import { kindOfLanguageSet } from '../src/lib/languages.js';

test.after(async () => {
  await shutdownEngines();
});

describe('SQL statement splitting', () => {
  test('splits ordinary statements on semicolons', () => {
    const out = splitSqlStatements('SELECT 1; SELECT 2;\nSELECT 3');
    assert.deepEqual(out, ['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  test('ignores semicolons inside string literals', () => {
    const out = splitSqlStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;");
    assert.equal(out.length, 2);
    assert.match(out[0], /'a;b'/);
  });

  test('ignores semicolons inside comments', () => {
    const out = splitSqlStatements('-- a comment with ; in it\nSELECT 1;');
    assert.equal(out.length, 1);
  });

  test('handles an escaped quote inside a literal', () => {
    const out = splitSqlStatements("SELECT 'it''s here; really'; SELECT 2;");
    assert.equal(out.length, 2);
  });

  test('treats PostgreSQL CREATE TYPE as an ordinary statement', () => {
    // Oracle's CREATE TYPE needs a slash terminator; PostgreSQL's does not, and
    // mistaking one for the other swallowed the whole script.
    const out = splitSqlStatements(
      'CREATE TYPE addr AS (city varchar(20));\nCREATE TABLE c (a addr);\nSELECT * FROM c;',
    );
    assert.equal(out.length, 3);
  });

  test('keeps an Oracle PL/SQL block terminated by a slash in one piece', () => {
    const out = splitSqlStatements(
      'create or replace type body T as member function f return number is begin return 1; end; end;\n/\nselect 1 from dual;',
    );
    assert.equal(out.length, 2, 'the block and the select');
    assert.match(out[0], /member function/);
    assert.match(out[0], /end; end/, 'inner semicolons must survive');
    assert.equal(out[1], 'select 1 from dual');
  });
});

describe('expected-output parsing', () => {
  test('reads a JSON array of rows', () => {
    const parsed = parseExpected('[{"name":"Ram","age":21}]');
    assert.deepEqual(parsed.columns, ['name', 'age']);
    assert.equal(parsed.rows[0].age, 21);
  });

  test('reads a pipe-delimited table, skipping the rule', () => {
    const parsed = parseExpected('name | city\n-----+--------\nRam  | Chennai');
    assert.deepEqual(parsed.columns, ['name', 'city']);
    assert.deepEqual(parsed.rows, [{ name: 'Ram', city: 'Chennai' }]);
  });

  test('empty expected output is an empty result', () => {
    assert.deepEqual(parseExpected('').rows, []);
  });
});

describe('result comparison', () => {
  const rows = { columns: ['name'], rows: [{ name: 'Ram' }, { name: 'Sita' }] };

  test('ignores row order by default', () => {
    assert.ok(resultsMatch(rows, { columns: ['name'], rows: [{ name: 'Sita' }, { name: 'Ram' }] }));
  });

  test('enforces row order when the question asks for it', () => {
    assert.ok(!resultsMatch(rows, { columns: ['name'], rows: [{ name: 'Sita' }, { name: 'Ram' }] }, { ordered: true }));
    assert.ok(resultsMatch(rows, rows, { ordered: true }));
  });

  test('ignores column name case', () => {
    assert.ok(resultsMatch({ columns: ['NAME'], rows: [{ NAME: 'Ram' }] }, { columns: ['name'], rows: [{ name: 'Ram' }] }));
  });

  test('ignores column order', () => {
    // MongoDB does not preserve the field order written in a $project, so a
    // correct pipeline can return the columns the other way round.
    const a = { columns: ['count', 'language'], rows: [{ count: 4, language: 'English' }] };
    const b = { columns: ['language', 'count'], rows: [{ language: 'English', count: 4 }] };
    assert.ok(resultsMatch(a, b));
  });

  test('still catches a missing column, an extra row and a changed value', () => {
    assert.ok(!resultsMatch(rows, { columns: ['name', 'age'], rows: [{ name: 'Ram', age: 1 }] }));
    assert.ok(!resultsMatch(rows, { columns: ['name'], rows: [{ name: 'Ram' }] }));
    assert.ok(!resultsMatch(rows, { columns: ['name'], rows: [{ name: 'Ram' }, { name: 'Gita' }] }));
  });

  test('does not confuse different splits of the same characters', () => {
    const a = { columns: ['x', 'y'], rows: [{ x: 'ab', y: 'c' }] };
    const b = { columns: ['x', 'y'], rows: [{ x: 'a', y: 'bc' }] };
    assert.ok(!resultsMatch(a, b));
  });

  test('canonical form sorts the columns', () => {
    assert.deepEqual(canonicalRows({ columns: ['b', 'a'], rows: [] }).cols, ['a', 'b']);
  });
});

describe('running SQL answers', () => {
  const setup = "CREATE TABLE customer (id integer, name text, state text);"
    + " INSERT INTO customer VALUES (1,'Ram','Tamilnadu'),(2,'Sita','Kerala'),(3,'Priya','Tamilnadu');";
  const cases = [{ id: 't1', label: 'Tamilnadu customers', input: '', expectedOutput: '[{"name":"Ram"},{"name":"Priya"}]' }];

  for (const engine of ['sqlite', 'postgres']) {
    test(`${engine}: a correct query passes`, async () => {
      const result = await runAgainstTestCases({
        code: "SELECT name FROM customer WHERE state = 'Tamilnadu';",
        language: engine, testCases: cases, datasetScript: setup,
      });
      assert.equal(result.verdict, 'passed', JSON.stringify(result.cases[0]?.stderr));
      assert.equal(result.executor, `db:${engine}`);
    });

    test(`${engine}: a wrong query fails and shows both tables`, async () => {
      const result = await runAgainstTestCases({
        code: "SELECT name FROM customer WHERE state = 'Kerala';",
        language: engine, testCases: cases, datasetScript: setup,
      });
      assert.equal(result.verdict, 'failed');
      assert.match(result.cases[0].actualOutput, /Sita/);
      assert.match(result.cases[0].expectedOutput, /Ram/);
    });

    test(`${engine}: a broken query reports the engine's message`, async () => {
      const result = await runAgainstTestCases({
        code: 'SELECT * FROM nosuchtable;', language: engine, testCases: cases, datasetScript: setup,
      });
      assert.equal(result.verdict, 'error');
      assert.ok(result.cases[0].stderr);
      assert.match(result.cases[0].explanation, /does not exist|table/i);
    });
  }

  test('a verification query checks what the student created', async () => {
    const result = await runAgainstTestCases({
      code: "CREATE TABLE mine (id integer); INSERT INTO mine VALUES (1),(2),(3);",
      language: 'sqlite',
      testCases: [{
        id: 'v1', label: 'Three rows',
        input: 'SELECT count(*) AS n FROM mine;',
        expectedOutput: '[{"n":3}]',
      }],
      datasetScript: null,
    });
    assert.equal(result.verdict, 'passed');
  });

  test('a question with no test cases still returns the rows', async () => {
    const result = await runAgainstTestCases({
      code: 'SELECT name FROM customer;', language: 'sqlite', testCases: [], datasetScript: setup,
    });
    assert.equal(result.verdict, 'no_test_cases');
    assert.equal(result.cases[0].passed, null);
    assert.match(result.cases[0].actualOutput, /Ram/);
  });
});

describe('question kinds', () => {
  test('a language set is all program or all database', () => {
    assert.equal(kindOfLanguageSet(['c', 'python']), 'program');
    assert.equal(kindOfLanguageSet(['sqlite', 'postgres']), 'database');
    assert.equal(kindOfLanguageSet(['c', 'sqlite']), null, 'mixed sets are rejected');
    assert.equal(kindOfLanguageSet([]), null);
  });
});

describe('table rendering', () => {
  test('renders aligned columns', () => {
    const text = renderTable({ columns: ['id', 'city'], rows: [{ id: 1, city: 'Chennai' }] });
    assert.match(text, /id \| city/);
    assert.match(text, /1 {2}\| Chennai/);
  });

  test('shows NULL rather than an empty cell', () => {
    assert.match(renderTable({ columns: ['a'], rows: [{ a: null }] }), /NULL/);
  });
});

describe('MongoDB script shapes', () => {
  // A student formats an aggregation pipeline over several lines. An earlier
  // implementation inserted `return` before the last *line*, which turned the
  // closing `])` of a pipeline into `return ]);`.
  test('the last expression is found by parsing, not by line shape', async () => {
    const { withImplicitReturn } = await import('../src/services/dbEngines/mongodb.js');

    const pipeline = 'db.book.aggregate([\n  { $match: { a: 1 } },\n  { $project: { _id: 0 } }\n])';
    const wrapped = withImplicitReturn(pipeline);
    assert.match(wrapped, /return \( db\.book\.aggregate/, 'the return goes before the whole pipeline');
    assert.ok(!/return \]\)/.test(wrapped), 'never before the closing bracket');

    // A declaration followed by an expression keeps the declaration outside.
    const declared = withImplicitReturn('const n = db.book.countDocuments({});\nn * 2');
    assert.match(declared, /^const n = /);
    assert.match(declared, /return \( n \* 2/);

    // A leading comment is not mistaken for the statement.
    assert.match(withImplicitReturn('// note\ndb.book.find({})'), /return \( db\.book\.find/);
  });

  test('an empty script yields nothing to return', async () => {
    const { withImplicitReturn } = await import('../src/services/dbEngines/mongodb.js');
    assert.equal(withImplicitReturn('   \n  '), '');
  });

  const mongoIt = async (script, setup) => {
    const { runAgainstTestCases: run } = await import('../src/services/execution.js');
    return run({ code: script, language: 'mongodb', testCases: [], datasetScript: setup });
  };
  const SETUP = "db.book.insertMany([{title:'A',n:1},{title:'B',n:2},{title:'C',n:3}]);";

  test('a multi-line pipeline runs against the real shell', async () => {
    const result = await mongoIt(
      'db.book.aggregate([\n  { $match: { n: { $gt: 1 } } },\n  { $project: { _id: 0, title: 1 } },\n  { $sort: { title: 1 } }\n])',
      SETUP,
    );
    assert.equal(result.verdict, 'no_test_cases');
    assert.deepEqual(result.cases[0].resultTable.rows, [{ title: 'B' }, { title: 'C' }]);
  });

  test('a count and arithmetic on it both come back as values', async () => {
    const counted = await mongoIt('db.book.countDocuments({})', SETUP);
    assert.deepEqual(counted.cases[0].resultTable.rows, [{ value: 3 }]);
    // Arithmetic only works if mongosh's own async rewriting reached the call.
    const doubled = await mongoIt('db.book.countDocuments({}) * 2', SETUP);
    assert.deepEqual(doubled.cases[0].resultTable.rows, [{ value: 6 }]);
  });

  test('a declaration followed by an expression works', async () => {
    const result = await mongoIt('const n = db.book.countDocuments({});\nn + 10', SETUP);
    assert.deepEqual(result.cases[0].resultTable.rows, [{ value: 13 }]);
  });

  test('several statements run in order', async () => {
    const result = await mongoIt("db.book.insertOne({ title: 'D' });\ndb.book.countDocuments({})", SETUP);
    assert.deepEqual(result.cases[0].resultTable.rows, [{ value: 4 }]);
  });

  test('an invalid pipeline is an error, not a row of data', async () => {
    const result = await mongoIt('db.book.aggregate([{ $nope: 1 }])', SETUP);
    assert.equal(result.verdict, 'error');
    assert.match(result.cases[0].stderr, /\$nope/);
    assert.equal(result.cases[0].resultTable, null);
  });

  test("a student's print() is captured", async () => {
    const result = await mongoIt("print('roll number 23SS001')", SETUP);
    assert.match(JSON.stringify(result.cases[0].resultTable.rows), /23SS001/);
  });
});
