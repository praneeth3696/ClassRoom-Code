import { ZodError } from 'zod';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { message: `No route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity.
export function errorHandler(err, req, res, next) {
  // A schema failure that escaped parseBody — a bad path or query parameter —
  // is still the caller's mistake, not a server fault.
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        message: 'Validation failed',
        details: err.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message })),
      },
    });
  }

  const status = err instanceof HttpError ? err.status : 500;
  // A deliberately-constructed 5xx carries a message meant for the operator;
  // anything else at 5xx is unexpected and its message is not shown.
  const expose = err instanceof HttpError ? err.expose : false;
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  const body = { error: { message: status < 500 || expose ? err.message : 'Internal server error' } };
  if (err.details) body.error.details = err.details;
  if (status >= 500 && config.env !== 'production') body.error.stack = err.stack;
  res.status(status).json(body);
}
