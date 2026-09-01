/**
 * Full-product verification: walks SPEC.md's teacher flow (§7) and student
 * flow (§8) against a running server, then the grading and feedback loop (§9).
 */
const BASE = process.env.BASE || 'http://localhost:4000';
let pass = 0, fail = 0;
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  \x1b[32mok\x1b[0m   ${label}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${extra}`); }
};

async function signIn(email) {
  const r = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  });
  if (!r.ok) throw new Error(`sign-in ${email}: ${r.status}`);
  return r.headers.getSetCookie().find((c) => c.startsWith('classroom_session')).split(';')[0];
}
const call = async (m, p, cookie, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method: m,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};

const SOLUTIONS = {
  python: 'a, b = map(int, input().split())\nprint(a + b)',
  c: ['#include <stdio.h>', 'int main(void){int a,b;if(scanf("%d %d",&a,&b)!=2)return 1;printf("%d\\n",a+b);return 0;}'].join('\n'),
  cpp: ['#include <iostream>', 'int main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<std::endl;return 0;}'].join('\n'),
  java: ['import java.util.Scanner;', 'public class Main{public static void main(String[] x){Scanner s=new Scanner(System.in);System.out.println(s.nextInt()+s.nextInt());}}'].join('\n'),
};

// ---------------------------------------------------------------- infrastructure
section('Infrastructure');
const health = await call('GET', '/api/health');
ok(health.status === 200 && health.body.ok, 'server is healthy');
ok(health.body.db.migrations >= 1, `database migrated (${health.body.db.migrations} migration)`);
ok(['judge0', 'local'].includes(health.body.execution.executor), `an executor is available (${health.body.execution.executor})`);
const meta = await call('GET', '/api/meta');
const programLanguages = meta.body.languages.filter((l) => l.kind === 'program').map((l) => l.id);
ok(['c', 'cpp', 'java', 'python'].every((l) => programLanguages.includes(l)),
  `all four launch languages offered (§9): ${programLanguages.join(', ')}`);

// ---------------------------------------------------------------- §7 teacher flow
section('SPEC §7 — Teacher flow');

// Two teachers are picked from whichever roster is loaded, so this script runs
// against the small demo seed and the full department seed alike.
const roster = await call('GET', '/api/auth/dev-users');
const teacherAccounts = roster.body.users.filter((u) => u.role === 'teacher');
if (teacherAccounts.length < 2) {
  console.error('This script needs at least two seeded teachers. Run a seed first.');
  process.exit(1);
}
const teacherEmail = teacherAccounts[0].email;
const coTeacherEmail = teacherAccounts[1].email;
const emailDomain = teacherEmail.split('@')[1];
const teacher = await signIn(teacherEmail);
const coTeacher = await signIn(coTeacherEmail);

const course = await call('POST', '/api/courses', teacher, { name: 'E2E Systems Lab', code: 'CS-E2E', department: 'Computer Science' });
ok(course.status === 201, '§7.1 creates a course');
const courseId = course.body.course.id;
ok((await call('POST', `/api/courses/${courseId}/teachers`, teacher, { people: [{ email: coTeacherEmail }] })).status === 201,
  '§7.1 assigns a second teacher (multi-faculty, §5)');

// Fresh addresses each run, so re-running does not collide with earlier students.
const stamp = Date.now();
const studentEmails = ['a', 'b', 'c'].map((x) => `e2e-${stamp}-${x}@${emailDomain}`);
ok((await call('POST', `/api/courses/${courseId}/students`, teacher, { people: studentEmails.map((email) => ({ email })) })).status === 201,
  '§7.1 enrols a roster before anyone has signed in');

const ws = await call('POST', `/api/courses/${courseId}/worksheets`, teacher, {
  title: 'E2E Worksheet', description: 'End-to-end verification.',
  deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
  questions: [
    { title: 'Sum two integers', description: 'Read two integers, print the sum.',
      referenceNotes: 'Use scanf or input().split().', allowedLanguages: ['c', 'cpp', 'java', 'python'], points: 10,
      testCases: [
        { label: 'positives', input: '2 3\n', expectedOutput: '5\n' },
        { label: 'negative', input: '-10 4\n', expectedOutput: '-6\n' },
        { label: 'zeroes', input: '0 0\n', expectedOutput: '0\n' },
      ] },
    { title: 'Explain your approach', description: 'Comment on your method, then print your name.',
      allowedLanguages: ['python'], points: 5, testCases: [] },
  ],
});
ok(ws.status === 201, '§7.2 creates a worksheet with questions');
const wsId = ws.body.worksheet.id;
const [qSum, qOpen] = ws.body.worksheet.questions;
ok(qSum.testCases.length === 3, '§7.3 test cases stored');
ok(qOpen.testCases.length === 0, '§7.3 a question may have no test cases');
ok(qSum.referenceNotes.includes('scanf'), '§7.3 references stored');
ok(ws.body.worksheet.status === 'draft', 'worksheets start as drafts');

// ---------------------------------------------------------------- §8 student flow
section('SPEC §8 — Student flow');
const student = await signIn(studentEmails[0]);
const student2 = await signIn(studentEmails[1]);
ok((await call('GET', `/api/worksheets/${wsId}`, student)).status === 404, 'a draft is invisible to students');
ok((await call('POST', `/api/worksheets/${wsId}/publish`, teacher)).status === 200, 'teacher publishes it');

const seen = await call('GET', `/api/worksheets/${wsId}`, student);
ok(seen.status === 200, '§8.1 student sees the worksheet');
ok(seen.body.worksheet.deadline !== null, '§8.1 with its deadline');
ok(seen.body.worksheet.questions[0].testCases[0].expectedOutput === '5\n', '§4 every test case is visible');

section('SPEC §8.3 — Run (self-check)');
const wrong = await call('POST', `/api/questions/${qSum.id}/run`, student, { language: 'python', code: 'a, b = map(int, input().split())\nprint(a * b)' });
ok(wrong.body.result.verdict === 'failed', 'a wrong answer fails');
ok(wrong.body.result.passedCount === 1 && wrong.body.result.totalCount === 3, `partial result shown (${wrong.body.result.passedCount}/3)`);
ok(wrong.body.result.cases[0].actualOutput === '6\n' && wrong.body.result.cases[0].expectedOutput === '5\n', 'actual vs expected shown');
ok((await call('GET', `/api/questions/${qSum.id}/submission`, student)).body.submission.status === 'draft', 'Run does not submit');

for (const [lang, code] of Object.entries(SOLUTIONS)) {
  const r = await call('POST', `/api/questions/${qSum.id}/run`, student, { language: lang, code });
  ok(r.body.result?.verdict === 'passed', `§9 ${lang} compiles, runs and passes`, JSON.stringify(r.body).slice(0, 120));
}

section('Error feedback');
const ce = await call('POST', `/api/questions/${qSum.id}/run`, student, { language: 'c', code: 'int main(){ broken }' });
ok(ce.body.result.verdict === 'compile_error' && ce.body.result.compileOutput.includes('error'), 'compile error returns the compiler message');
const tle = await call('POST', `/api/questions/${qSum.id}/run`, student, { language: 'python', code: 'while True: pass' });
ok(tle.body.result.cases[0].explanation.includes('infinite loop'), 'a timeout explains the likely cause');
const rte = await call('POST', `/api/questions/${qSum.id}/run`, student, { language: 'python', code: 'print(1/0)' });
ok(rte.body.result.cases[0].stderr.includes('ZeroDivisionError'), 'a runtime error returns stderr');

section('SPEC §8.4 — Submit and revise');
const sub1 = await call('POST', `/api/questions/${qSum.id}/submit`, student, { language: 'python', code: 'a, b = map(int, input().split())\nprint(a - b)' });
ok(sub1.body.submission.status === 'submitted', 'submits');
ok(sub1.body.submission.autoPassed === false, '§9 records the automated fail');
const sub2 = await call('POST', `/api/questions/${qSum.id}/submit`, student, { language: 'python', code: SOLUTIONS.python });
ok(sub2.body.submission.autoPassed === true, '§8.4 a revision re-runs and re-grades');
const openSub = await call('POST', `/api/questions/${qOpen.id}/submit`, student, { language: 'python', code: '# I looped over the input.\nprint("Student A")' });
ok(openSub.body.submission.autoPassed === null, '§9 an open-ended question records no automated verdict');
await call('POST', `/api/questions/${qSum.id}/submit`, student2, { language: 'c', code: SOLUTIONS.c });

// ---------------------------------------------------------------- §7.4 review
section('SPEC §7.4 — Review and feedback');
const list = await call('GET', `/api/questions/${qSum.id}/submissions`, teacher);
ok(list.status === 200 && list.body.submissions.length === 2, 'teacher sees every submission');
ok(list.body.notSubmitted.length === 1, 'and who has not submitted');
ok(list.body.submissions[0].code.length > 0, 'with the student’s code');
ok(list.body.submissions[0].lastRunResult !== null, 'and the automated result');

const target = list.body.submissions.find((s) => s.student.email === studentEmails[0]);
const fb = await call('PUT', `/api/submissions/${target.id}/feedback`, teacher,
  { comment: 'Correct now. Next time, name your variables for what they hold.', marks: 9 });
ok(fb.status === 200 && fb.body.feedback.marks === 9, 'teacher leaves a comment and marks');
ok((await call('PUT', `/api/submissions/${target.id}/feedback`, teacher, { comment: 'Updated.', marks: 10 })).body.feedback.marks === 10,
  'feedback can be revised');
ok((await call('PUT', `/api/submissions/${target.id}/feedback`, teacher, { comment: 'x', marks: 999 })).status === 400,
  'marks above the question’s points are rejected');
ok((await call('PUT', `/api/submissions/${target.id}/feedback`, coTeacher, { comment: 'From the co-teacher.', marks: 8 })).status === 200,
  '§5 a co-teacher can also review');

section('SPEC §8.5 — Student sees the feedback');
const withFb = await call('GET', `/api/questions/${qSum.id}/submission`, student);
ok(withFb.body.submission.feedback?.comment === 'From the co-teacher.', 'the comment reaches the student');
ok(withFb.body.submission.feedback?.marks === 8, 'so do the marks');
ok(withFb.body.submission.feedback?.teacherName === teacherAccounts[1].name, 'attributed to the teacher who left it');
ok(withFb.body.submission.autoPassed === true, '§8.5 alongside the automated result');

section('Authorisation');
ok((await call('GET', `/api/questions/${qSum.id}/submissions`, student)).status === 403, 'a student cannot list the class’s submissions');
ok((await call('PUT', `/api/submissions/${target.id}/feedback`, student, { comment: 'A+' })).status === 403, 'a student cannot leave feedback');
const anotherStudent = roster.body.users.find((u) => u.role === 'student' && !studentEmails.includes(u.email));
const outsiderT = await signIn(anotherStudent.email);
ok((await call('GET', `/api/worksheets/${wsId}`, outsiderT)).status === 404, 'a student in another course sees nothing');
ok((await fetch(`${BASE}/api/courses`)).status === 401, 'anonymous requests are rejected');

section('Deadline (§14, resolved)');
await call('PATCH', `/api/worksheets/${wsId}`, teacher, { deadline: new Date(Date.now() - 3600000).toISOString() });
ok((await call('POST', `/api/questions/${qSum.id}/submit`, student, { language: 'python', code: SOLUTIONS.python })).status === 403,
  'submission locks after the deadline');
ok((await call('POST', `/api/questions/${qSum.id}/run`, student, { language: 'python', code: SOLUTIONS.python })).status === 200,
  'but running still works');
await call('PATCH', `/api/worksheets/${wsId}`, teacher, { allowLateSubmissions: true });
const late = await call('POST', `/api/questions/${qSum.id}/submit`, student, { language: 'python', code: SOLUTIONS.python });
ok(late.status === 200 && late.body.late === true, 'allowing late submissions reopens it, flagged as late');

section('Protecting student work');
ok((await call('DELETE', `/api/worksheets/${wsId}`, teacher)).status === 409, 'deleting a worksheet with submissions needs confirmation');
ok((await call('DELETE', `/api/worksheets/${wsId}?force=true`, teacher)).status === 200, 'and goes through when confirmed');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
