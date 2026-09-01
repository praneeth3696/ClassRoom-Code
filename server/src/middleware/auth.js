import { config } from '../config.js';
import { verifySession } from '../lib/session.js';
import { findUserById, toPublicUser } from '../services/users.js';
import { forbidden, unauthorized } from '../lib/http.js';

/**
 * Reads the session cookie and attaches `req.user` when it resolves to a user
 * that still exists. Never rejects — routes decide whether auth is required, so
 * public endpoints can still see who is calling.
 *
 * The role is re-read from the database on every request rather than trusted
 * from the token, so a role change takes effect without waiting for the
 * session to expire.
 */
export function attachUser(req, res, next) {
  const token = req.cookies?.[config.auth.cookieName];
  if (!token) return next();
  const claims = verifySession(token);
  if (!claims?.sub) return next();

  findUserById(claims.sub)
    .then((row) => {
      if (row) req.user = toPublicUser(row);
      next();
    })
    .catch(next);
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/** requireRole('teacher') or requireRole('teacher', 'admin'). */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This action requires the ${roles.join(' or ')} role`));
    }
    next();
  };
}

/** Admins are allowed everywhere a teacher is (SPEC.md §5, Phase 2 role). */
export const requireTeacher = requireRole('teacher', 'admin');
export const requireStudent = requireRole('student');
