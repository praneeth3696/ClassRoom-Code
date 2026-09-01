import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError, badRequest } from '../lib/http.js';

/**
 * Google OAuth 2.0 / OpenID Connect, authorization-code flow.
 *
 * Endpoints are read from Google's discovery document at runtime rather than
 * hardcoded, so this keeps working if Google moves them (SPEC.md §10 asks that
 * these be confirmed against current documentation). The literals below are the
 * values that document returned when this was written, used only as a fallback
 * if discovery is unreachable.
 */
const DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';

const FALLBACK = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
};

const CACHE_TTL_MS = 60 * 60 * 1000;
let discoveryCache = { value: null, at: 0 };
let jwksCache = { keys: new Map(), at: 0 };

export function isGoogleConfigured() {
  return Boolean(config.auth.google.clientId && config.auth.google.clientSecret);
}

export function redirectUri() {
  return `${config.apiOrigin}/api/auth/google/callback`;
}

async function fetchJson(url, init, timeoutMs = 8000) {
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { ...init, signal });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(502, `Unexpected non-JSON response from ${url}`);
  }
  if (!res.ok) {
    const detail = body.error_description || body.error || res.statusText;
    throw new HttpError(502, `Google request failed (${res.status}): ${detail}`);
  }
  return body;
}

async function discover() {
  if (discoveryCache.value && Date.now() - discoveryCache.at < CACHE_TTL_MS) return discoveryCache.value;
  try {
    const doc = await fetchJson(DISCOVERY_URL);
    discoveryCache = { value: { ...FALLBACK, ...doc }, at: Date.now() };
  } catch (err) {
    console.warn(`[auth] Google discovery unavailable (${err.message}); using known endpoints`);
    discoveryCache = { value: FALLBACK, at: Date.now() };
  }
  return discoveryCache.value;
}

async function getSigningKey(kid) {
  const fresh = Date.now() - jwksCache.at < CACHE_TTL_MS;
  if (fresh && jwksCache.keys.has(kid)) return jwksCache.keys.get(kid);

  const { jwks_uri: jwksUri } = await discover();
  const jwks = await fetchJson(jwksUri);
  const keys = new Map();
  for (const jwk of jwks.keys || []) {
    // Node can build a public key straight from a JWK — no PEM conversion.
    keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
  }
  jwksCache = { keys, at: Date.now() };
  // A kid absent from a freshly fetched JWKS means the token was not signed by
  // Google. That is a rejected credential (401), not a server fault.
  if (!keys.has(kid)) throw new HttpError(401, 'Google ID token was signed with an unrecognised key');
  return keys.get(kid);
}

/** Builds the URL the browser is redirected to in order to sign in. */
export async function buildAuthUrl({ state, nonce }) {
  const { authorization_endpoint: endpoint } = await discover();
  const params = new URLSearchParams({
    client_id: config.auth.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    access_type: 'online',
    prompt: 'select_account',
  });
  // When the college uses Google Workspace, this pre-filters the account
  // chooser to the college domain. It is a hint only — the `hd` claim is
  // re-checked server-side after the token exchange.
  const [firstDomain] = config.auth.allowedEmailDomains;
  if (firstDomain) params.set('hd', firstDomain);
  return `${endpoint}?${params.toString()}`;
}

async function exchangeCode(code) {
  const { token_endpoint: endpoint } = await discover();
  return fetchJson(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.auth.google.clientId,
      client_secret: config.auth.google.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }).toString(),
  });
}

/**
 * Verifies the ID token's signature against Google's JWKS and checks the
 * issuer, audience, expiry and nonce. The token arrives over a direct HTTPS
 * call to Google, but verifying it too means a misconfigured proxy or a stolen
 * token from another client cannot mint a session here.
 */
export async function verifyIdToken(idToken, expectedNonce) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded?.header?.kid) throw badRequest('Malformed Google ID token');
  // Checked before the key lookup so an algorithm-downgrade attempt reports
  // the real reason rather than failing later as an unknown key.
  if (decoded.header.alg !== 'RS256') {
    throw new HttpError(401, `Google ID token uses an unsupported algorithm (${decoded.header.alg})`);
  }

  const key = await getSigningKey(decoded.header.kid);
  const { issuer } = await discover();

  let claims;
  try {
    claims = jwt.verify(idToken, key, {
      algorithms: ['RS256'],
      audience: config.auth.google.clientId,
      issuer: [issuer, 'accounts.google.com'],
      clockTolerance: 30,
    });
  } catch (err) {
    throw new HttpError(401, `Google ID token rejected: ${err.message}`);
  }

  if (expectedNonce && claims.nonce !== expectedNonce) {
    throw new HttpError(401, 'Google ID token nonce did not match the sign-in request');
  }
  if (!claims.email) throw new HttpError(401, 'Google account did not return an email address');
  if (claims.email_verified === false) {
    throw new HttpError(403, 'This Google account has an unverified email address');
  }

  return {
    sub: claims.sub,
    email: claims.email,
    name: claims.name,
    picture: claims.picture,
    hd: claims.hd ?? null,
  };
}

/** Full callback handling: code -> tokens -> verified profile. */
export async function completeSignIn(code, expectedNonce) {
  const tokens = await exchangeCode(code);
  if (!tokens.id_token) throw new HttpError(502, 'Google token response contained no id_token');
  return verifyIdToken(tokens.id_token, expectedNonce);
}

export const _internals = { discover, FALLBACK, DISCOVERY_URL };
