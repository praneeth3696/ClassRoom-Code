/**
 * Graceful shutdown for the API process.
 *
 * Stops accepting connections, then releases everything the process owns: the
 * database pool and any database engines it started (a local mongod would
 * otherwise outlive the server). `server.close()` waits for keep-alive
 * connections to go idle, which can be never, so a timer forces the exit.
 */
export function createShutdown({
  server,
  cleanups = [],
  timeoutMs = 10_000,
  exit = (code) => process.exit(code),
  log = console,
}) {
  let started = false;

  return function shutdown(signal) {
    if (started) return;
    started = true;
    log.log(`[api] ${signal} received, shutting down`);

    const force = setTimeout(() => {
      log.error(`[api] shutdown took longer than ${timeoutMs}ms; exiting`);
      exit(1);
    }, timeoutMs);
    force.unref?.();

    server.close(async () => {
      let code = 0;
      for (const cleanup of cleanups) {
        try {
          await cleanup();
        } catch (err) {
          code = 1;
          log.error('[api] cleanup failed during shutdown', err);
        }
      }
      clearTimeout(force);
      exit(code);
    });
    server.closeIdleConnections?.();
  };
}
