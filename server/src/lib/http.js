export class HttpError extends Error {
  /**
   * `expose` controls whether the message reaches the caller. Client errors
   * always do. A deliberate 5xx - "Judge0 is not configured", "Oracle is not
   * connected" - also should: it tells an operator exactly what to fix, and it
   * contains nothing internal. Only unexpected 500s are masked.
   */
  constructor(status, message, details = undefined, { expose } = {}) {
    super(message);
    this.status = status;
    this.details = details;
    this.expose = expose ?? status < 500;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Not signed in') => new HttpError(401, msg);
export const forbidden = (msg = 'Not allowed') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);

/** Wraps an async route handler so rejected promises reach the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Validates `body` with a zod schema, throwing a 400 with field details. */
export function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    }));
    throw badRequest('Validation failed', details);
  }
  return result.data;
}
