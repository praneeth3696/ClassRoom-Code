import { useState } from 'react';
import ResultTable from './ResultTable.jsx';

/**
 * A database case shows real tables rather than text blocks, and labels the
 * verification query when the question uses one.
 */
function DatabaseCaseBody({ c }) {
  return (
    <>
      {c.explanation && (
        <div className="small" style={{ padding: '9px 11px', borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          {c.explanation}
        </div>
      )}
      <div style={{ padding: 11, borderTop: '1px solid var(--border)', display: 'grid', gap: 12 }}>
        {c.input && (
          <div className="io">
            <h4>Checked with</h4>
            <pre>{c.input}</pre>
          </div>
        )}
        {c.stderr ? (
          <div className="io">
            <h4>Engine error</h4>
            <pre className="bad">{c.stderr}</pre>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: c.expectedOutput ? 'repeat(auto-fit, minmax(240px, 1fr))' : '1fr' }}>
            {c.expectedOutput && (
              <div className="io">
                <h4>Expected</h4>
                <pre>{c.expectedOutput}</pre>
              </div>
            )}
            <div className="io">
              <h4>Your result</h4>
              <ResultTable table={c.resultTable} />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function CaseRow({ c, index, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const icon = c.passed === true ? '✓' : c.passed === false ? '✕' : '›';
  const cls = c.passed === true ? 'pass' : c.passed === false ? 'fail' : '';

  return (
    <div className="tc">
      <div className="tc-head" onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpen((v) => !v); }}>
        <span className={`badge ${cls}`}>{icon}</span>
        <span className="grow">{c.label || `Test case ${index + 1}`}</span>
        {c.timeMs != null && <span className="small faint">{c.timeMs} ms</span>}
        <span className="small muted">{c.status}</span>
        <span className="faint">{open ? '▾' : '▸'}</span>
      </div>

      {open && (c.resultTable !== undefined ? <DatabaseCaseBody c={c} /> : (
        <>
          {c.explanation && (
            <div className="small" style={{ padding: '9px 11px', borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
              {c.explanation}
            </div>
          )}
          <div className="tc-body">
            {c.expectedOutput !== null && (
              <>
                <div className="io">
                  <h4>Input</h4>
                  <pre>{c.input === '' ? '(no input)' : c.input}</pre>
                </div>
                <div className="io">
                  <h4>Expected output</h4>
                  <pre>{c.expectedOutput}</pre>
                </div>
              </>
            )}
            <div className="io">
              <h4>Your output</h4>
              <pre className={c.passed === false ? 'bad' : ''}>{c.actualOutput || '(no output)'}</pre>
            </div>
            {c.stderr && (
              <div className="io" style={{ gridColumn: '1 / -1' }}>
                <h4>Errors</h4>
                <pre className="bad">{c.stderr}</pre>
              </div>
            )}
          </div>
        </>
      ))}
    </div>
  );
}

/** Renders the outcome of a Run or Submit. */
export default function TestResults({ result }) {
  if (!result) return null;

  if (result.verdict === 'compile_error') {
    return (
      <div>
        <div className="notice error" style={{ marginBottom: 10 }}>
          <strong>Your code did not compile.</strong> Fix the errors below and run again.
        </div>
        <pre className="block">{result.compileOutput}</pre>
      </div>
    );
  }

  const ungraded = result.verdict === 'no_test_cases';

  return (
    <div>
      <div className="row" style={{ marginBottom: 10, justifyContent: 'space-between' }}>
        <div className="row">
          {ungraded ? (
            <span className="badge">No test cases — your teacher grades this one</span>
          ) : (
            <span className={`badge ${result.verdict === 'passed' ? 'pass' : 'fail'}`}>
              {result.passedCount} of {result.totalCount} test cases passed
            </span>
          )}
        </div>
        {result.executor?.startsWith('db:') && (
          <span className="badge">{result.executor.slice(3)}</span>
        )}
        {result.degraded && (
          <span className="badge warn" title="Judge0 was unreachable; this ran on the local fallback">
            Local execution
          </span>
        )}
      </div>

      {result.cases.map((c, i) => (
        <CaseRow key={c.testCaseId ?? i} c={c} index={i}
          defaultOpen={ungraded || c.passed === false || result.cases.length === 1} />
      ))}
    </div>
  );
}
