import { HttpError } from './http.js';

/**
 * A bounded FIFO queue for expensive work.
 *
 * Code execution is the one thing that scales with how many students press Run
 * at once. QUESTIONS.md measured 60 simultaneous database runs needing about
 * 2 GB, so rather than letting every request start its own engine, at most
 * `concurrency` run together and the rest wait their turn. A full queue, or a
 * wait longer than `queueTimeoutMs`, is refused with a 503 the student can
 * retry, instead of pushing the server out of memory.
 */
export function createLimiter({ concurrency, maxQueue = Infinity, queueTimeoutMs = Infinity, name = 'work' }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`${name} concurrency must be a positive integer`);
  }

  let active = 0;
  const waiting = [];

  const busy = (reason) => new HttpError(
    503,
    `The server is busy running other students' code (${reason}). Please try again in a moment.`,
    undefined,
    { expose: true },
  );

  function startNext() {
    while (active < concurrency && waiting.length > 0) {
      const next = waiting.shift();
      clearTimeout(next.timer);
      next.start();
    }
  }

  function run(task) {
    return new Promise((resolve, reject) => {
      const start = () => {
        active += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            startNext();
          });
      };

      if (active < concurrency) {
        start();
        return;
      }
      if (waiting.length >= maxQueue) {
        reject(busy('queue full'));
        return;
      }

      const entry = { start, timer: null };
      if (Number.isFinite(queueTimeoutMs)) {
        entry.timer = setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index !== -1) waiting.splice(index, 1);
          reject(busy('waited too long'));
        }, queueTimeoutMs);
        entry.timer.unref?.();
      }
      waiting.push(entry);
    });
  }

  return {
    run,
    stats: () => ({ concurrency, active, waiting: waiting.length, maxQueue }),
  };
}
