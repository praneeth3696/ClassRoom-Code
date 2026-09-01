import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { Crumbs, ErrorNotice, Loading } from '../components/ui.jsx';

/**
 * Import a worksheet from the problem sheet a teacher already hands out.
 *
 * Three steps, deliberately visible: upload and extract, draft and check, then
 * review before anything is created. The review step is not optional - the
 * draft is a proposal, and the status of each question says how far it can be
 * trusted.
 */

const STATUS_LABEL = {
  verified: { text: 'Checked', cls: 'pass', blurb: 'The reference solution ran; the expected output is its real result.' },
  partial: { text: 'Partly checked', cls: 'warn', blurb: 'Some cases produced a result; the rest were dropped.' },
  teacher_graded: { text: 'You grade this', cls: '', blurb: 'Open-ended, so it has no automatic check.' },
  failed: { text: 'Not checked', cls: 'fail', blurb: 'The reference solution did not run, so no expected output was invented.' },
};

function QuestionReview({ question, status, index, onChange }) {
  const [open, setOpen] = useState(status?.status === 'failed');
  const label = STATUS_LABEL[status?.status] ?? STATUS_LABEL.failed;

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row">
            <span className="q-num">{index + 1}</span>
            <strong>{question.title}</strong>
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {question.allowedLanguages.join(', ')}
            {question.points != null && ` · ${question.points} points`}
            {question.testCases?.length
              ? ` · ${question.testCases.length} check${question.testCases.length === 1 ? '' : 's'}`
              : ' · no automatic checks'}
          </div>
        </div>
        <div className="row">
          <span className={`badge ${label.cls}`}>{label.text}</span>
          <button type="button" className="btn sm ghost" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide' : 'Details'}
          </button>
        </div>
      </div>

      {status?.reason && (
        <div className="small muted" style={{ marginTop: 8 }}>{status.reason}</div>
      )}

      {open && (
        <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
          <div className="field">
            <label>Title</label>
            <input type="text" value={question.title}
              onChange={(e) => onChange({ ...question, title: e.target.value })} />
          </div>
          <div className="field">
            <label>Description</label>
            <textarea rows={4} value={question.description}
              onChange={(e) => onChange({ ...question, description: e.target.value })} />
          </div>

          <div className="hint">{label.blurb}</div>

          {status?.detail && (
            <div className="io">
              <h4>Why it failed</h4>
              <pre className="bad">{status.detail}</pre>
            </div>
          )}

          {question.referenceSolution && (
            <div className="io">
              <h4>Reference solution (not shown to students)</h4>
              <pre>{question.referenceSolution}</pre>
            </div>
          )}

          {question.testCases?.map((tc, i) => (
            <div className="tc" key={i}>
              <div className="tc-head"><span className="grow">{tc.label || `Check ${i + 1}`}</span></div>
              <div className="tc-body">
                {tc.input && <div className="io"><h4>Input</h4><pre>{tc.input}</pre></div>}
                <div className="io">
                  <h4>Expected output <span className="faint">(computed by running the solution)</span></h4>
                  <pre>{tc.expectedOutput}</pre>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ImportWorksheet() {
  const { courseId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const fileRef = useRef(null);

  const [available, setAvailable] = useState(null);
  const [recent, setRecent] = useState([]);
  const [record, setRecord] = useState(null);
  const [pdfBase64, setPdfBase64] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(() => {
    api.courseImports(courseId)
      .then((r) => { setAvailable(r.available); setRecent(r.imports); })
      .catch(setError);
  }, [courseId]);
  useEffect(load, [load]);

  // Drafts are stored server-side, so a teacher who closed the tab can pick one
  // up again instead of re-uploading and paying for a second analysis.
  const resumeId = params.get('import');
  useEffect(() => {
    if (!resumeId || record?.id === resumeId) return;
    api.getImport(resumeId, { text: true })
      .then((r) => { setRecord(r.import); setDirty(false); })
      .catch(setError);
  }, [resumeId, record?.id]);

  const resume = (id) => {
    setParams({ import: id });
  };

  const upload = async (e) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy('upload'); setError(null); setRecord(null);
    try {
      // A PDF is read by the model directly and is not stored server-side, so
      // it has to travel with the analyse request.
      if (file.name.toLowerCase().endsWith('.pdf')) {
        const buf = await file.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
        setPdfBase64(btoa(binary));
      } else {
        setPdfBase64(null);
      }
      const res = await api.uploadImport(courseId, file);
      setRecord(res.import);
      setParams({ import: res.import.id });
      load();
      if (res.warnings?.length) {
        setError({ message: 'The document was read, but some parts could not be converted.', details: res.warnings.map((w) => ({ field: 'document', message: w })) });
      }
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const analyze = async () => {
    setBusy('analyze'); setError(null);
    try {
      const res = await api.analyzeImport(record.id, pdfBase64);
      setRecord(res.import);
      setDirty(false);
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const saveEdits = async () => {
    setBusy('save'); setError(null);
    try {
      const res = await api.updateImportDraft(record.id, record.draft);
      setRecord(res.import);
      setDirty(false);
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const recheck = async () => {
    setBusy('recheck'); setError(null);
    try {
      if (dirty) await api.updateImportDraft(record.id, record.draft);
      const res = await api.recheckImport(record.id);
      setRecord(res.import);
      setDirty(false);
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  const apply = async () => {
    setBusy('apply'); setError(null);
    try {
      if (dirty) await api.updateImportDraft(record.id, record.draft);
      const res = await api.applyImport(record.id);
      navigate(`/worksheets/${res.worksheetId}`);
    } catch (err) { setError(err); setBusy(null); }
  };

  const setQuestion = (index, next) => {
    setRecord((r) => ({
      ...r,
      draft: { ...r.draft, questions: r.draft.questions.map((q, i) => (i === index ? next : q)) },
    }));
    setDirty(true);
  };

  if (available === null && !error) return <Loading />;

  const draft = record?.draft;
  const report = record?.solveReport;

  return (
    <div className="container">
      <Crumbs items={[
        { label: 'Courses', to: '/' },
        { label: 'Class', to: `/courses/${courseId}` },
        { label: 'Import a worksheet' },
      ]} />

      <h1>Import from a problem sheet</h1>
      <p className="sub" style={{ marginBottom: 18 }}>
        Upload the sheet you already hand out. The questions are drafted for you, and each
        expected output is produced by <strong>running a reference solution</strong> — never guessed.
        Nothing reaches students until you review it and publish.
      </p>

      <ErrorNotice error={error} />

      {available === false && (
        <div className="notice warn">
          This server has no Anthropic API key configured, so drafting is unavailable. You can still
          upload a sheet to check it reads correctly, or add questions by hand with{' '}
          <strong>New worksheet</strong>.
        </div>
      )}

      {recent.length > 0 && !record && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Earlier uploads</h3>
          <p className="hint" style={{ marginBottom: 10 }}>
            Drafts are kept, so you can come back to one rather than uploading again.
          </p>
          <div className="table-wrap">
            <table>
              <tbody>
                {recent.slice(0, 8).map((imp) => (
                  <tr key={imp.id}>
                    <td>{imp.sourceName}</td>
                    <td><span className={`badge ${imp.status === 'applied' ? 'pass' : imp.status === 'failed' ? 'fail' : ''}`}>{imp.status}</span></td>
                    <td className="small muted">{new Date(imp.createdAt).toLocaleString()}</td>
                    <td style={{ textAlign: 'right' }}>
                      {imp.worksheetId ? (
                        <button className="btn sm ghost" onClick={() => navigate(`/worksheets/${imp.worksheetId}`)}>
                          Open worksheet
                        </button>
                      ) : (
                        <button className="btn sm" onClick={() => resume(imp.id)}>Resume</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Step 1 */}
      <form className="card" onSubmit={upload}>
        <h3>1. Upload the sheet</h3>
        <div className="field">
          <input ref={fileRef} type="file" accept=".docx,.pdf,.txt,.md" />
          <div className="hint">
            Word (.docx), PDF, or plain text. An old .doc file needs saving as .docx first.
          </div>
        </div>
        <button className="btn primary" disabled={busy === 'upload'}>
          {busy === 'upload' ? 'Reading…' : 'Upload and read'}
        </button>
      </form>

      {/* Step 2 */}
      {record && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>2. Check what was read, then draft</h3>
          <div className="row small muted" style={{ marginBottom: 10 }}>
            <span>{record.sourceName}</span>
            <span className="badge">{record.sourceType}</span>
            <span>{Math.round(record.sourceBytes / 1024)} KB</span>
          </div>

          {record.extractedText && (
            <details style={{ marginBottom: 12 }}>
              <summary className="small muted" style={{ cursor: 'pointer' }}>
                What the model will be given ({record.extractedText.length.toLocaleString()} characters)
              </summary>
              <pre className="block" style={{ marginTop: 8, maxHeight: 260 }}>{record.extractedText}</pre>
            </details>
          )}
          {record.sourceType === 'pdf' && (
            <p className="hint">This PDF is sent to the model as-is, so its layout is preserved.</p>
          )}

          <button className="btn primary" onClick={analyze}
            disabled={busy !== null || available === false || record.status === 'applied'}>
            {busy === 'analyze' ? 'Drafting and checking… this takes a minute' : 'Draft the worksheet'}
          </button>
          {record.error && <div className="notice error" style={{ marginTop: 10 }}>{record.error}</div>}
        </div>
      )}

      {/* Step 3 */}
      {draft && (
        <>
          <div className="page-head" style={{ marginTop: 26 }}>
            <div className="grow">
              <h2 style={{ margin: 0 }}>3. Review before creating</h2>
              {report && (
                <p className="sub" style={{ marginTop: 6 }}>
                  {report.verified} of {report.questions.length} questions have a checked expected
                  output{report.failed ? `, ${report.failed} could not be checked` : ''}
                  {report.teacherGraded ? `, ${report.teacherGraded} for you to grade` : ''}.
                </p>
              )}
            </div>
            <div className="btn-row">
              <button className="btn" onClick={recheck} disabled={busy !== null}>
                {busy === 'recheck' ? 'Re-running…' : 'Re-run checks'}
              </button>
              <button className="btn" onClick={saveEdits} disabled={busy !== null || !dirty}>
                {busy === 'save' ? 'Saving…' : 'Save edits'}
              </button>
              <button className="btn primary" onClick={apply} disabled={busy !== null}>
                {busy === 'apply' ? 'Creating…' : 'Create worksheet'}
              </button>
            </div>
          </div>

          {report?.failed > 0 && (
            <div className="notice warn">
              {report.failed} question{report.failed === 1 ? '' : 's'} could not be checked, so
              {report.failed === 1 ? ' it has' : ' they have'} no automatic checks and will need you
              to grade {report.failed === 1 ? 'it' : 'them'}. Nothing was invented — an unverified
              expected output would mark correct students wrong.
            </div>
          )}

          {draft.notesForTeacher?.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <h3>Notes from the draft</h3>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {draft.notesForTeacher.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="field">
              <label>Worksheet title</label>
              <input type="text" value={draft.title}
                onChange={(e) => { setRecord((r) => ({ ...r, draft: { ...r.draft, title: e.target.value } })); setDirty(true); }} />
            </div>
            {draft.datasetEngine && (
              <details>
                <summary className="small muted" style={{ cursor: 'pointer' }}>
                  Shared dataset ({draft.datasetEngine})
                </summary>
                <pre className="block" style={{ marginTop: 8, maxHeight: 240 }}>{draft.datasetScript}</pre>
              </details>
            )}
          </div>

          {draft.questions.map((q, i) => (
            <QuestionReview key={i} question={q} index={i}
              status={report?.questions?.[i]}
              onChange={(next) => setQuestion(i, next)} />
          ))}
        </>
      )}
    </div>
  );
}
