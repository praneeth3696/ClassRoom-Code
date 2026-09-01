import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Crumbs, Deadline, Empty, ErrorNotice, Loading, StatusBadge } from '../components/ui.jsx';

/** The class code teachers read out, with the controls Classroom gives them. */
function JoinCodePanel({ course, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);

  if (!course.joinCode) return null;

  const act = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); onChanged(); } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(course.joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError({ message: 'Could not copy. Select the code and copy it manually.' });
    }
  };

  return (
    <div className="card">
      <h3>Class code</h3>
      <p className="hint" style={{ marginBottom: 10 }}>
        Students join with this code from their own Classes page. Anyone with the code can join,
        so rotate it if it leaks outside the batch.
      </p>
      <ErrorNotice error={error} />
      <div className="row" style={{ marginBottom: 10 }}>
        <code style={{
          fontSize: 26, letterSpacing: '0.18em', fontWeight: 700,
          padding: '8px 14px', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)',
        }}>{course.joinCode}</code>
        <button className="btn sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <div className="btn-row">
        <button className="btn sm ghost" disabled={busy}
          onClick={() => act(() => api.rotateJoinCode(course.id))}>
          Reset code
        </button>
        <label className="check">
          <input type="checkbox" checked={course.joinEnabled} disabled={busy}
            onChange={(e) => act(() => api.setJoinEnabled(course.id, e.target.checked))} />
          Accepting new students
        </label>
      </div>
    </div>
  );
}

function Roster({ course, onChanged }) {
  const [emails, setEmails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);

  const add = async (e) => {
    e.preventDefault();
    const people = emails.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).map((email) => ({ email }));
    if (people.length === 0) return;
    setBusy(true); setError(null); setOk(null);
    try {
      const res = await api.addStudents(course.id, people);
      setOk(`Enrolled ${res.students.length} student${res.students.length === 1 ? '' : 's'}.`);
      setEmails('');
      onChanged();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <h3>Roster</h3>
      <div className="row small muted" style={{ marginBottom: 10 }}>
        <span>{course.teachers?.length ?? 0} teaching · {course.students?.length ?? 0} enrolled</span>
      </div>

      <ErrorNotice error={error} />
      {ok && <div className="notice ok">{ok}</div>}

      <form onSubmit={add} className="field">
        <label htmlFor="roster">Enrol students by email</label>
        <textarea id="roster" value={emails} onChange={(e) => setEmails(e.target.value)}
          placeholder="one per line, or comma separated" rows={3} />
        <div className="hint">
          Students who have never signed in are created as placeholders — their Google account
          claims the row on first sign-in, keeping their enrolment.
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="btn primary sm" disabled={busy || !emails.trim()}>
            {busy ? 'Enrolling…' : 'Enrol students'}
          </button>
        </div>
      </form>

      {course.students?.length > 0 && (
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            View enrolled students
          </summary>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table>
              <tbody>
                {course.students.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="small muted">{s.email}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

export default function CourseDetail() {
  const { courseId } = useParams();
  const { isTeacher } = useAuth();
  const [course, setCourse] = useState(null);
  const [worksheets, setWorksheets] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.course(courseId), api.worksheets(courseId)])
      .then(([c, w]) => { setCourse(c.course); setWorksheets(w.worksheets); })
      .catch(setError);
  }, [courseId]);
  useEffect(load, [load]);

  if (error) return <div className="container"><ErrorNotice error={error} onRetry={load} /></div>;
  if (!course) return <Loading />;

  return (
    <div className="container">
      <Crumbs items={[{ label: 'Courses', to: '/' }, { label: course.name }]} />

      <div className="page-head">
        <div className="grow">
          <h1>{course.name}</h1>
          <p className="sub">
            {course.subjectCode || course.code ? `${course.subjectCode || course.code} · ` : ''}
            {course.programmeName ? `${course.programmeName}` : course.department}
            {course.batchLabel ? ` · ${course.batchLabel}` : ''}
            {course.academicYear ? ` · ${course.academicYear}` : ''}
          </p>
          {course.teachers?.length > 0 && (
            <p className="sub small">Taught by {course.teachers.map((t) => t.name).join(', ')}</p>
          )}
        </div>
        {isTeacher && (
          <div className="btn-row">
            <Link className="btn" to={`/courses/${courseId}/import`}>Import from a sheet</Link>
            <Link className="btn primary" to={`/courses/${courseId}/worksheets/new`}>New worksheet</Link>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: isTeacher ? 'minmax(0, 2fr) minmax(280px, 1fr)' : '1fr' }}>
        <div>
          <h2>Worksheets</h2>
          {worksheets?.length === 0 ? (
            <Empty title="No worksheets yet">
              {isTeacher ? 'Create one to get started.' : 'Your teacher has not published any yet.'}
            </Empty>
          ) : (
            worksheets?.map((w) => (
              <Link key={w.id} to={`/worksheets/${w.id}`} className="card card-link" style={{ marginBottom: 10 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <h3 style={{ margin: 0 }}>{w.title}</h3>
                  {isTeacher && <StatusBadge status={w.status} />}
                  {!isTeacher && w.submissionOpen === false && <span className="badge fail">Closed</span>}
                </div>
                {w.description && <p className="small muted" style={{ margin: '6px 0 0' }}>{w.description}</p>}
                <div className="row small muted" style={{ marginTop: 10, gap: 14 }}>
                  <span>{w.questionCount} question{w.questionCount === 1 ? '' : 's'}</span>
                  <span><Deadline value={w.deadline} /></span>
                </div>
              </Link>
            ))
          )}
        </div>

        {isTeacher && (
          <div className="stack">
            <JoinCodePanel course={course} onChanged={load} />
            <Roster course={course} onChanged={load} />
          </div>
        )}
      </div>
    </div>
  );
}
