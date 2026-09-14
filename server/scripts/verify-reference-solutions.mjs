import { many, closeDb } from '../src/db/index.js';
import { runAgainstTestCases } from '../src/services/execution.js';
import { shutdownEngines } from '../src/services/dbEngines/index.js';

// Reference solutions, keyed by question title.
const SOLUTIONS = {
  'Retrieve all information on all of the books': 'db.book.find({})',
  'Books written by Danielle Steel': "db.book.find({'author.firstname':'Danielle'},{_id:0,title:1})",
  'Users living in Boston': "db.user.find({'address.city':'Boston'},{_id:0,username:1})",
  'Books with multiple publishers': "db.book.find({'publisher.1':{$exists:true}},{_id:0,title:1})",
  'Books that have notes': 'db.book.find({notes:{$ne:[]}},{_id:0,title:1})',
  'Books published by Indian publishers': "db.book.find({'publisher.address.country':'India'},{_id:0,title:1})",
  'Books published by more than two publishers':
    "db.book.aggregate([{$match:{$expr:{$gt:[{$size:'$publisher'},2]}}},{$project:{_id:0,title:1}}])",
  'Count of books currently available': "db.book.countDocuments({available:'Y'})",
  'Language-wise book count':
    "db.book.aggregate([{$group:{_id:'$language',count:{$sum:1}}},{$project:{_id:0,language:'$_id',count:1}}])",
  'Top two publishers by number of books':
    "db.book.aggregate([{$unwind:'$publisher'},{$group:{_id:'$publisher.name',books:{$sum:1}}},"
    + "{$sort:{books:-1,_id:1}},{$limit:2},{$project:{_id:0,publisher:'$_id',books:1}}])",
  'Second author of every multi-author book':
    "db.book.aggregate([{$match:{'author.1':{$exists:true}}},{$project:{_id:0,title:1,"
    + "firstname:{$arrayElemAt:['$author.firstname',1]},lastname:{$arrayElemAt:['$author.lastname',1]}}}])",
  'Aggregation pipeline: books published from Chennai':
    "db.book.aggregate([{$unwind:'$publisher'},{$match:{'publisher.city':'Chennai'}},"
    + "{$project:{_id:0,title:1,author_firstname:{$arrayElemAt:['$author.firstname',0]}}},{$sort:{title:1}}])",
  "Books borrowed by the user 'ram' ($lookup)":
    "db.book.aggregate([{$lookup:{from:'user',localField:'user',foreignField:'mobileno',as:'b'}},"
    + "{$unwind:'$b'},{$match:{'b.username':'ram'}},{$project:{_id:0,title:1}}])",
  'Books left with no notes': 'db.book.find({notes:{$size:0}},{_id:0,title:1})',

  'Print all customer details':
    'SELECT customer_id, (person).firstname AS firstname, (person).lastname AS lastname, '
    + '(person).addr.city AS city FROM customer_1 ORDER BY customer_id;',
  'Street of a specific customer':
    'SELECT (person).addr.street AS street FROM customer_1 WHERE customer_id = 3;',
  'Total phone contacts per customer':
    'SELECT customer_id, coalesce(array_length(phones,1),0) AS phone_count FROM customer_1 ORDER BY customer_id;',
  'Customers living in Tamilnadu':
    "SELECT (person).firstname AS firstname, (person).age AS age FROM customer_1 "
    + "WHERE (person).addr.state = 'Tamilnadu';",
  'Create your own object table and insert into it':
    "CREATE TABLE customer_2 (customer_id integer, person person_ty);\n"
    + "INSERT INTO customer_2 VALUES\n"
    + " (1, ROW('A','One',20, ROW('s1','Chennai','Tamilnadu','600001')::address_ty)::person_ty),\n"
    + " (2, ROW('B','Two',21, ROW('s2','Chennai','Tamilnadu','600002')::address_ty)::person_ty),\n"
    + " (3, ROW('C','Three',22, ROW('s3','Madurai','Tamilnadu','625001')::address_ty)::person_ty);",
};

// A deliberately wrong answer, to prove the judge is not just saying yes.
const WRONG = {
  'Books written by Danielle Steel': "db.book.find({'author.firstname':'Andrew'},{_id:0,title:1})",
  'Customers living in Tamilnadu':
    "SELECT (person).firstname AS firstname, (person).age AS age FROM customer_1 "
    + "WHERE (person).addr.state = 'Karnataka';",
};

const questions = await many(`
  SELECT q.id, q.title, q.allowed_languages, q.kind, q.setup_script, q.ordered_comparison,
         w.dataset_script, w.dataset_engine, w.title AS worksheet
  FROM questions q JOIN worksheets w ON w.id = q.worksheet_id
  WHERE q.kind = 'database'
  ORDER BY w.title, q.position`);

let pass = 0; let fail = 0; let skipped = 0;
let currentSheet = null;

for (const q of questions) {
  if (q.worksheet !== currentSheet) {
    currentSheet = q.worksheet;
    console.log(`\n\x1b[1m${currentSheet}\x1b[0m  [engine: ${q.dataset_engine}]`);
  }
  const solution = SOLUTIONS[q.title];
  if (!solution) {
    console.log(`  \x1b[90mskip\x1b[0m ${q.title}`);
    skipped += 1;
    continue;
  }

  const testCases = await many(
    'SELECT id, label, input, expected_output FROM test_cases WHERE question_id = $1 ORDER BY position',
    [q.id],
  ).then((rows) => rows.map((r) => ({
    id: r.id, label: r.label, input: r.input, expectedOutput: r.expected_output,
  })));

  const result = await runAgainstTestCases({
    code: solution,
    language: q.allowed_languages[0],
    testCases,
    datasetScript: q.dataset_script,
    setupScript: q.setup_script,
    ordered: q.ordered_comparison,
  });

  const ok = result.verdict === 'passed';
  if (ok) { pass += 1; console.log(`  \x1b[32mok\x1b[0m   ${q.title}  (${result.passedCount}/${result.totalCount})`); }
  else {
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${q.title} -> ${result.verdict}`);
    for (const c of result.cases.filter((x) => x.passed === false)) {
      console.log(`        expected: ${JSON.stringify(c.expectedOutput)?.slice(0, 150)}`);
      console.log(`        actual  : ${JSON.stringify(c.actualOutput)?.slice(0, 150)}`);
      if (c.stderr) console.log(`        error   : ${c.stderr.slice(0, 200)}`);
    }
  }

  // The same question with a wrong answer must not pass.
  if (WRONG[q.title]) {
    const bad = await runAgainstTestCases({
      code: WRONG[q.title], language: q.allowed_languages[0], testCases,
      datasetScript: q.dataset_script, setupScript: q.setup_script, ordered: q.ordered_comparison,
    });
    if (bad.verdict === 'passed') { fail += 1; console.log('  \x1b[31mFAIL\x1b[0m a wrong answer was accepted!'); }
    else { pass += 1; console.log(`  \x1b[32mok\x1b[0m   ...and a wrong answer is rejected (${bad.verdict})`); }
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped (no reference solution written)\n`);
await shutdownEngines();
await closeDb();
process.exit(fail ? 1 : 0);
