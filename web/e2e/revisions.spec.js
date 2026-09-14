import { expect, test } from '@playwright/test';

const TEACHER = 'anita.rao@college.edu';
const STUDENT = 'aditya.menon@college.edu';
const PY_SUM = 'a, b = map(int, input().split())\nprint(a + b)';

async function signedInContext(browser, email) {
  const context = await browser.newContext();
  const res = await context.request.post('/api/auth/dev-login', { data: { email } });
  expect(res.ok(), `dev-login for ${email}`).toBeTruthy();
  return context;
}

async function publishedQuestion(request) {
  const { courses } = await (await request.get('/api/courses')).json();
  const course = courses.find((c) => c.name === 'Programming Lab I');
  const created = await request.post(`/api/courses/${course.id}/worksheets`, {
    data: {
      title: `E2E revisions ${Date.now()}`,
      questions: [{
        title: 'Sum two integers',
        description: 'Read two integers and print their sum.',
        allowedLanguages: ['python'],
        points: 10,
        testCases: [{ input: '2 3\n', expectedOutput: '5\n' }],
      }],
    },
  });
  expect(created.status()).toBe(201);
  const { worksheet } = await created.json();
  expect((await request.post(`/api/worksheets/${worksheet.id}/publish`)).ok()).toBeTruthy();
  return worksheet.questions[0].id;
}

/** Replaces everything in the page's Monaco editor. */
async function replaceEditorText(page, text) {
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(text);
}

test('a student’s later edits never change the answer their teacher reviews', async ({ browser }) => {
  const teacherContext = await signedInContext(browser, TEACHER);
  const studentContext = await signedInContext(browser, STUDENT);
  const questionId = await publishedQuestion(teacherContext.request);

  const first = await studentContext.request.post(`/api/questions/${questionId}/submit`, {
    data: { code: PY_SUM, language: 'python' },
  });
  expect((await first.json()).submission.submitted.revision).toBe(1);

  // The student opens the question and starts experimenting.
  const student = await studentContext.newPage();
  await student.goto(`/questions/${questionId}`);
  await expect(student.getByText(/Revision 1 submitted/)).toBeVisible();
  await expect(student.locator('.monaco-editor')).toBeVisible();

  await replaceEditorText(student, 'print(0)');
  await expect(student.getByText(/changes that are not submitted/)).toBeVisible();
  await student.getByRole('button', { name: 'Run' }).click();
  await expect(student.getByText('0 of 1 test cases passed')).toBeVisible();

  // The teacher still reviews revision 1, and is told the student is editing.
  const teacher = await teacherContext.newPage();
  await teacher.goto(`/questions/${questionId}/submissions`);
  await expect(teacher.getByText('Submitted · revision 1')).toBeVisible();
  await expect(teacher.getByText(/edits they have not submitted/)).toBeVisible();
  await expect(teacher.locator('.monaco-editor .view-lines').first()).toContainText(/print\(a\s\+\sb\)/);
  await expect(teacher.getByText('Tests passed')).toBeVisible();

  // Restoring brings back the submitted code.
  await student.getByRole('button', { name: 'Restore submitted code' }).click();
  await expect(student.getByText(/changes that are not submitted/)).toBeHidden();

  // A real resubmission becomes revision 2, with revision 1 still readable.
  await replaceEditorText(student, 'print(5)');
  await student.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(student.getByText('Submitted as revision 2.')).toBeVisible();

  await teacher.reload();
  await expect(teacher.getByText('Submitted · revision 2')).toBeVisible();
  await expect(teacher.getByRole('heading', { name: 'Earlier revisions' })).toBeVisible();
  await teacher.getByRole('button', { name: /Revision 1 · passed/ }).click();
  await expect(teacher.locator('.monaco-editor .view-lines').nth(1)).toContainText(/print\(a\s\+\sb\)/);

  await teacherContext.close();
  await studentContext.close();
});
