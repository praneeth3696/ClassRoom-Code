import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { AutoResultBadge, Crumbs, Deadline, Empty, ErrorNotice, Loading, StatusBadge } from '../components/ui.jsx';

function StudentQuestionRow({ q, index }) {
  const mine = q.mine;
  return (
    <Link to={`/questions/${q.id}`} className="q-item">
      <span className="q-num">{index + 1}</span>
      <span className="grow">
        <div className="title">{q.title}</div>
        <div className="small muted">
          {q.testCaseCount > 0
            ? `${q.testCaseCount} test case${q.testCaseCount === 1 ? '' : 's'}`
            : 'Graded by your teacher'}
          {q.points != null && ` · ${q.points} points`}
        </div>
      </span>
      {mine?.late && <span className="badge warn">Late</span>}
      {mine?.feedback && <span className="badge info">Feedback</span>}
      {mine?.status === 'submitted'
        ? <AutoResultBadge autoPassed={mine.autoPassed} compact />
        : <span className="badge">{mine ? 'Draft' : 'Not started'}</span>}
    </Link>
  );
}

function TeacherQuestionRow({ q, index, enrolledCount }) {
  const s = q.stats;
  return (
    <div className="q-item">
      <span className="q-num">{index + 1}</span>
      <span className="grow">
        <div className="title">{q.title}</div>
        <div className="small muted">
          {s.submitted} of {enrolledCount} submitted
          {q.testCaseCount > 0 && ` · ${s.passed} passing, ${s.failed} failing`}
          {s.reviewed > 0 && ` · ${s.reviewed} reviewed`}
        </div>
      </span>
      <Link className="btn sm" to={`/questions/${q.id}/submissions`}>
        Review{s.submitted > 0 ? ` (${s.submitted})` : ''}
      </Link>
    </div>
  );
}

export default function WorksheetView() {
  const { worksheetId } = useParams();
  const { isTeacher } = useAuth();
  const navigate = useNavigate();
  const [worksheet, setWorksheet] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.worksheet(worksheetId), api.worksheetProgress(worksheetId)])
      .then(([w, p]) => { setWorksheet(w.worksheet); setProgress(p); })
      .catch(setError);
  }, [worksheetId]);
  useEffect(load, [load]);

  const togglePublish = async () => {
    setBusy(true); setError(null);
    try {
      if (worksheet.status === 'published') await api.unpublishWorksheet(worksheetId);
      else await api.publishWorksheet(worksheetId);
      load();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const remove = async () => {
    setError(null);
    try {
      await api.deleteWorksheet(worksheetId);
      navigate(`/courses/${worksheet.courseId}`);
    } catch (err) {
      if (err.status === 409 && window.confirm(`${err.message}\n\nDelete anyway?`)) {
        await api.deleteWorksheet(worksheetId, true);
        navigate(`/courses/${worksheet.courseId}`);
      } else setError(err);
    }
  };

  if (error && !worksheet) return <div className="container"><ErrorNotice error={error} onRetry={load} /></div>;
  if (!worksheet || !progress) return <Loading />;

  const questions = progress.questions;

  return (
    <div className="container">
      <Crumbs items={[
        { label: 'Courses', to: '/' },
        { label: 'Course', to: `/courses/${worksheet.courseId}` },
        { label: worksheet.title },
      ]} />

      <div className="page-head">
        <div className="grow">
          <div className="row">
            <h1 style={{ margin: 0 }}>{worksheet.title}</h1>
            {isTeacher && <StatusBadge status={worksheet.status} />}
          </div>
          {worksheet.description && <p className="sub" style={{ marginTop: 8 }}>{worksheet.description}</p>}
          <div className="row small muted" style={{ marginTop: 8, gap: 14 }}>
            <span>Due <Deadline value={worksheet.deadline} /></span>
            {worksheet.allowLateSubmissions && <span className="badge warn">Late submissions allowed</span>}
          </div>
        </div>
        {isTeacher && (
          <div className="btn-row">
            <a className="btn" href={`/api/worksheets/${worksheetId}/export.csv`} download>Export CSV</a>
            <Link className="btn" to={`/worksheets/${worksheetId}/edit`}>Edit</Link>
            <button className="btn primary" onClick={togglePublish} disabled={busy}>
              {worksheet.status === 'published' ? 'Unpublish' : 'Publish'}
            </button>
            <button className="btn danger" onClick={remove}>Delete</button>
          </div>
        )}
      </div>

      <ErrorNotice error={error} />

      {!isTeacher && worksheet.submissionOpen === false && (
        <div className="notice warn">
          {worksheet.submissionClosedReason || 'This worksheet is closed for submissions.'}
          {' '}You can still open the questions and run your code.
        </div>
      )}
      {isTeacher && worksheet.status === 'draft' && (
        <div className="notice info">
          This worksheet is a draft — students cannot see it yet. Publish it when it is ready.
        </div>
      )}

      {questions.length === 0 ? (
        <Empty title="No questions yet">
          {isTeacher ? 'Edit the worksheet to add questions.' : 'Your teacher has not added any questions.'}
        </Empty>
      ) : (
        questions.map((q, i) => (isTeacher
          ? <TeacherQuestionRow key={q.id} q={q} index={i} enrolledCount={progress.enrolledCount ?? 0} />
          : <StudentQuestionRow key={q.id} q={q} index={i} />))
      )}
    </div>
  );
}
