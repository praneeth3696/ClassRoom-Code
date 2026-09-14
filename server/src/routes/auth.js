import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { wrap, badRequest, parseBody, forbidden } from '../lib/http.js';
import {
  clearOAuthCookie, clearSessionCookie, readOAuthCookie, setOAuthCookie, setSessionCookie,
} from '../lib/session.js';
import { buildAuthUrl, completeSignIn, isGoogleConfigured, redirectUri } from '../services/google.js';
import { findUserByEmail, listUsers, toPublicUser, upsertGoogleUser } from '../services/users.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

/**
 * The page to return to after sign-in. Only same-origin paths are accepted:
 * `//evil.example` and `/\evil.example` both start with a slash but resolve to
 * another host, which would turn a sign-in link into an open redirect.
 */
export function safeNextPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/';
  const webOrigin = new URL(config.webOrigin);
  try {
    if (new URL(value, webOrigin).origin !== webOrigin.origin) return '/';
  } catch {
    return '/';
  }
  return value;
}

authRouter.get('/me', (req, res) => {
  res.json({ user: req.user ?? null });
});

authRouter.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// --- Google OAuth 2.0 --------------------------------------------------------

authRouter.get(
  '/google/start',
  wrap(async (req, res) => {
    if (!isGoogleConfigured()) {
      throw badRequest('Google sign-in is not configured on this server (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)');
    }
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    // `next` lets the frontend resume the page the user was heading for.
    const next = safeNextPath(req.query.next);
    setOAuthCookie(res, { state, nonce, next });
    res.redirect(await buildAuthUrl({ state, nonce }));
  }),
);

authRouter.get(
  '/google/callback',
  wrap(async (req, res) => {
    const fail = (message) => {
      clearOAuthCookie(res);
      const url = new URL('/signin', config.webOrigin);
      url.searchParams.set('error', message);
      res.redirect(url.toString());
    };

    if (req.query.error) return fail(String(req.query.error_description || req.query.error));

    const pending = readOAuthCookie(req);
    if (!pending) return fail('Your sign-in request expired. Please try again.');
    clearOAuthCookie(res);

    if (!req.query.state || req.query.state !== pending.state) {
      return fail('Sign-in state did not match. Please try again.');
    }
    if (!req.query.code) return fail('Google did not return an authorization code.');

    try {
      const profile = await completeSignIn(String(req.query.code), pending.nonce);
      const user = await upsertGoogleUser(profile);
      setSessionCookie(res, user);
      res.redirect(new URL(safeNextPath(pending.next), config.webOrigin).toString());
    } catch (err) {
      return fail(err.status && err.status < 500 ? err.message : 'Sign-in failed. Please try again.');
    }
  }),
);

// --- Development sign-in -----------------------------------------------------

const devLoginSchema = z.object({ email: z.string().email() });

/**
 * Password-less sign-in as an already-provisioned user, so the app can be
 * driven end to end without Google credentials. Disabled unless DEV_LOGIN is
 * on, and DEV_LOGIN is refused outright when NODE_ENV=production.
 */
authRouter.post(
  '/dev-login',
  wrap(async (req, res) => {
    if (!config.auth.devLogin) throw forbidden('Development sign-in is disabled on this server');
    const { email } = parseBody(devLoginSchema, req.body);
    const row = await findUserByEmail(email);
    if (!row) throw badRequest(`No user with the email ${email}. Seed the roster first.`);
    const user = toPublicUser(row);
    setSessionCookie(res, user);
    res.json({ user });
  }),
);

/** Roster for the development sign-in picker. */
authRouter.get(
  '/dev-users',
  wrap(async (req, res) => {
    if (!config.auth.devLogin) throw forbidden('Development sign-in is disabled on this server');
    const rows = await listUsers();
    res.json({ users: rows.map(toPublicUser) });
  }),
);

// --- Diagnostics -------------------------------------------------------------

authRouter.get(
  '/config',
  requireAuth,
  wrap(async (req, res) => {
    res.json({
      googleConfigured: isGoogleConfigured(),
      redirectUri: redirectUri(),
      allowedEmailDomains: config.auth.allowedEmailDomains,
      devLogin: config.auth.devLogin,
    });
  }),
);
