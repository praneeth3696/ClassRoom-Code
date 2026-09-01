const BASE = 'http://localhost:4000';
let pass = 0, fail = 0;
const ok = (c, l, x='') => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l + ' ' + x); } };
const signIn = async (email) => {
  const r = await fetch(`${BASE}/api/auth/dev-login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email}) });
  if (!r.ok) throw new Error(email + ': ' + r.status);
  return r.headers.getSetCookie().find(c=>c.startsWith('classroom_session')).split(';')[0];
};
const call = async (m,p,cookie,body) => {
  const r = await fetch(`${BASE}${p}`, { method:m, headers:{...(body?{'Content-Type':'application/json'}:{}), ...(cookie?{Cookie:cookie}:{})}, body: body?JSON.stringify(body):undefined });
  const t = await r.text(); return { status:r.status, body: t?JSON.parse(t):null };
};

const student = await signIn('ss2301@psgtech.ac.in');
const teacher = await signIn('anita.rao@psgtech.ac.in');

console.log('\n--- Academic structure ---');
const depts = await call('GET','/api/departments',teacher);
ok(depts.body.departments.some(d=>d.code==='AMCS'), 'AMCS department exists');
const progs = await call('GET','/api/programmes',teacher);
const names = progs.body.programmes.map(p=>p.name).sort();
ok(names.length===4, `4 programmes: ${names.join(', ')}`);
const subjects = await call('GET',`/api/subjects?programmeId=${progs.body.programmes.find(p=>p.code==='SS').id}`,teacher);
const labs = subjects.body.subjects.filter(s=>s.kind==='lab').length;
const theory = subjects.body.subjects.filter(s=>s.kind==='theory').length;
ok(labs===3 && theory===5, `Software Systems has ${labs} lab + ${theory} theory subjects`);

console.log('\n--- Classroom-style membership ---');
const sc = await call('GET','/api/courses',student);
ok(sc.body.courses.length===2, `student is in ${sc.body.courses.length} classes`);
ok(sc.body.courses[0].batchLabel?.includes('2023'), 'class shows the batch');
ok(sc.body.courses[0].joinCode===undefined, 'students are not shown the join code');
const tc = await call('GET','/api/courses',teacher);
ok(tc.body.courses.every(c=>c.joinCode), 'teachers are shown join codes');

const bigData = tc.body.courses.find(c=>c.subjectCode==='5SSL01');
const code = bigData.joinCode;
const outsider = await signIn('tcs2301@psgtech.ac.in');
const joined = await call('POST','/api/courses/join',outsider,{ code });
ok(joined.status===200, 'a student joins with the class code');
const after = await call('GET','/api/courses',outsider);
// Checked by membership rather than by count, so the script can be re-run
// against a database where this student already joined.
ok(after.body.courses.some(c=>c.id===bigData.id), 'the class appears for them');
ok((await call('POST','/api/courses/join',outsider,{ code })).status===200, 'joining twice is harmless');
ok((await call('POST','/api/courses/join',outsider,{ code:'ZZZZZZ' })).status===404, 'a wrong code is refused');
ok((await call('POST','/api/courses/join',teacher,{ code })).status===400, 'a teacher cannot join their own class');
const rotated = await call('POST',`/api/courses/${bigData.id}/join-code/rotate`,teacher);
ok(rotated.body.joinCode !== code, 'the code can be rotated');
ok((await call('POST','/api/courses/join',outsider,{ code })).status===404, 'the old code stops working');

console.log('\n--- MongoDB questions ---');
const sheets = await call('GET',`/api/courses/${bigData.id}/worksheets`,teacher);
const mongoSheet = sheets.body.worksheets.find(w=>w.title.includes('MongoDB'));
const mws = await call('GET',`/api/worksheets/${mongoSheet.id}`,student);
ok(mws.body.worksheet.questions.length===15, `${mws.body.worksheet.questions.length} questions loaded`);
ok(mws.body.worksheet.datasetEngine==='mongodb', 'worksheet declares the mongodb engine');
const qLookup = mws.body.worksheet.questions.find(q=>q.title.includes('$lookup'));
const lookupRun = await call('POST',`/api/questions/${qLookup.id}/run`,student,{ language:'mongodb',
  code:"db.book.aggregate([{$lookup:{from:'user',localField:'user',foreignField:'mobileno',as:'b'}},{$unwind:'$b'},{$match:{'b.username':'ram'}},{$project:{_id:0,title:1}}])" });
ok(lookupRun.body.result?.verdict==='passed', '$lookup aggregation passes', JSON.stringify(lookupRun.body).slice(0,180));
const wrongRun = await call('POST',`/api/questions/${qLookup.id}/run`,student,{ language:'mongodb', code:"db.book.find({},{_id:0,title:1})" });
ok(wrongRun.body.result?.verdict==='failed', 'a wrong aggregation fails');
const badSyntax = await call('POST',`/api/questions/${qLookup.id}/run`,student,{ language:'mongodb', code:"db.book.aggregate([{$nope:1}])" });
ok(badSyntax.body.result?.verdict==='error' && badSyntax.body.result.cases[0].stderr.includes('nope'), 'a bad pipeline reports the engine error');

console.log('\n--- PostgreSQL object-relational questions ---');
const orSheet = sheets.body.worksheets.find(w=>w.title.includes('Object Relational'));
const ows = await call('GET',`/api/worksheets/${orSheet.id}`,student);
ok(ows.body.worksheet.datasetEngine==='postgres', 'worksheet declares the postgres engine');
const qPhones = ows.body.worksheet.questions.find(q=>q.title.includes('phone contacts'));
const phoneRun = await call('POST',`/api/questions/${qPhones.id}/run`,student,{ language:'postgres',
  code:'SELECT customer_id, coalesce(array_length(phones,1),0) AS phone_count FROM customer_1 ORDER BY customer_id;' });
ok(phoneRun.body.result?.verdict==='passed', 'array_length over a composite table passes', JSON.stringify(phoneRun.body).slice(0,180));
const qCreate = ows.body.worksheet.questions.find(q=>q.title.includes('object table'));
const createRun = await call('POST',`/api/questions/${qCreate.id}/submit`,student,{ language:'postgres',
  code:"CREATE TABLE customer_2 (customer_id integer, person person_ty);\nINSERT INTO customer_2 VALUES (1, ROW('A','One',20, ROW('s','Chennai','Tamilnadu','600001')::address_ty)::person_ty),(2, ROW('B','Two',21, ROW('s','Chennai','Tamilnadu','600002')::address_ty)::person_ty),(3, ROW('C','Three',22, ROW('s','Madurai','Tamilnadu','625001')::address_ty)::person_ty);" });
ok(createRun.body.submission?.autoPassed===true, 'a verification query checks what the student created');

console.log('\n--- Isolation between students ---');
const other = await signIn('ss2302@psgtech.ac.in');
const otherSees = await call('POST',`/api/questions/${qCreate.id}/run`,other,{ language:'postgres', code:'SELECT count(*) AS n FROM customer_2;' });
ok(otherSees.body.result?.cases[0].stderr?.includes('does not exist'), 'one student’s table is invisible to another (fresh database per run)');

console.log('\n--- Oracle reports honestly ---');
const oracleSheets = await call('GET',`/api/courses/${bigData.id}/worksheets`,teacher);
const oracleSheet = oracleSheets.body.worksheets.find(w=>w.title.includes('Oracle'));
ok(oracleSheet?.status==='draft', 'the Oracle worksheet is a draft until the server is configured');
await call('POST',`/api/worksheets/${oracleSheet.id}/publish`,teacher);
const ows2 = await call('GET',`/api/worksheets/${oracleSheet.id}`,teacher);
const oq = ows2.body.worksheet.questions[0];
const oracleRun = await call('POST',`/api/questions/${oq.id}/run`,teacher,{ language:'oracle', code:'select 1 from dual;' });
ok(oracleRun.body.result?.cases[0].stderr?.includes('not connected') || oracleRun.status>=400,
   'an Oracle question says Oracle is not connected rather than pretending', JSON.stringify(oracleRun.body).slice(0,160));
await call('POST',`/api/worksheets/${oracleSheet.id}/unpublish`,teacher);

console.log('\n--- Program languages still work ---');
// The Software Engineering lab is handled by a different member of staff.
const seTeacher = await signIn('meena.sundaram@psgtech.ac.in');
const seCourses = await call('GET','/api/courses',seTeacher);
const seCourse = seCourses.body.courses.find(c=>c.subjectCode==='5SSL03');
ok(Boolean(seCourse), 'a different teacher handles a different subject of the same batch');
const seSheets = await call('GET',`/api/courses/${seCourse.id}/worksheets`,seTeacher);
const progSheet = await call('GET',`/api/worksheets/${seSheets.body.worksheets[0].id}`,seTeacher);
const qSum = progSheet.body.worksheet.questions[0];
for (const [lang, code] of Object.entries({
  python: 'a, b = map(int, input().split())\nprint(a + b)',
  c: '#include <stdio.h>\nint main(void){int a,b;if(scanf("%d %d",&a,&b)!=2)return 1;printf("%d\\n",a+b);return 0;}',
  java: 'import java.util.Scanner;\npublic class Main{public static void main(String[] x){Scanner s=new Scanner(System.in);System.out.println(s.nextInt()+s.nextInt());}}',
})) {
  const r = await call('POST',`/api/questions/${qSum.id}/run`,seTeacher,{ language:lang, code });
  ok(r.body.result?.verdict==='passed', `${lang} still passes`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
