import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import { Avatar, ErrorNotice, Loading } from './components/ui.jsx';
import SignIn from './pages/SignIn.jsx';
import Courses from './pages/Courses.jsx';
import CourseDetail from './pages/CourseDetail.jsx';
import WorksheetView from './pages/WorksheetView.jsx';
import QuestionWorkspace from './pages/QuestionWorkspace.jsx';
import WorksheetEditor from './pages/WorksheetEditor.jsx';
import SubmissionsReview from './pages/SubmissionsReview.jsx';
import ImportWorksheet from './pages/ImportWorksheet.jsx';

function TopBar() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <header className="topbar">
      <Link className="brand" to="/">Classroom</Link>
      <span className="spacer" />
      {user && (
        <div className="who">
          <Avatar user={user} />
          <span>
            {user.name}
            <span className="badge" style={{ marginLeft: 8 }}>{user.role}</span>
          </span>
          <button
            className="btn sm ghost"
            onClick={async () => { await signOut(); navigate('/signin'); }}
          >
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}

export default function App() {
  const { user, loading, error, refresh } = useAuth();

  if (loading) return <Loading label="Starting up…" />;

  if (error && !user) {
    return (
      <div className="container">
        <ErrorNotice error={error} onRetry={refresh} />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="app">
        <TopBar />
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="*" element={<Navigate to="/signin" replace />} />
        </Routes>
      </div>
    );
  }

  // One application, role-based views (SPEC.md §1). Routes are shared; each
  // page renders the teacher or student variant from the signed-in role.
  return (
    <div className="app">
      <TopBar />
      <Routes>
        <Route path="/" element={<Courses />} />
        <Route path="/signin" element={<Navigate to="/" replace />} />
        <Route path="/courses/:courseId" element={<CourseDetail />} />
        <Route path="/worksheets/:worksheetId" element={<WorksheetView />} />
        <Route path="/worksheets/:worksheetId/edit" element={<WorksheetEditor />} />
        <Route path="/courses/:courseId/worksheets/new" element={<WorksheetEditor create />} />
        <Route path="/courses/:courseId/import" element={<ImportWorksheet />} />
        <Route path="/questions/:questionId" element={<QuestionWorkspace />} />
        <Route path="/questions/:questionId/submissions" element={<SubmissionsReview />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
