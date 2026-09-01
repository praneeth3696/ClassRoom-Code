import Editor from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import '../monaco-setup.js';

const MONACO_LANGUAGE = {
  c: 'c', cpp: 'cpp', java: 'java', python: 'python',
  sqlite: 'sql', postgres: 'sql', oracle: 'sql',
  mongodb: 'javascript', // the mongo shell is JavaScript
};

/** Follows the OS colour scheme, matching the rest of the app. */
function usePrefersDark() {
  const [dark, setDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    const onChange = (e) => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark;
}

export default function CodeEditor({ value, language, onChange, readOnly = false, onSubmitShortcut }) {
  const dark = usePrefersDark();

  return (
    <Editor
      height="100%"
      theme={dark ? 'vs-dark' : 'light'}
      language={MONACO_LANGUAGE[language] ?? 'plaintext'}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      loading={<div className="center-page"><span className="spinner" /></div>}
      onMount={(editor, monaco) => {
        if (onSubmitShortcut) {
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, onSubmitShortcut);
        }
      }}
      options={{
        readOnly,
        fontSize: 13.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 4,
        renderWhitespace: 'selection',
        padding: { top: 12, bottom: 12 },
        smoothScrolling: true,
      }}
    />
  );
}
