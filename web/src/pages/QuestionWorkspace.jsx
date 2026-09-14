import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import CodeEditor from '../components/LazyCodeEditor.jsx';
import TestResults from '../components/TestResults.jsx';
import { AutoResultBadge, Crumbs, ErrorNotice, Loading } from '../components/ui.jsx';

/** Starter code, so an empty editor is never a blank page. */
const STARTERS = {
  python: '# Read input with input(), print your answer with print()\n',
  c: '#include <stdio.h>\n\nint main(void) {\n    \n    return 0;\n}\n',
  cpp: '#include <iostream>\n\nint main() {\n    \n    return 0;\n}\n',
  java: 'import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        \n    }\n}\n',
  sqlite: '-- Write your SQL below.\n',
  postgres: '-- Write your SQL below.\n',
  oracle: '-- Write your Oracle SQL below. End a PL/SQL block with / on its own line.\n',
  mongodb: '// Write mongosh commands below. The last expression is your answer.\n',
};

const isUntouchedStarter = (code) =>
  !code.trim() || Object.values(STARTERS).some((s) => s.trim() === code.trim());

export default function QuestionWorkspace() {
  const { questionId } = useParams();
  const { meta } = useAuth();

  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [code, setCode] = useState('');
  const [language, setLanguage] = useState(null);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.questionWorkspace(questionId);
      setData(res);
      const allowed = res.question.allowedLanguages;
      const lang = allowed.includes(res.submission?.language) ? res.submission.language : allowed[0];
      setLanguage(lang);
      setCode(res.submission?.code || STARTERS[lang] || '');
      setResult(res.submission?.lastRunResult ?? null);
    } catch (err) {
      setLoadError(err);
    }
  }, [questionId]);

  useEffect(() => { load(); }, [load]);

  if (loadError) return <div className="container"><ErrorNotice error={loadError} onRetry={load} /></div>;
  if (!data) return <Loading label="Loading question…" />;

  const { question, submission, submissionOpen, submissionClosedReason } = data;
  const isDatabase = question.kind === 'database';

  const changeLanguage = (next) => {
    setLanguage(next);
    // Replace starter code when switching, but never the student's own work.
    if (isUntouchedStarter(code)) setCode(STARTERS[next] ?? '');
  };

  const act = async (fn, onDone) => {
    setError(null); setStatus(null);
    try {
      const res = await fn();
      onDone(res);
    } catch (err) {
      setError(err);
    }
  };

  const run = () => {
    setRunning(true);
    return act(() => api.runCode(questionId, { code, language }), (res) => {
      setResult(res.result);
    }).finally(() => setRunning(false));
  };

  const submit = () => {
    setSubmitting(true);
    return act(() => api.submitAnswer(questionId, { code, language }), (res) => {
      setResult(res.result);
      setData((d) => ({ ...d, submission: res.submission }));
      const revision = res.submission.submitted.revision;
      setStatus(res.late
        ? `Submitted as revision ${revision} — after the deadline.`
        : `Submitted as revision ${revision}.`);
    }).finally(() => setSubmitting(false));
  };

  const saveDraft = () =>
    act(() => api.saveDraft(questionId, { code, language }), (res) => {
      setData((d) => ({ ...d, submission: res.submission }));
      setStatus('Draft saved.');
    });

  const submitted = submission?.submitted ?? null;
  // What the teacher sees is the submitted revision, not the editor, so say so
  // whenever the two differ.
  const unsubmittedChanges = Boolean(submitted) && (code !== submitted.code || language !== submitted.language);

  const restoreSubmitted = () => {
    setLanguage(submitted.language);
    setCode(submitted.code);
    setStatus(`Restored revision ${submitted.revision}.`);
  };

  const busy = running || submitting;

  return (
    <div className="container wide">
      <div className="workspace">
        <div className="pane left">
          <Crumbs items={[
            { label: 'Courses', to: '/' },
            { label: 'Course', to: `/courses/${question.courseId}` },
            { label: question.worksheetTitle, to: `/worksheets/${question.worksheetId}` },
          ]} />

          <h2>{question.title}</h2>
          <div className="row small muted" style={{ marginBottom: 14, gap: 12 }}>
            {question.points != null && <span>{question.points} points</span>}
            <span>
              {question.testCases.length
                ? `${question.testCases.length} ${isDatabase ? 'check' : 'test case'}${question.testCases.length === 1 ? '' : 's'}`
                : 'Graded by your teacher'}
            </span>
            {isDatabase && question.orderedComparison && (
              <span className="badge warn">Row order matters</span>
            )}
            {submission?.status === 'submitted' && <AutoResultBadge autoPassed={submission.autoPassed} compact />}
          </div>

          {!submissionOpen && (
            <div className="notice warn">
              {submissionClosedReason || 'Submissions are closed.'} You can still run your code here.
            </div>
          )}

          <div style={{ whiteSpace: 'pre-wrap', marginBottom: 16 }}>{question.description}</div>

          {question.referenceNotes && (
            <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 16 }}>
              <h4 style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-faint)' }}>
                References
              </h4>
              <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{question.referenceNotes}</div>
            </div>
          )}

          {isDatabase && (question.datasetScript || question.setupScript) && (
            <details className="dataset-panel" style={{ marginBottom: 16 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 560, marginBottom: 8 }}>
                Data you are querying
              </summary>
              <p className="hint">
                This runs before your script, on a fresh database each time. Nothing you write can
                affect anyone else's data.
              </p>
              {question.datasetScript && <pre>{question.datasetScript}</pre>}
              {question.setupScript && (
                <>
                  <div className="small faint" style={{ margin: '8px 0 4px' }}>Extra setup for this question</div>
                  <pre>{question.setupScript}</pre>
                </>
              )}
            </details>
          )}

          {question.testCases.length > 0 && (
            <details open>
              <summary style={{ cursor: 'pointer', fontWeight: 560, marginBottom: 8 }}>
                {isDatabase ? `Checks (${question.testCases.length})` : `Test cases (${question.testCases.length})`}
              </summary>
              <p className="hint">
                {isDatabase
                  ? 'Your result is compared with these. Row order does not matter unless the question says so.'
                  : 'Every test case is visible — nothing is hidden from you.'}
              </p>
              {question.testCases.map((tc, i) => (
                <div className="tc" key={tc.id}>
                  <div className="tc-head"><span className="grow">{tc.label || `Check ${i + 1}`}</span></div>
                  <div className="tc-body">
                    {(!isDatabase || tc.input) && (
                      <div className="io">
                        <h4>{isDatabase ? 'Checked with' : 'Input'}</h4>
                        <pre>{tc.input || '(no input)'}</pre>
                      </div>
                    )}
                    <div className="io">
                      <h4>Expected {isDatabase ? 'result' : 'output'}</h4>
                      <pre>{tc.expectedOutput}</pre>
                    </div>
                  </div>
                </div>
              ))}
            </details>
          )}

          {submission?.feedback && (
            <div className="card" style={{ marginTop: 16, borderColor: 'var(--accent)' }}>
              <h3>Teacher feedback</h3>
              {submission.feedback.marks != null && (
                <span className="badge info" style={{ marginBottom: 8 }}>
                  {submission.feedback.marks}{question.points != null ? ` / ${question.points}` : ''} marks
                </span>
              )}
              {submission.feedback.comment && (
                <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{submission.feedback.comment}</div>
              )}
              {submission.feedback.revision != null && (
                <div className={`small ${submission.feedback.outdated ? '' : 'faint'}`} style={{ marginTop: 8 }}>
                  On revision {submission.feedback.revision}
                  {submission.feedback.outdated
                    && ' — you have submitted again since, so it may not describe your latest answer.'}
                </div>
              )}
              {submission.feedback.teacherName && (
                <div className="small faint" style={{ marginTop: 8 }}>— {submission.feedback.teacherName}</div>
              )}
            </div>
          )}
        </div>

        <div className="pane right">
          <div className="editor-bar">
            <select value={language ?? ''} onChange={(e) => changeLanguage(e.target.value)} aria-label="Language">
              {question.allowedLanguages.map((id) => (
                <option key={id} value={id}>
                  {meta?.languages?.find((l) => l.id === id)?.label ?? id}
                </option>
              ))}
            </select>

            <button className="btn" onClick={run} disabled={busy || !code.trim()}>
              {running ? <><span className="spinner" /> Running…</> : 'Run'}
            </button>
            <button
              className="btn primary"
              onClick={submit}
              disabled={busy || !submissionOpen || !code.trim()}
              title={submissionOpen ? 'Submit your answer' : (submissionClosedReason || 'Submissions are closed')}
            >
              {submitting ? <><span className="spinner" /> Submitting…</> : 'Submit'}
            </button>
            <button className="btn ghost sm" onClick={saveDraft} disabled={busy || !submissionOpen}>
              Save draft
            </button>

            <span style={{ flex: 1 }} />
            {status && <span className="small muted">{status}</span>}
            {!status && submitted && (
              <span className="small muted">
                Revision {submitted.revision} submitted {new Date(submitted.submittedAt).toLocaleString()}
                {submitted.late && <span className="badge warn" style={{ marginLeft: 6 }}>Late</span>}
              </span>
            )}
          </div>

          {unsubmittedChanges && (
            <div className="notice warn" role="status" style={{ margin: 0, borderRadius: 0 }}>
              You have changes that are not submitted — your teacher sees revision {submitted.revision}.{' '}
              <button type="button" className="btn sm ghost" onClick={restoreSubmitted} disabled={busy}>
                Restore submitted code
              </button>
            </div>
          )}

          <div className="editor-host">
            <CodeEditor value={code} language={language} onChange={setCode} onSubmitShortcut={run} />
          </div>

          <div className="results">
            <ErrorNotice error={error} />
            {result ? (
              <TestResults result={result} />
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                Press <strong>Run</strong> (or ⌘/Ctrl + Enter) to check your work
                {isDatabase ? ' against the expected result' : ' against the test cases'}.
                Running is a self-check — it does not submit your answer.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
