import { expect, test } from '@playwright/test';

/**
 * The server sends a strict Content-Security-Policy. A policy that is too tight
 * does not fail loudly: the browser silently refuses a script, worker or style,
 * and the code editor - the core of the student experience - stops working.
 * This walks the pages that load Monaco and fails on any CSP violation.
 */

const TEACHER = 'anita.rao@college.edu';
const STUDENT = 'aditya.menon@college.edu';

async function recordViolations(context) {
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'}`);
    });
  });
}

const violationsOn = (page) => page.evaluate(() => window.__cspViolations);

test('the sign-in page, question workspace and review screen load with no CSP violations', async ({ browser }) => {
  const anonymous = await browser.newContext();
  await recordViolations(anonymous);
  const signIn = await anonymous.newPage();
  await signIn.goto('/signin');
  await expect(signIn.getByRole('heading').first()).toBeVisible();
  expect(await violationsOn(signIn)).toEqual([]);
  await anonymous.close();

  const teacherContext = await browser.newContext();
  await recordViolations(teacherContext);
  await teacherContext.request.post('/api/auth/dev-login', { data: { email: TEACHER } });
  const { courses } = await (await teacherContext.request.get('/api/courses')).json();
  const course = courses.find((c) => c.name === 'Programming Lab I');
  const { worksheet } = await (await teacherContext.request.post(`/api/courses/${course.id}/worksheets`, {
    data: {
      title: `CSP check ${Date.now()}`,
      questions: [{ title: 'Echo', allowedLanguages: ['python', 'c'], testCases: [{ input: '', expectedOutput: 'hi\n' }] }],
    },
  })).json();
  await teacherContext.request.post(`/api/worksheets/${worksheet.id}/publish`);
  const questionId = worksheet.questions[0].id;

  const studentContext = await browser.newContext();
  await recordViolations(studentContext);
  await studentContext.request.post('/api/auth/dev-login', { data: { email: STUDENT } });
  await studentContext.request.post(`/api/questions/${questionId}/submit`, { data: { code: 'print("hi")', language: 'python' } });

  const student = await studentContext.newPage();
  await student.goto(`/questions/${questionId}`);
  await expect(student.locator('.monaco-editor')).toBeVisible();
  // Typing exercises the editor's language worker; switching language loads another.
  await student.locator('.monaco-editor .view-lines').first().click();
  await student.keyboard.type('# typed');
  await student.getByLabel('Language').selectOption('c');
  await expect(student.locator('.monaco-editor')).toBeVisible();
  expect(await violationsOn(student)).toEqual([]);

  const teacher = await teacherContext.newPage();
  await teacher.goto(`/questions/${questionId}/submissions`);
  await expect(teacher.locator('.monaco-editor')).toBeVisible();
  expect(await violationsOn(teacher)).toEqual([]);

  await teacherContext.close();
  await studentContext.close();
});
