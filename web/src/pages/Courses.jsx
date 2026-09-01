import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Empty, ErrorNotice, Loading } from '../components/ui.jsx';

/** Google Classroom style: the student types the code their teacher shared. */
function JoinClass({ onJoined }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [joined, setJoined] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null); setJoined(null);
    try {
      const res = await api.joinCourse(code.trim());
      setJoined(res.course.name);
      setCode('');
      onJoined();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  if (!open) {
    return <button className="btn" onClick={() => setOpen(true)}>Join a class</button>;
  }
  return (
    <form className="card" onSubmit={submit} style={{ minWidth: 300 }}>
      <h3>Join a class</h3>
      <p className="hint" style={{ marginBottom: 10 }}>
        Enter the class code your teacher gave you. It is six characters, like <code>K4M2QX</code>.
      </p>
      <ErrorNotice error={error} />
      {joined && <div className="notice ok">Joined {joined}.</div>}
      <div className="row">
        <input
          type="text" value={code} autoFocus
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Class code" maxLength={8}
          style={{ textTransform: 'uppercase', letterSpacing: '0.12em', fontFamily: 'var(--mono)', maxWidth: 160 }}
        />
        <button className="btn primary" disabled={busy || code.trim().length < 4}>
          {busy ? 'Joining...' : 'Join'}
        </button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Close</button>
      </div>
    </form>
  );
}

function CreateClass({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [programmes, setProgrammes] = useState([]);
  const [subjects, setSubjects] = useState([]);
  const [batches, setBatches] = useState([]);
  const [form, setForm] = useState({ programmeId: '', subjectId: '', batchId: '', name: '', academicYear: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    api.programmes().then((r) => setProgrammes(r.programmes)).catch(setError);
  }, [open]);

  useEffect(() => {
    if (!form.programmeId) { setSubjects([]); setBatches([]); return; }
    Promise.all([api.subjects({ programmeId: form.programmeId }), api.batches(form.programmeId)])
      .then(([s, b]) => { setSubjects(s.subjects); setBatches(b.batches); })
      .catch(setError);
  }, [form.programmeId]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.createCourse({
        subjectId: form.subjectId || null,
        batchId: form.batchId || null,
        name: form.subjectId ? undefined : form.name.trim(),
        academicYear: form.academicYear.trim() || null,
      });
      setOpen(false);
      setForm({ programmeId: '', subjectId: '', batchId: '', name: '', academicYear: '' });
      onCreated();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  if (!open) return <button className="btn primary" onClick={() => setOpen(true)}>New class</button>;

  const chosenSubject = subjects.find((s) => s.id === form.subjectId);

  return (
    <form className="card" onSubmit={submit} style={{ minWidth: 380 }}>
      <h3>New class</h3>
      <p className="hint" style={{ marginBottom: 12 }}>
        A class is one subject taught to one batch. Picking a batch enrols every student in it,
        and you get a join code for anyone who is not on the roll yet.
      </p>
      <ErrorNotice error={error} />

      <div className="field">
        <label htmlFor="prog">Programme</label>
        <select id="prog" value={form.programmeId}
          onChange={(e) => setForm({ ...form, programmeId: e.target.value, subjectId: '', batchId: '' })}>
          <option value="">Choose a programme...</option>
          {programmes.map((p) => (
            <option key={p.id} value={p.id}>{p.degree} {p.name}</option>
          ))}
        </select>
      </div>

      {form.programmeId && (
        <>
          <div className="field">
            <label htmlFor="subj">Subject</label>
            <select id="subj" value={form.subjectId}
              onChange={(e) => setForm({ ...form, subjectId: e.target.value })}>
              <option value="">Choose a subject...</option>
              <optgroup label="Lab subjects">
                {subjects.filter((s) => s.kind === 'lab').map((s) => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </optgroup>
              <optgroup label="Theory subjects">
                {subjects.filter((s) => s.kind === 'theory').map((s) => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </optgroup>
            </select>
            {chosenSubject && (
              <div className="hint">
                Semester {chosenSubject.semester ?? '-'} · {chosenSubject.kind === 'lab' ? 'Lab' : 'Theory'} subject
              </div>
            )}
          </div>

          <div className="field">
            <label htmlFor="batch">Batch</label>
            <select id="batch" value={form.batchId}
              onChange={(e) => setForm({ ...form, batchId: e.target.value })}>
              <option value="">No batch — students join by code</option>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.admissionYear} intake{b.section ? ` · Section ${b.section}` : ''} ({b.studentCount} students)
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      {!form.subjectId && (
        <div className="field">
          <label htmlFor="cname">Class name</label>
          <input id="cname" type="text" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Needed only if you are not choosing a subject" />
        </div>
      )}

      <div className="field" style={{ maxWidth: 180 }}>
        <label htmlFor="ay">Academic year</label>
        <input id="ay" type="text" value={form.academicYear}
          onChange={(e) => setForm({ ...form, academicYear: e.target.value })} placeholder="2026-27" />
      </div>

      <div className="btn-row">
        <button className="btn primary" disabled={busy || (!form.subjectId && form.name.trim().length < 2)}>
          {busy ? 'Creating...' : 'Create class'}
        </button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

function CourseCard({ course, isTeacher }) {
  return (
    <Link to={`/courses/${course.id}`} className="card card-link">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <h3 style={{ marginBottom: 4 }}>{course.name}</h3>
        {course.subjectKind && (
          <span className={`badge ${course.subjectKind === 'lab' ? 'info' : ''}`}>
            {course.subjectKind === 'lab' ? 'Lab' : 'Theory'}
          </span>
        )}
      </div>
      <div className="small muted">
        {course.subjectCode || course.code || 'No code'}
        {course.batchLabel ? ` · ${course.batchLabel}` : ''}
      </div>
      {course.academicYear && (
        <div className="small faint">{course.academicYear}{course.semester ? ` · Semester ${course.semester}` : ''}</div>
      )}
      <div className="row small muted" style={{ marginTop: 12, gap: 14 }}>
        <span>{course.worksheetCount} worksheet{course.worksheetCount === 1 ? '' : 's'}</span>
        {isTeacher && <span>{course.studentCount} student{course.studentCount === 1 ? '' : 's'}</span>}
        {isTeacher && course.teacherCount > 1 && <span>{course.teacherCount} teachers</span>}
      </div>
    </Link>
  );
}

export default function Courses() {
  const { user, isTeacher } = useAuth();
  const [courses, setCourses] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    api.courses().then((r) => setCourses(r.courses)).catch(setError);
  }, []);
  useEffect(load, [load]);

  if (!courses && !error) return <Loading />;

  // Group by programme so a teacher across several programmes sees structure
  // rather than one long list.
  const groups = new Map();
  for (const c of courses ?? []) {
    const key = c.programmeName || 'Other classes';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  return (
    <div className="container">
      <div className="page-head">
        <div className="grow">
          <h1>{isTeacher ? 'Classes you handle' : 'Your classes'}</h1>
          <p className="sub">
            {isTeacher
              ? 'Each class is one subject taught to one batch.'
              : `Signed in as ${user.name}${user.rollNumber ? ` · ${user.rollNumber}` : ''}.`}
          </p>
        </div>
        <div className="btn-row">
          {!isTeacher && <JoinClass onJoined={load} />}
          {isTeacher && <CreateClass onCreated={load} />}
        </div>
      </div>

      <ErrorNotice error={error} onRetry={load} />

      {courses?.length === 0 ? (
        <Empty title={isTeacher ? 'No classes yet' : 'You are not in any class yet'}>
          {isTeacher
            ? 'Create a class to start publishing lab worksheets.'
            : 'Ask your teacher for the class code, then use Join a class above.'}
        </Empty>
      ) : (
        [...groups.entries()].map(([programme, list]) => (
          <div key={programme} style={{ marginBottom: 26 }}>
            {groups.size > 1 && <h2 style={{ marginBottom: 12 }}>{programme}</h2>}
            <div className="grid">
              {list.map((c) => <CourseCard key={c.id} course={c} isTeacher={isTeacher} />)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
