/**
 * Tests for queue.js — run with: node test/queue.test.js
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'queue.js')).href;
const { createQueue } = await import(modPath);

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => { passed++; console.log(`  PASS  ${name}`); })
        .catch(err => { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); });
    }
    passed++; console.log(`  PASS  ${name}`);
  }
  catch (err) { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

function expect(actual) {
  return {
    toBe(expected) { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy() { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy() { if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
  };
}

// Helper: create a delayed task
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Basic behavior
// ---------------------------------------------------------------------------
console.log('\n=== Queue Basics ===');

test('queue starts empty', () => {
  const q = createQueue();
  const s = q.stats();
  expect(s.running).toBe(0);
  expect(s.waiting).toBe(0);
});

test('enqueue returns {queued: true}', () => {
  const q = createQueue();
  const result = q.enqueue('user1', async () => {});
  expect(result.queued).toBe(true);
  expect(result.depth).toBe(1);
});

// ---------------------------------------------------------------------------
// Concurrency control
// ---------------------------------------------------------------------------
console.log('\n=== Concurrency ===');

await test('respects maxConcurrent', async () => {
  const q = createQueue({ maxConcurrent: 1 });
  const order = [];

  q.enqueue('a', async () => { order.push('a-start'); await delay(50); order.push('a-end'); });
  q.enqueue('b', async () => { order.push('b-start'); await delay(10); order.push('b-end'); });

  await delay(150);
  // With maxConcurrent=1, b should wait for a
  expect(order[0]).toBe('a-start');
  expect(order[1]).toBe('a-end');
  expect(order[2]).toBe('b-start');
  expect(order[3]).toBe('b-end');
});

await test('parallel for different users (maxConcurrent=2)', async () => {
  const q = createQueue({ maxConcurrent: 2 });
  const order = [];

  q.enqueue('user1', async () => { order.push('u1-start'); await delay(50); order.push('u1-end'); });
  q.enqueue('user2', async () => { order.push('u2-start'); await delay(50); order.push('u2-end'); });

  await delay(20);
  // Both should start nearly simultaneously
  expect(order.length >= 2).toBeTruthy();
  expect(order.includes('u1-start')).toBeTruthy();
  expect(order.includes('u2-start')).toBeTruthy();
  await delay(100);
});

// ---------------------------------------------------------------------------
// Per-user FIFO
// ---------------------------------------------------------------------------
console.log('\n=== Per-User FIFO ===');

await test('same user tasks are serialized', async () => {
  const q = createQueue({ maxConcurrent: 5 });
  const order = [];

  q.enqueue('ron', async () => { order.push('1-start'); await delay(30); order.push('1-end'); });
  q.enqueue('ron', async () => { order.push('2-start'); await delay(10); order.push('2-end'); });

  await delay(120);
  expect(order[0]).toBe('1-start');
  expect(order[1]).toBe('1-end');
  expect(order[2]).toBe('2-start');
  expect(order[3]).toBe('2-end');
});

// ---------------------------------------------------------------------------
// Queue rejection
// ---------------------------------------------------------------------------
console.log('\n=== Queue Limits ===');

await test('rejects when per-user queue full', async () => {
  const q = createQueue({ maxConcurrent: 1, maxQueuePerUser: 2 });

  q.enqueue('u', async () => await delay(200)); // running
  q.enqueue('u', async () => {}); // queued (depth 2)
  const result = q.enqueue('u', async () => {}); // depth 3 > max 2
  expect(result.queued).toBe(false);
  await delay(250);
});

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------
console.log('\n=== Drain ===');

await test('drain resolves when queue empty', async () => {
  const q = createQueue();
  q.enqueue('u', async () => await delay(20));
  const drained = await q.drain(5000);
  expect(drained).toBe(true);
});

await test('drain returns false on timeout', async () => {
  const q = createQueue({ maxConcurrent: 1 });
  q.enqueue('u', async () => await delay(5000));
  await delay(10); // let task start and increment running counter
  const drained = await q.drain(100);
  expect(drained).toBe(false);
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
console.log('\n=== Error Handling ===');

await test('task error does not break chain', async () => {
  const q = createQueue();
  let ran = false;

  q.enqueue('u', async () => { throw new Error('boom'); });
  q.enqueue('u', async () => { ran = true; });

  await delay(100);
  expect(ran).toBe(true);
});

// ---------------------------------------------------------------------------
// acquireSlot / releaseSlot (cron concurrency)
// ---------------------------------------------------------------------------
console.log('\n=== Slot API ===');

await test('acquireSlot respects concurrency limit', async () => {
  const q = createQueue({ maxConcurrent: 1 });
  const order = [];

  // Fill the slot with a user task
  q.enqueue('u', async () => { order.push('user-start'); await delay(50); order.push('user-end'); });

  // acquireSlot should wait until the slot is free
  await delay(5); // let user task start
  await q.acquireSlot();
  order.push('slot-acquired');
  q.releaseSlot();

  expect(order[0]).toBe('user-start');
  expect(order[1]).toBe('user-end');
  expect(order[2]).toBe('slot-acquired');
});

await test('releaseSlot frees slot for next task', async () => {
  const q = createQueue({ maxConcurrent: 1 });
  let ran = false;

  await q.acquireSlot();
  // Enqueue a task that should wait
  q.enqueue('u', async () => { ran = true; });
  await delay(20);
  expect(ran).toBe(false); // still waiting

  q.releaseSlot();
  await delay(50);
  expect(ran).toBe(true); // now it ran
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
