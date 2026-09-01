import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const ISSUER = 'classroom-platform';

/** Signs the session JWT that goes into the httpOnly cookie. */
export function signSession(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    config.auth.jwtSecret,
    { issuer: ISSUER, expiresIn: `${config.auth.sessionDays}d` },
  );
}

export function verifySession(token) {
  try {
    return jwt.verify(token, config.auth.jwtSecret, { issuer: ISSUER });
  } catch {
    return null;
  }
}

function cookieOptions(maxAgeMs) {
  const secure = config.env === 'production';
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function setSessionCookie(res, user) {
  const token = signSession(user);
  res.cookie(config.auth.cookieName, token, cookieOptions(config.auth.sessionDays * 86400 * 1000));
  return token;
}

export function clearSessionCookie(res) {
  res.clearCookie(config.auth.cookieName, { ...cookieOptions(0), maxAge: undefined });
}

/**
 * Short-lived signed cookie carrying the OAuth `state` and `nonce` across the
 * redirect to Google, so the callback can prove the response answers a request
 * this server actually started (CSRF) and that the id_token is not replayed.
 */
const OAUTH_COOKIE = 'classroom_oauth';

export function setOAuthCookie(res, payload) {
  const token = jwt.sign(payload, config.auth.jwtSecret, { issuer: ISSUER, expiresIn: '10m' });
  res.cookie(OAUTH_COOKIE, token, cookieOptions(10 * 60 * 1000));
}

export function readOAuthCookie(req) {
  const raw = req.cookies?.[OAUTH_COOKIE];
  if (!raw) return null;
  try {
    return jwt.verify(raw, config.auth.jwtSecret, { issuer: ISSUER });
  } catch {
    return null;
  }
}

export function clearOAuthCookie(res) {
  res.clearCookie(OAUTH_COOKIE, { ...cookieOptions(0), maxAge: undefined });
}
