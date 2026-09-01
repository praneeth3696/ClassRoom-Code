import { Suspense, lazy } from 'react';

/**
 * Monaco is around 900 KB gzipped — most of the app's payload. Loading it only
 * when an editor is actually shown keeps the course and worksheet pages fast,
 * and means a student who never opens a question never downloads it.
 */
const CodeEditor = lazy(() => import('./CodeEditor.jsx'));

export default function LazyCodeEditor(props) {
  return (
    <Suspense fallback={
      <div className="center-page" style={{ minHeight: 160 }}>
        <span className="row small muted"><span className="spinner" /> Loading editor…</span>
      </div>
    }>
      <CodeEditor {...props} />
    </Suspense>
  );
}
