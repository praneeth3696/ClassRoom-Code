import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/lib/limiter.js';

/** A task that stays running until released, recording when it started. */
function deferredTask(log, id) {
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  return {
    task: async () => {
      log.push(id);
      await done;
      return id;
    },
    release: () => release(),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('execution limiter', () => {
  test('never runs more than `concurrency` tasks at once, and starts waiters in order', async () => {
    const limiter = createLimiter({ concurrency: 2 });
    const started = [];
    const tasks = [1, 2, 3, 4].map((id) => deferredTask(started, id));
    const results = tasks.map((t) => limiter.run(t.task));

    await tick();
    assert.deepEqual(started, [1, 2]);
    assert.deepEqual(limiter.stats(), { concurrency: 2, active: 2, waiting: 2, maxQueue: Infinity });

    tasks[0].release();
    await tick();
    assert.deepEqual(started, [1, 2, 3], 'the first waiter takes the freed slot');

    tasks[1].release();
    tasks[2].release();
    tasks[3].release();
    assert.deepEqual(await Promise.all(results), [1, 2, 3, 4]);
    assert.equal(limiter.stats().active, 0);
  });

  test('a failing task frees its slot and reports its own error', async () => {
    const limiter = createLimiter({ concurrency: 1 });
    await assert.rejects(limiter.run(async () => { throw new Error('compile failed'); }), /compile failed/);
    assert.equal(await limiter.run(async () => 'next'), 'next');
  });

  test('refuses new work with a 503 when the queue is full', async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 1 });
    const started = [];
    const running = deferredTask(started, 'running');
    const queued = deferredTask(started, 'queued');
    const first = limiter.run(running.task);
    const second = limiter.run(queued.task);

    await assert.rejects(limiter.run(async () => 'overflow'), (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.expose, true, 'the student sees why, and can retry');
      assert.match(err.message, /busy/);
      return true;
    });

    running.release();
    queued.release();
    await Promise.all([first, second]);
  });

  test('gives up on a task that waits longer than the queue timeout', async () => {
    const limiter = createLimiter({ concurrency: 1, queueTimeoutMs: 20 });
    const started = [];
    const running = deferredTask(started, 'running');
    const first = limiter.run(running.task);

    // The limiter unrefs its timeout so it never holds the process open. Keep the
    // event loop alive ourselves, or Node may exit before the timeout fires.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await assert.rejects(limiter.run(async () => 'late'), (err) => err.status === 503);
    } finally {
      clearInterval(keepAlive);
    }
    assert.equal(limiter.stats().waiting, 0, 'a timed-out waiter leaves the queue');

    running.release();
    await first;
    assert.deepEqual(started, ['running'], 'the timed-out task never ran');
  });

  test('rejects a nonsensical concurrency', () => {
    assert.throws(() => createLimiter({ concurrency: 0 }), /positive integer/);
  });
});
