import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import CodeEditor from '../components/LazyCodeEditor.jsx';
import TestResults from '../components/TestResults.jsx';
import { AutoResultBadge, Avatar, Crumbs, Empty, ErrorNotice, Loading } from '../components/ui.jsx';

function FeedbackForm({ submission, onSaved }) {
  const [comment, setComment] = useState(submission.feedback?.comment ?? '');
  const [marks, setMarks] = useState(submission.feedback?.marks ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setComment(submission.feedback?.comment ?? '');
    setMarks(submission.feedback?.marks ?? '');
    setSaved(false);
    setError(null);
  }, [submission.id, submission.feedback]);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await api.saveFeedback(submission.id, {
        comment: comment.trim() || null,
        marks: marks === '' ? null : Number(marks),
      });
      setSaved(true);
      onSaved();
    } catch (err) { setError(err); } finally { setSaving(false); }
  };

  return (
    <form onSubmit={save} className="card" style={{ borderColor: 'var(--accent)' }}>
      <h3>Feedback</h3>
      <p className="hint" style={{ marginBottom: 10 }}>
        Explain what went wrong and why, so the student can fix it themselves.
      </p>
      {submission.feedback?.outdated && (
        <div className="notice warn">
          Your feedback was on revision {submission.feedback.revision}; the student has since submitted
          revision {submission.revision}. Saving updates it to the latest revision.
        </div>
      )}
      <ErrorNotice error={error} />

      <div className="field">
        <label htmlFor="comment">Comment</label>
        <textarea id="comment" rows={5} value={comment} onChange={(e) => setComment(e.target.value)}
          placeholder="Your loop stops one element early — check the condition on line 7." />
      </div>
      <div className="field" style={{ maxWidth: 160 }}>
        <label htmlFor="marks">Marks <span className="faint">(optional)</span></label>
        <input id="marks" type="number" min="0" step="0.5" value={marks}
          onChange={(e) => setMarks(e.target.value)} />
      </div>
      <div className="btn-row">
        <button className="btn primary" disabled={saving || (!comment.trim() && marks === '')}>
          {saving ? 'Saving…' : submission.feedback ? 'Update feedback' : 'Leave feedback'}
        </button>
        {saved && <span className="small" style={{ color: 'var(--pass)' }}>Saved — the student can see this.</span>}
      </div>
    </form>
  );
}

/** Earlier submitted revisions, for a student who has submitted more than once. */
function RevisionHistory({ submission }) {
  const [revisions, setRevisions] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setRevisions(null);
    setSelected(null);
    setError(null);
    api.submissionRevisions(submission.id)
      .then((res) => { if (!cancelled) setRevisions(res.revisions); })
      .catch((err) => { if (!cancelled) setError(err); });
    return () => { cancelled = true; };
  }, [submission.id, submission.revision]);

  if (error) return <ErrorNotice error={error} />;
  if (!revisions) return null;

  const earlier = revisions.filter((r) => r.revision !== submission.revision);
  const shown = earlier.find((r) => r.revision === selected) ?? null;
  if (earlier.length === 0) return null;

  return (
    <div className="card">
      <h3>Earlier revisions</h3>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: shown ? 12 : 0 }}>
        {earlier.map((r) => (
          <button
            key={r.revision}
            type="button"
            className={`btn sm${r.revision === selected ? ' primary' : ''}`}
            onClick={() => setSelected(r.revision === selected ? null : r.revision)}
          >
            Revision {r.revision} · {r.autoPassed === true ? 'passed' : r.autoPassed === false ? 'failed' : 'ungraded'}
            {r.late ? ' · late' : ''}
          </button>
        ))}
      </div>
      {shown && (
        <>
          <div className="small muted" style={{ marginBottom: 8 }}>
            Submitted {new Date(shown.submittedAt).toLocaleString()}
          </div>
          <div style={{ height: 240, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
            <CodeEditor value={shown.code} language={shown.language} onChange={() => {}} readOnly />
          </div>
          {shown.result && <div style={{ marginTop: 12 }}><TestResults result={shown.result} /></div>}
        </>
      )}
    </div>
  );
}

export default function SubmissionsReview() {
  const { questionId } = useParams();
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.questionSubmissions(questionId);
      setData(res);
      setSelectedId((current) => current ?? res.submissions[0]?.id ?? null);
    } catch (err) { setError(err); }
  }, [questionId]);

  useEffect(() => { load(); }, [load]);

  if (error && !data) return <div className="container"><ErrorNotice error={error} onRetry={load} /></div>;
  if (!data) return <Loading />;

  const selected = data.submissions.find((s) => s.id === selectedId) ?? null;
  const reviewed = data.submissions.filter((s) => s.feedback).length;

  return (
    <div className="container">
      <Crumbs items={[
        { label: 'Courses', to: '/' },
        { label: 'Worksheet', to: `/worksheets/${data.question.worksheetId}` },
        { label: data.question.title },
      ]} />

      <div className="page-head">
        <div className="grow">
          <h1>{data.question.title}</h1>
          <p className="sub">
            {data.submissions.length} submission{data.submissions.length === 1 ? '' : 's'} ·
            {' '}{reviewed} reviewed · {data.notSubmitted.length} not submitted
          </p>
        </div>
      </div>

      <ErrorNotice error={error} />

      {data.submissions.length === 0 ? (
        <Empty title="No submissions yet">
          Students who have not started will appear here once they submit.
        </Empty>
      ) : (
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(230px, 1fr) minmax(0, 3fr)' }}>
          <div>
            <h3>Students</h3>
            {data.submissions.map((s) => (
              <button
                key={s.id}
                className="user-pick"
                onClick={() => setSelectedId(s.id)}
                style={s.id === selectedId ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : undefined}
              >
                <Avatar user={s.student} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.student.name}</div>
                  <div className="small muted">
                    {s.status === 'submitted' ? `Submitted · revision ${s.revision}` : 'Draft'}
                  </div>
                </span>
                <span className="stack" style={{ gap: 3, alignItems: 'flex-end' }}>
                  <AutoResultBadge autoPassed={s.autoPassed} compact />
                  {s.late && <span className="badge warn">Late</span>}
                  {s.feedback && (
                    <span className={`badge ${s.feedback.outdated ? 'warn' : 'info'}`}>
                      {s.feedback.outdated ? 'Resubmitted' : 'Reviewed'}
                    </span>
                  )}
                </span>
              </button>
            ))}

            {data.notSubmitted.length > 0 && (
              <details style={{ marginTop: 14 }}>
                <summary className="small muted" style={{ cursor: 'pointer' }}>
                  Not submitted ({data.notSubmitted.length})
                </summary>
                <ul className="small muted" style={{ paddingLeft: 18, marginTop: 8 }}>
                  {data.notSubmitted.map((s) => <li key={s.id}>{s.name}</li>)}
                </ul>
              </details>
            )}
          </div>

          {selected && (
            <div className="stack">
              <div className="card">
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                  <div>
                    <h3 style={{ margin: 0 }}>{selected.student.name}</h3>
                    <div className="small muted">{selected.student.email}</div>
                  </div>
                  <div className="row">
                    {selected.revision != null && <span className="badge">Revision {selected.revision}</span>}
                    {selected.late && <span className="badge warn">Late</span>}
                    <span className="badge">{selected.language}</span>
                    <AutoResultBadge autoPassed={selected.autoPassed} />
                  </div>
                </div>
                <div className="small muted" style={{ marginBottom: 10 }}>
                  {selected.submittedAt
                    ? `Submitted ${new Date(selected.submittedAt).toLocaleString()}`
                    : `Draft, last edited ${new Date(selected.updatedAt).toLocaleString()}`}
                  {selected.hasUnsubmittedChanges && ' · the student has edits they have not submitted'}
                </div>
                <div style={{ height: 300, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                  <CodeEditor value={selected.code} language={selected.language} onChange={() => {}} readOnly />
                </div>
              </div>

              {selected.lastRunResult && (
                <div className="card">
                  <h3>Automated result</h3>
                  <TestResults result={selected.lastRunResult} />
                </div>
              )}

              {selected.revisionCount > 1 && <RevisionHistory submission={selected} />}

              <FeedbackForm submission={selected} onSaved={load} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
