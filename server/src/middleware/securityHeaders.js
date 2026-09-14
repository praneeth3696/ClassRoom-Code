/**
 * Browser security headers for the API and the single-page app it serves.
 *
 * Written out rather than pulled in from a package because the policy has to be
 * exactly right for Monaco: it injects its theme as inline <style> and starts
 * language workers from blob: URLs. Everything else is locked to this origin.
 * `web/e2e/csp.spec.js` loads the editor in a real browser and fails on any
 * violation, so a change here that breaks the editor does not go unnoticed.
 */
export function contentSecurityPolicy({ production = false } = {}) {
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  // Only behind HTTPS: on a plain-http development server this would rewrite
  // every asset URL to https:// and break the page.
  if (production) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

export function securityHeaders({ production = false } = {}) {
  const csp = contentSecurityPolicy({ production });
  return function applySecurityHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (production) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  };
}
