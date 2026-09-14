/**
 * Thin API client. Every call goes to the same origin (Vite proxies /api to the
 * server in development), so the session cookie rides along automatically.
 */

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Is it running?');
  }

  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }

  if (!res.ok) {
    const err = payload?.error;
    throw new ApiError(res.status, err?.message || `Request failed (${res.status})`, err?.details);
  }
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  del: (path) => request('DELETE', path),

  // --- auth ---
  me: () => request('GET', '/api/auth/me'),
  meta: () => request('GET', '/api/meta'),
  devUsers: () => request('GET', '/api/auth/dev-users'),
  devLogin: (email) => request('POST', '/api/auth/dev-login', { email }),
  logout: () => request('POST', '/api/auth/logout', {}),

  // --- academic structure ---
  departments: () => request('GET', '/api/departments'),
  programmes: (departmentId) => request('GET', `/api/programmes${departmentId ? `?departmentId=${departmentId}` : ''}`),
  batches: (programmeId) => request('GET', `/api/batches${programmeId ? `?programmeId=${programmeId}` : ''}`),
  subjects: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
    return request('GET', `/api/subjects${qs ? `?${qs}` : ''}`);
  },
  joinCourse: (code) => request('POST', '/api/courses/join', { code }),
  rotateJoinCode: (courseId) => request('POST', `/api/courses/${courseId}/join-code/rotate`, {}),
  setJoinEnabled: (courseId, enabled) => request('POST', `/api/courses/${courseId}/join-code/enabled`, { enabled }),
  enrollBatch: (courseId, batchId) => request('POST', `/api/courses/${courseId}/enroll-batch`, { batchId }),

  // --- courses ---
  courses: () => request('GET', '/api/courses'),
  course: (id) => request('GET', `/api/courses/${id}`),
  createCourse: (body) => request('POST', '/api/courses', body),
  addStudents: (id, people) => request('POST', `/api/courses/${id}/students`, { people }),
  addTeachers: (id, people) => request('POST', `/api/courses/${id}/teachers`, { people }),
  removeStudent: (id, userId) => request('DELETE', `/api/courses/${id}/students/${userId}`),

  // --- worksheets ---
  worksheets: (courseId) => request('GET', `/api/courses/${courseId}/worksheets`),
  worksheet: (id) => request('GET', `/api/worksheets/${id}`),
  createWorksheet: (courseId, body) => request('POST', `/api/courses/${courseId}/worksheets`, body),
  updateWorksheet: (id, body) => request('PATCH', `/api/worksheets/${id}`, body),
  publishWorksheet: (id) => request('POST', `/api/worksheets/${id}/publish`, {}),
  unpublishWorksheet: (id) => request('POST', `/api/worksheets/${id}/unpublish`, {}),
  deleteWorksheet: (id, force) => request('DELETE', `/api/worksheets/${id}${force ? '?force=true' : ''}`),
  addQuestion: (worksheetId, body) => request('POST', `/api/worksheets/${worksheetId}/questions`, body),
  updateQuestion: (id, body) => request('PATCH', `/api/questions/${id}`, body),
  deleteQuestion: (id, force) => request('DELETE', `/api/questions/${id}${force ? '?force=true' : ''}`),

  // --- submissions ---
  questionWorkspace: (questionId) => request('GET', `/api/questions/${questionId}`),
  submission: (questionId) => request('GET', `/api/questions/${questionId}/submission`),
  runCode: (questionId, body) => request('POST', `/api/questions/${questionId}/run`, body),
  saveDraft: (questionId, body) => request('PUT', `/api/questions/${questionId}/submission`, body),
  submitAnswer: (questionId, body) => request('POST', `/api/questions/${questionId}/submit`, body),

  // --- worksheet import (teacher) ---
  courseImports: (courseId) => request('GET', `/api/courses/${courseId}/imports`),
  uploadImport: async (courseId, file) => {
    // multipart, so this bypasses the JSON request helper.
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/courses/${courseId}/imports`, {
      method: 'POST', credentials: 'same-origin', body: form,
    });
    const text = await res.text();
    const payload = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, payload?.error?.message ?? 'Upload failed', payload?.error?.details);
    return payload;
  },
  getImport: (importId, { text = false } = {}) => request('GET', `/api/imports/${importId}${text ? '?text=true' : ''}`),
  analyzeImport: (importId, pdfBase64) => request('POST', `/api/imports/${importId}/analyze`, { pdfBase64: pdfBase64 ?? null }),
  updateImportDraft: (importId, draft) => request('PATCH', `/api/imports/${importId}`, { draft }),
  recheckImport: (importId) => request('POST', `/api/imports/${importId}/recheck`, {}),
  applyImport: (importId) => request('POST', `/api/imports/${importId}/apply`, {}),

  // --- review (teacher) ---
  questionSubmissions: (questionId) => request('GET', `/api/questions/${questionId}/submissions`),
  worksheetProgress: (worksheetId) => request('GET', `/api/worksheets/${worksheetId}/progress`),
  saveFeedback: (submissionId, body) => request('PUT', `/api/submissions/${submissionId}/feedback`, body),
  submissionRevisions: (submissionId) => request('GET', `/api/submissions/${submissionId}/revisions`),
};
