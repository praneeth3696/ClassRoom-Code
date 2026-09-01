import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Crumbs, ErrorNotice, Loading } from '../components/ui.jsx';

const emptyQuestion = (defaultLanguage = 'python') => ({
  key: crypto.randomUUID(),
  id: null,
  title: '',
  description: '',
  referenceNotes: '',
  allowedLanguages: [defaultLanguage],
  points: '',
  setupScript: '',
  orderedComparison: false,
  testCases: [],
});

const emptyTestCase = () => ({ key: crypto.randomUUID(), label: '', input: '', expectedOutput: '' });

/** Converts an ISO instant to the value a datetime-local input expects. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TestCaseEditor({ testCase, onChange, onRemove, index, isDatabase }) {
  return (
    <div className="card" style={{ background: 'var(--surface-2)', padding: 12, marginBottom: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <strong className="small">{isDatabase ? 'Check' : 'Test case'} {index + 1}</strong>
        <button type="button" className="btn sm ghost" onClick={onRemove}>Remove</button>
      </div>
      <div className="field">
        <input type="text" placeholder="Label (optional), e.g. handles negatives"
          value={testCase.label} onChange={(e) => onChange({ ...testCase, label: e.target.value })} />
      </div>
      <div className="field-row">
        <div className="field">
          <label>{isDatabase ? 'Verification query (optional)' : 'Input (stdin)'}</label>
          <textarea className="mono" rows={3} value={testCase.input}
            onChange={(e) => onChange({ ...testCase, input: e.target.value })}
            placeholder={isDatabase ? 'SELECT count(*) AS n FROM customer_2;' : ''} />
          {isDatabase && (
            <div className="hint">
              Leave empty to judge whatever the student's own script returns. Fill it in when the
              student is asked to create or insert something: it runs after their script.
            </div>
          )}
        </div>
        <div className="field">
          <label>Expected {isDatabase ? 'result' : 'output'}</label>
          <textarea className="mono" rows={3} value={testCase.expectedOutput}
            onChange={(e) => onChange({ ...testCase, expectedOutput: e.target.value })}
            placeholder={isDatabase ? '[{"name":"Ram"},{"name":"Priya"}]' : ''} />
        </div>
      </div>
      <div className="hint">
        {isDatabase
          ? 'Paste JSON rows or a pipe-separated table. Column name case and column order are ignored; row order is ignored unless you tick "row order matters".'
          : 'Trailing spaces and the final newline are ignored when comparing, so students are not failed for invisible whitespace.'}
      </div>
    </div>
  );
}

function QuestionEditor({ question, index, languages, onChange, onRemove }) {
  const set = (patch) => onChange({ ...question, ...patch });
  const kindOf = (id) => languages.find((l) => l.id === id)?.kind ?? 'program';
  const isDatabase = question.allowedLanguages.some((l) => kindOf(l) === 'database');

  const toggleLang = (id) => {
    const has = question.allowedLanguages.includes(id);
    // A question is judged either on stdout or on returned rows, so ticking a
    // database engine clears the program languages and the other way round.
    const kept = has
      ? question.allowedLanguages.filter((l) => l !== id)
      : [...question.allowedLanguages.filter((l) => kindOf(l) === kindOf(id)), id];
    set({ allowedLanguages: kept });
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Question {index + 1}</h3>
        <button type="button" className="btn sm danger" onClick={onRemove}>Remove question</button>
      </div>

      <div className="field">
        <label>Title</label>
        <input type="text" required value={question.title}
          onChange={(e) => set({ title: e.target.value })} placeholder="Sum of two integers" />
      </div>

      <div className="field">
        <label>Description</label>
        <textarea rows={4} value={question.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="Read two integers from standard input and print their sum." />
      </div>

      <div className="field">
        <label>References <span className="faint">(optional)</span></label>
        <textarea rows={2} value={question.referenceNotes}
          onChange={(e) => set({ referenceNotes: e.target.value })}
          placeholder="Hints, textbook sections, or notes to help the student." />
      </div>

      <div className="field-row">
        <div className="field">
          <label>Allowed languages</label>
          <div className="row" style={{ marginBottom: 6 }}>
            {languages.filter((l) => l.kind === 'program').map((l) => (
              <label key={l.id} className="check">
                <input type="checkbox" checked={question.allowedLanguages.includes(l.id)}
                  onChange={() => toggleLang(l.id)} />
                {l.label}
              </label>
            ))}
          </div>
          <div className="row">
            {languages.filter((l) => l.kind === 'database').map((l) => (
              <label key={l.id} className="check" title={l.blurb ?? ''}>
                <input type="checkbox" checked={question.allowedLanguages.includes(l.id)}
                  onChange={() => toggleLang(l.id)} />
                {l.label}
              </label>
            ))}
          </div>
          <div className="hint">
            A question is judged either on printed output or on the rows a query returns, so it
            cannot mix the two. Ticking a database engine clears the program languages.
          </div>
          {question.allowedLanguages.length === 0 && (
            <div className="hint" style={{ color: 'var(--fail)' }}>Choose at least one language.</div>
          )}
        </div>
        <div className="field" style={{ maxWidth: 150 }}>
          <label>Points <span className="faint">(optional)</span></label>
          <input type="number" min="0" step="1" value={question.points}
            onChange={(e) => set({ points: e.target.value })} />
        </div>
      </div>

      {isDatabase && (
        <>
          <div className="field">
            <label>Extra setup for this question <span className="faint">(optional)</span></label>
            <textarea className="mono" rows={3} value={question.setupScript}
              onChange={(e) => set({ setupScript: e.target.value })}
              placeholder="Runs after the worksheet dataset, before the student's script." />
            <div className="hint">
              Use this only when one question needs data the rest of the worksheet does not.
            </div>
          </div>
          <div className="field">
            <label className="check">
              <input type="checkbox" checked={question.orderedComparison}
                onChange={(e) => set({ orderedComparison: e.target.checked })} />
              Row order matters (the question tests ORDER BY or $sort)
            </label>
            <div className="hint">
              Off by default: a query without ORDER BY has no defined row order, so students should
              not be failed for a different sequence.
            </div>
          </div>
        </>
      )}

      <div className="field">
        <label>{isDatabase ? 'Checks' : 'Test cases'}</label>
        <div className="hint" style={{ marginBottom: 8 }}>
          {isDatabase
            ? 'Students can see these. Leave empty for questions you will read and grade yourself.'
            : 'Every test case is visible to students. Leave this empty for open-ended questions you will grade yourself.'}
        </div>
        {question.testCases.map((tc, i) => (
          <TestCaseEditor key={tc.key} testCase={tc} index={i} isDatabase={isDatabase}
            onChange={(next) => set({ testCases: question.testCases.map((t) => (t.key === tc.key ? next : t)) })}
            onRemove={() => set({ testCases: question.testCases.filter((t) => t.key !== tc.key) })} />
        ))}
        <button type="button" className="btn sm"
          onClick={() => set({ testCases: [...question.testCases, emptyTestCase()] })}>
          Add {isDatabase ? 'check' : 'test case'}
        </button>
      </div>
    </div>
  );
}

export default function WorksheetEditor({ create = false }) {
  const { courseId: routeCourseId, worksheetId } = useParams();
  const { meta } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    title: '', description: '', deadline: '', allowLateSubmissions: false,
    datasetEngine: '', datasetScript: '',
  });
  const [questions, setQuestions] = useState(create ? [emptyQuestion()] : []);
  const [courseId, setCourseId] = useState(routeCourseId ?? null);
  const [loading, setLoading] = useState(!create);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (create) return;
    try {
      const { worksheet } = await api.worksheet(worksheetId);
      setCourseId(worksheet.courseId);
      setForm({
        title: worksheet.title,
        description: worksheet.description ?? '',
        deadline: toLocalInput(worksheet.deadline),
        allowLateSubmissions: worksheet.allowLateSubmissions,
        datasetEngine: worksheet.datasetEngine ?? '',
        datasetScript: worksheet.datasetScript ?? '',
      });
      setQuestions(worksheet.questions.map((q) => ({
        key: q.id, id: q.id, title: q.title, description: q.description,
        referenceNotes: q.referenceNotes ?? '', allowedLanguages: q.allowedLanguages,
        points: q.points ?? '',
        setupScript: q.setupScript ?? '',
        orderedComparison: Boolean(q.orderedComparison),
        testCases: q.testCases.map((tc) => ({
          key: tc.id, label: tc.label ?? '', input: tc.input, expectedOutput: tc.expectedOutput,
        })),
      })));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [create, worksheetId]);

  useEffect(() => { load(); }, [load]);

  const serialize = (q) => ({
    title: q.title.trim(),
    description: q.description,
    referenceNotes: q.referenceNotes.trim() || null,
    allowedLanguages: q.allowedLanguages,
    points: q.points === '' ? null : Number(q.points),
    setupScript: (q.setupScript ?? '').trim() || null,
    orderedComparison: Boolean(q.orderedComparison),
    testCases: q.testCases.map((tc) => ({
      label: tc.label.trim() || null, input: tc.input, expectedOutput: tc.expectedOutput,
    })),
  });

  /**
   * Choosing a dataset engine points untouched questions at it.
   *
   * Without this a teacher picks "MongoDB" for the worksheet and question 1 is
   * still a Python question, so none of the database fields appear and they
   * have to untick Python by hand on every question. Only questions the teacher
   * has not started filling in are changed.
   */
  const applyEngineToBlankQuestions = (engine) => {
    if (!engine) return;
    setQuestions((current) => current.map((q) => {
      const untouched = !q.id && !q.title.trim() && !q.description.trim() && q.testCases.length === 0;
      return untouched ? { ...q, allowedLanguages: [engine] } : q;
    }));
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true); setError(null);
    const payload = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      deadline: form.deadline ? new Date(form.deadline).toISOString() : null,
      allowLateSubmissions: form.allowLateSubmissions,
      datasetEngine: form.datasetEngine || null,
      datasetScript: form.datasetScript.trim() || null,
    };
    try {
      if (create) {
        const res = await api.createWorksheet(courseId, { ...payload, questions: questions.map(serialize) });
        navigate(`/worksheets/${res.worksheet.id}`);
        return;
      }
      await api.updateWorksheet(worksheetId, payload);
      // Existing questions are patched; new ones appended; removed ones deleted.
      const { worksheet: current } = await api.worksheet(worksheetId);
      const keptIds = new Set(questions.filter((q) => q.id).map((q) => q.id));
      for (const existing of current.questions) {
        if (!keptIds.has(existing.id)) {
          try { await api.deleteQuestion(existing.id); }
          catch (err) {
            if (err.status === 409 && window.confirm(`${err.message}\n\nDelete anyway?`)) {
              await api.deleteQuestion(existing.id, true);
            } else throw err;
          }
        }
      }
      for (const q of questions) {
        if (q.id) await api.updateQuestion(q.id, serialize(q));
        else await api.addQuestion(worksheetId, serialize(q));
      }
      navigate(`/worksheets/${worksheetId}`);
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  };

  if (loading) return <Loading />;

  const invalid = form.title.trim().length < 2
    || questions.length === 0
    || questions.some((q) => !q.title.trim() || q.allowedLanguages.length === 0);

  return (
    <div className="container">
      <Crumbs items={[
        { label: 'Courses', to: '/' },
        { label: 'Course', to: `/courses/${courseId}` },
        { label: create ? 'New worksheet' : 'Edit worksheet' },
      ]} />

      <h1>{create ? 'New worksheet' : 'Edit worksheet'}</h1>
      <ErrorNotice error={error} />

      <form onSubmit={save}>
        <div className="card">
          <div className="field">
            <label>Title</label>
            <input type="text" required value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Worksheet 1 — Input, Output and Conditionals" />
          </div>
          <div className="field">
            <label>Description <span className="faint">(optional)</span></label>
            <textarea rows={2} value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Deadline <span className="faint">(optional)</span></label>
              <input type="datetime-local" value={form.deadline}
                onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
              <div className="hint">Submissions lock at the deadline unless late submissions are allowed.</div>
            </div>
            <div className="field">
              <label>&nbsp;</label>
              <label className="check">
                <input type="checkbox" checked={form.allowLateSubmissions}
                  onChange={(e) => setForm({ ...form, allowLateSubmissions: e.target.checked })} />
                Allow submissions after the deadline
              </label>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 14 }}>
          <h3>Shared dataset <span className="faint" style={{ fontWeight: 400 }}>(database worksheets only)</span></h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            The schema and seed data every database question on this worksheet runs against, so
            twenty queries over one dataset do not each repeat it. Each student gets a fresh copy
            on every Run, so nothing they write affects anyone else.
          </p>
          <div className="field" style={{ maxWidth: 260 }}>
            <label htmlFor="dsengine">Engine</label>
            <select id="dsengine" value={form.datasetEngine}
              onChange={(e) => {
                setForm({ ...form, datasetEngine: e.target.value });
                applyEngineToBlankQuestions(e.target.value);
              }}>
              <option value="">Not a database worksheet</option>
              {(meta?.languages ?? []).filter((l) => l.kind === 'database').map((l) => (
                <option key={l.id} value={l.id}>{l.label}</option>
              ))}
            </select>
            {form.datasetEngine && (
              <div className="hint">
                {(meta?.languages ?? []).find((l) => l.id === form.datasetEngine)?.blurb}
              </div>
            )}
          </div>
          {form.datasetEngine && (
            <div className="field">
              <label htmlFor="dsscript">Setup script</label>
              <textarea id="dsscript" className="mono" rows={10} value={form.datasetScript}
                onChange={(e) => setForm({ ...form, datasetScript: e.target.value })}
                placeholder={form.datasetEngine === 'mongodb'
                  ? 'db.book.insertMany([ ... ]);'
                  : 'CREATE TABLE customer (...);\nINSERT INTO customer VALUES (...);'} />
              <div className="hint">
                Students can read this, so they know the table and field names without guessing.
              </div>
            </div>
          )}
        </div>

        <h2 style={{ marginTop: 22 }}>Questions</h2>
        {questions.map((q, i) => (
          <QuestionEditor key={q.key} question={q} index={i} languages={meta?.languages ?? []}
            onChange={(next) => setQuestions(questions.map((x) => (x.key === q.key ? next : x)))}
            onRemove={() => setQuestions(questions.filter((x) => x.key !== q.key))} />
        ))}

        <div className="btn-row" style={{ marginTop: 8 }}>
          <button type="button" className="btn"
            onClick={() => setQuestions([...questions, emptyQuestion(form.datasetEngine || 'python')])}>
            Add question
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn ghost" onClick={() => navigate(-1)}>Cancel</button>
          <button className="btn primary" disabled={saving || invalid}>
            {saving ? 'Saving…' : create ? 'Create worksheet' : 'Save changes'}
          </button>
        </div>
        {invalid && (
          <p className="hint" style={{ marginTop: 8 }}>
            A worksheet needs a title and at least one question, and every question needs a title
            and one language.
          </p>
        )}
      </form>
    </div>
  );
}
