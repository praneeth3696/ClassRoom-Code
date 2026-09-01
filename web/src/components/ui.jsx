import { Link } from 'react-router-dom';

export function Spinner({ label }) {
  return (
    <span className="row small muted">
      <span className="spinner" /> {label}
    </span>
  );
}

export function Loading({ label = 'Loading…' }) {
  return <div className="center-page"><Spinner label={label} /></div>;
}

export function ErrorNotice({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="notice error">
      <strong>{error.message}</strong>
      {Array.isArray(error.details) && error.details.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {error.details.map((d, i) => <li key={i}>{d.field}: {d.message}</li>)}
        </ul>
      )}
      {onRetry && <div style={{ marginTop: 8 }}><button className="btn sm" onClick={onRetry}>Try again</button></div>}
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}

export function Crumbs({ items }) {
  return (
    <nav className="crumbs">
      {items.map((item, i) => (
        <span key={i}>
          {item.to ? <Link to={item.to}>{item.label}</Link> : <span>{item.label}</span>}
          {i < items.length - 1 && <span className="faint"> / </span>}
        </span>
      ))}
    </nav>
  );
}

export function Avatar({ user }) {
  const initials = (user?.name || user?.email || '?')
    .split(/[\s.@]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  return <span className="avatar">{initials}</span>;
}

/** Formats a deadline, and says how long is left. */
export function Deadline({ value, showRelative = true }) {
  if (!value) return <span className="muted">No deadline</span>;
  const date = new Date(value);
  const ms = date - Date.now();
  const absolute = date.toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  if (!showRelative) return <span>{absolute}</span>;

  const days = Math.floor(Math.abs(ms) / 86400000);
  const hours = Math.floor(Math.abs(ms) / 3600000);
  let relative;
  if (ms < 0) relative = days >= 1 ? `${days}d overdue` : `${hours}h overdue`;
  else if (days >= 1) relative = `in ${days}d`;
  else relative = `in ${hours}h`;

  return (
    <span>
      {absolute} <span className={ms < 0 ? 'badge fail' : 'badge'}>{relative}</span>
    </span>
  );
}

export function StatusBadge({ status }) {
  if (status === 'published') return <span className="badge pass">Published</span>;
  return <span className="badge warn">Draft</span>;
}

/**
 * Shows the automated result of a submission. `null` means the question has no
 * test cases, which is not a failure — it awaits the teacher.
 */
export function AutoResultBadge({ autoPassed, compact = false }) {
  if (autoPassed === true) return <span className="badge pass">{compact ? 'Pass' : 'Tests passed'}</span>;
  if (autoPassed === false) return <span className="badge fail">{compact ? 'Fail' : 'Tests failed'}</span>;
  return <span className="badge">Teacher-graded</span>;
}
