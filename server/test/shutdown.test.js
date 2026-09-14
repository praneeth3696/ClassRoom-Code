import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdown } from '../src/lib/shutdown.js';

const quiet = { log() {}, error() {} };

function fakeServer({ closes = true } = {}) {
  return {
    closed: false,
    idleClosed: false,
    close(cb) {
      this.closed = true;
      if (closes) setImmediate(cb);
    },
    closeIdleConnections() {
      this.idleClosed = true;
    },
  };
}

describe('graceful shutdown', () => {
  test('closes the server, runs every cleanup in order, then exits 0', async () => {
    const server = fakeServer();
    const order = [];
    const exited = new Promise((resolve) => {
      const shutdown = createShutdown({
        server,
        cleanups: [async () => order.push('db'), async () => order.push('engines')],
        exit: resolve,
        log: quiet,
      });
      shutdown('SIGTERM');
    });

    assert.equal(await exited, 0);
    assert.ok(server.closed);
    assert.ok(server.idleClosed, 'idle keep-alive connections are closed so close() can finish');
    assert.deepEqual(order, ['db', 'engines']);
  });

  test('a failing cleanup still runs the rest and exits non-zero', async () => {
    const ran = [];
    const code = await new Promise((resolve) => {
      createShutdown({
        server: fakeServer(),
        cleanups: [async () => { throw new Error('boom'); }, async () => ran.push('engines')],
        exit: resolve,
        log: quiet,
      })('SIGINT');
    });

    assert.equal(code, 1);
    assert.deepEqual(ran, ['engines']);
  });

  test('forces an exit when the server never finishes closing', async () => {
    // The force-exit timer is unref'd so it never holds the process open. Keep the
    // event loop alive ourselves, or Node may exit before the timer fires.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const code = await new Promise((resolve) => {
        createShutdown({ server: fakeServer({ closes: false }), timeoutMs: 20, exit: resolve, log: quiet })('SIGTERM');
      });
      assert.equal(code, 1);
    } finally {
      clearInterval(keepAlive);
    }
  });

  test('a second signal does not start a second shutdown', async () => {
    let cleanups = 0;
    const exits = [];
    await new Promise((resolve) => {
      const shutdown = createShutdown({
        server: fakeServer(),
        cleanups: [async () => { cleanups += 1; }],
        exit: (c) => { exits.push(c); resolve(); },
        log: quiet,
      });
      shutdown('SIGTERM');
      shutdown('SIGINT');
    });
    assert.equal(cleanups, 1);
    assert.deepEqual(exits, [0]);
  });
});
