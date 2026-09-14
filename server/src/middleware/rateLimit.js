import { config } from '../config.js';
import { HttpError } from '../lib/http.js';

/**
 * Fixed-window rate limiting, kept in memory.
 *
 * The platform deploys as a single Node process (README, "Single-process
 * deployment"), so an in-process counter is exact and needs no Redis. Signed-in
 * requests are counted per user rather than per IP: a whole lab behind one
 * college NAT address must not share a single allowance.
 *
 * Limits are off under NODE_ENV=test so the suite is not throttled; tests that
 * exercise limiting turn them on with RATE_LIMIT_ENABLED.
 */
export function rateLimit({
  name,
  windowMs,
  max,
  by = 'user',
  enabled = () => config.rateLimit.enabled,
  now = Date.now,
}) {
  const windows = new Map();

  const sweeper = setInterval(() => {
    const t = now();
    for (const [key, entry] of windows) {
      if (entry.resetAt <= t) windows.delete(key);
    }
  }, windowMs);
  sweeper.unref?.();

  function middleware(req, res, next) {
    if (!enabled()) return next();

    const key = by === 'user' && req.user ? `user:${req.user.id}` : `ip:${req.ip}`;
    const t = now();
    let entry = windows.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      windows.set(key, entry);
    }
    entry.count += 1;

    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(resetSeconds));
      return next(new HttpError(429, `Too many ${name}. Please wait ${resetSeconds}s and try again.`));
    }
    return next();
  }

  middleware.reset = () => windows.clear();
  return middleware;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The limits applied to the platform's expensive or abusable endpoints. */
export const limits = {
  runs: rateLimit({ name: 'runs', windowMs: MINUTE, max: config.rateLimit.runsPerMinute }),
  submits: rateLimit({ name: 'submissions', windowMs: MINUTE, max: config.rateLimit.submitsPerMinute }),
  signIns: rateLimit({ name: 'sign-in attempts', windowMs: MINUTE, max: config.rateLimit.signInsPerMinute, by: 'ip' }),
  imports: rateLimit({ name: 'worksheet imports', windowMs: HOUR, max: config.rateLimit.importsPerHour }),
};
