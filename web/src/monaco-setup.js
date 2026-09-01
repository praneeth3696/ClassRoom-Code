import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// Editor features: find/replace, bracket matching, context menu, folding.
import 'monaco-editor/esm/vs/editor/editor.all.js';

// Only the languages this platform teaches (SPEC.md §9). Importing the
// `monaco-editor` barrel instead would bundle ~90 language definitions and
// four unused language workers, for roughly ten times the download.
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js'; // registers both c and cpp
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js';
// The MongoDB shell is JavaScript, so mongosh answers get JS highlighting.
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';

/**
 * Bundles Monaco with the app instead of fetching it from a CDN at runtime.
 *
 * @monaco-editor/react loads Monaco from jsDelivr by default, which would make
 * the editor — the core of the student experience — fail on a college network
 * that blocks external CDNs, and on any offline lab machine.
 */
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

loader.config({ monaco });
