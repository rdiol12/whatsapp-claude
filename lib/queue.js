import { createLogger } from './logger.js';
import { recordQueueEvent } from './metrics.js';

const log = createLogger('queue');

/**
 * Create a message queue with global concurrency control and per-user FIFO ordering.
 *
 * - maxConcurrent: max Claude CLI processes running at once (default 2)
 * - maxQueuePerUser: max queued messages per user before "still working" (default 5)
 */
export function createQueue({ maxConcurrent = 2, maxQueuePerUser = 5 } = {}) {
  let running = 0;
  const waiting = [];           // global FIFO: { resolve }
  const userQueues = new Map();  // userId → Promise chain
  const userDepths = new Map();  // userId → number of pending tasks

  /** Acquire a concurrency slot (resolves when a slot is free) */
  function acquire() {
    if (running < maxConcurrent) {
      running++;
      return Promise.resolve();
    }
    return new Promise(resolve => waiting.push({ resolve }));
  }

  /** Release a concurrency slot */
  function release() {
    if (waiting.length > 0) {
      const next = waiting.shift();
      next.resolve();
    } else {
      running--;
    }
  }

  /**
   * Enqueue a task for a specific user.
   * Tasks for the same user are serialized (FIFO).
   * Tasks for different users run concurrently up to maxConcurrent.
   *
   * @param {string} userId - User identifier (JID)
   * @param {Function} fn - Async function to execute
   * @returns {{ queued: boolean, depth: number }} - whether it was queued vs rejected
   */
  function enqueue(userId, fn) {
    // Get or create per-user chain
    let chain = userQueues.get(userId) || Promise.resolve();

    // Track depth per user with a proper Map
    const depth = (userDepths.get(userId) || 0) + 1;

    if (depth > maxQueuePerUser) {
      log.warn({ userId, depth, max: maxQueuePerUser }, 'Queue full for user');
      recordQueueEvent('reject', { running, waiting: waiting.length });
      return { queued: false, depth };
    }

    userDepths.set(userId, depth);
    recordQueueEvent('enqueue', { running, waiting: waiting.length });
    log.info({ userId, depth, running, waiting: waiting.length }, 'Enqueuing message');

    // Chain this task after the user's previous task
    const task = chain.then(async () => {
      await acquire();
      try {
        await fn();
      } finally {
        const d = userDepths.get(userId) || 1;
        if (d <= 1) userDepths.delete(userId);
        else userDepths.set(userId, d - 1);
        release();
      }
    });

    // Swallow errors to prevent chain breakage
    const safeTask = task.catch(err => {
      log.error({ userId, err: err.message }, 'Queued task failed');
    });

    userQueues.set(userId, safeTask);
    return { queued: true, depth };
  }

  /** Get queue stats */
  function stats() {
    return { running, waiting: waiting.length, users: userQueues.size };
  }

  /**
   * Wait for all running tasks to complete (up to timeoutMs).
   * Returns true if drained, false if timed out.
   */
  async function drain(timeoutMs = 10_000) {
    if (running === 0 && waiting.length === 0) return true;
    log.info({ running, waiting: waiting.length }, 'Draining queue...');

    const start = Date.now();
    while (running > 0 || waiting.length > 0) {
      if (Date.now() - start > timeoutMs) {
        log.warn({ running, waiting: waiting.length, elapsedMs: Date.now() - start }, 'Queue drain timed out');
        return false;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    log.info({ elapsedMs: Date.now() - start }, 'Queue drained');
    return true;
  }

  return { enqueue, stats, drain };
}
