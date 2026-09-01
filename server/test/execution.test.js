import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOutput, outputMatches, runAgainstTestCases, autoPassedFrom } from '../src/services/execution.js';

const PY_SUM = 'a, b = map(int, input().split())\nprint(a + b)';
const cases = [
  { id: 't1', label: 'basic', input: '2 3\n', expectedOutput: '5\n' },
  { id: 't2', label: 'negative', input: '-1 1\n', expectedOutput: '0\n' },
];

describe('output comparison', () => {
  test('ignores a missing or extra trailing newline', () => {
    assert.ok(outputMatches('5', '5\n'));
    assert.ok(outputMatches('5\n\n\n', '5'));
  });

  test('ignores trailing spaces on a line and CRLF endings', () => {
    assert.ok(outputMatches('5 \n', '5\n'));
    assert.ok(outputMatches('a\r\nb\r\n', 'a\nb\n'));
  });

  test('keeps whitespace inside a line significant', () => {
    assert.ok(!outputMatches('1  2', '1 2'));
    assert.ok(!outputMatches(' 5', '5'));
  });

  test('still distinguishes different content', () => {
    assert.ok(!outputMatches('5', '6'));
    assert.ok(!outputMatches('', '5'));
    assert.ok(!outputMatches('5\n6', '5'));
  });

  test('normalizes predictably', () => {
    assert.equal(normalizeOutput('a  \nb\n\n'), 'a\nb');
    assert.equal(normalizeOutput(null), '');
  });
});

describe('running against test cases', () => {
  test('a correct program passes every case', async () => {
    const result = await runAgainstTestCases({ language: 'python', code: PY_SUM, testCases: cases });
    assert.equal(result.verdict, 'passed');
    assert.equal(result.passedCount, 2);
    assert.equal(result.totalCount, 2);
    assert.equal(autoPassedFrom(result), true);
    assert.ok(result.cases.every((c) => c.passed === true));
    assert.equal(result.cases[0].actualOutput, '5\n');
  });

  test('a wrong program fails and shows actual vs expected', async () => {
    const result = await runAgainstTestCases({
      language: 'python', code: 'a, b = map(int, input().split())\nprint(a - b)', testCases: cases,
    });
    assert.equal(result.verdict, 'failed');
    assert.equal(result.passedCount, 0);
    assert.equal(autoPassedFrom(result), false);
    assert.equal(result.cases[0].expectedOutput, '5\n');
    assert.equal(result.cases[0].actualOutput, '-1\n');
    assert.match(result.cases[0].explanation, /did not match/);
  });

  test('a partially correct program reports the split', async () => {
    // Correct for the first case only.
    const result = await runAgainstTestCases({
      language: 'python', code: 'a, b = map(int, input().split())\nprint(5 if a == 2 else 99)', testCases: cases,
    });
    assert.equal(result.verdict, 'failed');
    assert.equal(result.passedCount, 1);
    assert.equal(result.cases[0].passed, true);
    assert.equal(result.cases[1].passed, false);
  });

  test('a compile error is reported once with the compiler message', async () => {
    const result = await runAgainstTestCases({
      language: 'c', code: 'int main(void) { this is not valid c }', testCases: cases,
    });
    assert.equal(result.verdict, 'compile_error');
    assert.equal(result.passedCount, 0);
    assert.ok(result.compileOutput.length > 0);
    assert.match(result.cases[0].explanation, /did not compile/);
  });

  test('an infinite loop times out rather than hanging', async () => {
    const result = await runAgainstTestCases({
      language: 'python', code: 'while True: pass', testCases: [cases[0]],
    });
    assert.equal(result.verdict, 'failed');
    assert.equal(result.cases[0].statusId, 5);
    assert.match(result.cases[0].explanation, /longer than/);
  });

  test('a runtime error is captured with stderr', async () => {
    const result = await runAgainstTestCases({
      language: 'python', code: 'raise ValueError("boom")', testCases: [cases[0]],
    });
    assert.equal(result.verdict, 'failed');
    assert.match(result.cases[0].stderr, /ValueError: boom/);
    assert.match(result.cases[0].explanation, /stopped with an error/);
  });

  test('a question with no test cases runs once and is left ungraded', async () => {
    const result = await runAgainstTestCases({
      language: 'python', code: 'print("hello from my program")', testCases: [],
    });
    assert.equal(result.verdict, 'no_test_cases');
    assert.equal(result.graded, false);
    assert.equal(autoPassedFrom(result), null, 'ungraded questions must not claim an automated pass');
    assert.equal(result.cases.length, 1);
    assert.equal(result.cases[0].passed, null);
    assert.match(result.cases[0].actualOutput, /hello from my program/);
  });

  test('empty code is rejected before execution', async () => {
    await assert.rejects(
      () => runAgainstTestCases({ language: 'python', code: '   \n  ', testCases: cases }),
      (e) => { assert.equal(e.status, 400); return true; },
    );
  });

  test('all four launch languages execute', async () => {
    const programs = {
      python: 'a, b = map(int, input().split())\nprint(a + b)',
      c: '#include <stdio.h>\nint main(void){int a,b;if(scanf("%d %d",&a,&b)!=2)return 1;printf("%d\\n",a+b);return 0;}',
      cpp: '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<std::endl;return 0;}',
      java: 'import java.util.Scanner;\npublic class Main{public static void main(String[] x){Scanner s=new Scanner(System.in);System.out.println(s.nextInt()+s.nextInt());}}',
    };
    for (const [language, code] of Object.entries(programs)) {
      const result = await runAgainstTestCases({ language, code, testCases: cases });
      assert.equal(result.verdict, 'passed', `${language} should pass, got ${result.verdict}: ${result.compileOutput ?? ''}`);
    }
  });
});

describe('executor selection and fallback', () => {
  test('local execution is chosen when Judge0 is not configured', async () => {
    const { chooseExecutor } = await import('../src/services/execution.js');
    const { config } = await import('../src/config.js');
    config.judge0.url = null;
    config.judge0.allowLocalFallback = true;
    assert.equal(chooseExecutor(), 'local');
  });

  test('Judge0 is preferred when configured', async () => {
    const { chooseExecutor } = await import('../src/services/execution.js');
    const { config } = await import('../src/config.js');
    config.judge0.url = 'http://judge0.example';
    try {
      assert.equal(chooseExecutor(), 'judge0');
    } finally {
      config.judge0.url = null;
    }
  });

  test('an unreachable Judge0 falls back locally in development', async () => {
    const { config } = await import('../src/config.js');
    config.judge0.url = 'http://127.0.0.1:1'; // nothing listening
    config.judge0.allowLocalFallback = true;
    try {
      const result = await runAgainstTestCases({ language: 'python', code: PY_SUM, testCases: cases });
      assert.equal(result.verdict, 'passed');
      assert.equal(result.executor, 'local');
      assert.equal(result.degraded, true, 'the result must record that it did not use Judge0');
    } finally {
      config.judge0.url = null;
    }
  });

  test('with the fallback disabled, an unreachable Judge0 is an error', async () => {
    const { config } = await import('../src/config.js');
    config.judge0.url = 'http://127.0.0.1:1';
    config.judge0.allowLocalFallback = false;
    try {
      await assert.rejects(
        () => runAgainstTestCases({ language: 'python', code: PY_SUM, testCases: cases }),
        (e) => { assert.ok(e.status >= 500); return true; },
      );
    } finally {
      config.judge0.url = null;
      config.judge0.allowLocalFallback = true;
    }
  });

  test('with no executor at all, execution reports 503', async () => {
    const { config } = await import('../src/config.js');
    config.judge0.url = null;
    config.judge0.allowLocalFallback = false;
    try {
      await assert.rejects(
        () => runAgainstTestCases({ language: 'python', code: PY_SUM, testCases: cases }),
        (e) => { assert.equal(e.status, 503); assert.match(e.message, /not configured/); return true; },
      );
    } finally {
      config.judge0.allowLocalFallback = true;
    }
  });
});
