import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Avatar, ErrorNotice, Spinner } from '../components/ui.jsx';

export default function SignIn() {
  const { meta, signInAsDev } = useAuth();
  const [params] = useSearchParams();
  const [devUsers, setDevUsers] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const oauthError = params.get('error');
  const devLoginEnabled = meta?.auth?.devLogin;

  useEffect(() => {
    if (!devLoginEnabled) return;
    api.devUsers().then((r) => setDevUsers(r.users)).catch(setError);
  }, [devLoginEnabled]);

  const pick = async (email) => {
    setBusy(email);
    setError(null);
    try {
      await signInAsDev(email);
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  };

  const domains = meta?.auth?.allowedEmailDomains ?? [];

  return (
    <div className="container">
      <div className="card signin-card">
        <h1>Sign in</h1>
        <p className="muted">
          Coding labs for your course — worksheets, an in-browser editor, and feedback from your teacher.
        </p>

        {oauthError && <div className="notice error">{oauthError}</div>}
        <ErrorNotice error={error} />

        {meta?.auth?.google ? (
          <a className="btn primary" style={{ width: '100%' }} href="/api/auth/google/start">
            Continue with Google
          </a>
        ) : (
          <div className="notice info">
            Google sign-in is not configured on this server yet.
          </div>
        )}

        {domains.length > 0 && (
          <p className="hint">Sign-in is restricted to {domains.join(', ')}.</p>
        )}

        {devLoginEnabled && (
          <>
            <hr style={{ margin: '20px 0', border: 0, borderTop: '1px solid var(--border)' }} />
            <h3>Development sign-in</h3>
            <p className="hint" style={{ marginBottom: 12 }}>
              Available because <code>DEV_LOGIN</code> is on. Choose a seeded account to explore
              the app without Google credentials. This is refused in production.
            </p>
            {devUsers.length === 0 && <Spinner label="Loading accounts…" />}
            {devUsers.map((u) => (
              <button key={u.id} className="user-pick" onClick={() => pick(u.email)} disabled={busy}>
                <Avatar user={u} />
                <span className="grow">
                  <div style={{ fontWeight: 550 }}>{u.name}</div>
                  <div className="small muted">{u.email}</div>
                </span>
                <span className={`badge ${u.role === 'teacher' ? 'info' : ''}`}>{u.role}</span>
                {busy === u.email && <span className="spinner" />}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
