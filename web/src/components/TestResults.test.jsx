import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TestResults from './TestResults.jsx';

const programCase = (overrides) => ({
  testCaseId: overrides.label,
  input: '',
  expectedOutput: '',
  actualOutput: '',
  stderr: null,
  status: 'Executed',
  explanation: null,
  timeMs: 12,
  ...overrides,
});

describe('TestResults', () => {
  test('a compile error shows the compiler output rather than test cases', () => {
    render(<TestResults result={{
      verdict: 'compile_error', compileOutput: 'main.c:3: error: expected ";"', cases: [],
    }} />);
    expect(screen.getByText(/did not compile/)).toBeInTheDocument();
    expect(screen.getByText('main.c:3: error: expected ";"')).toBeInTheDocument();
  });

  test('summarises the pass count and opens only the failing case', () => {
    render(<TestResults result={{
      verdict: 'failed',
      graded: true,
      passedCount: 1,
      totalCount: 2,
      cases: [
        programCase({ label: 'basic', passed: true, input: '2 3', expectedOutput: '5', actualOutput: '5' }),
        programCase({
          label: 'negative', passed: false, input: '-1 1', expectedOutput: '0', actualOutput: '-2',
          explanation: 'The output did not match the expected output.',
        }),
      ],
    }} />);

    expect(screen.getByText('1 of 2 test cases passed')).toBeInTheDocument();
    expect(screen.getAllByText('Your output')).toHaveLength(1);
    expect(screen.getByText('-2')).toBeInTheDocument();
    expect(screen.getByText('The output did not match the expected output.')).toBeInTheDocument();
  });

  test('a passing case can be expanded by clicking it', async () => {
    render(<TestResults result={{
      verdict: 'passed',
      graded: true,
      passedCount: 2,
      totalCount: 2,
      cases: [
        programCase({ label: 'first', passed: true, input: '1', expectedOutput: 'one', actualOutput: 'one' }),
        programCase({ label: 'second', passed: true, input: '2', expectedOutput: 'two', actualOutput: 'two' }),
      ],
    }} />);

    expect(screen.queryByText('Your output')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('second'));
    expect(screen.getAllByText('two')).toHaveLength(2);
  });

  test('an ungraded run shows the output and says the teacher grades it', () => {
    render(<TestResults result={{
      verdict: 'no_test_cases',
      graded: false,
      passedCount: 0,
      totalCount: 0,
      cases: [programCase({ label: 'Program output', passed: null, expectedOutput: null, actualOutput: 'Aditya' })],
    }} />);

    expect(screen.getByText('No test cases — your teacher grades this one')).toBeInTheDocument();
    expect(screen.getByText('Aditya')).toBeInTheDocument();
  });
});
