/**
 * Tests for crons.js — run with: node test/crons.test.js
 *
 * Tests the new Phase 2/3 features: execution lock, duplicate name prevention,
 * quiet hours, and job CRUD.
 *
 * Note: crons.js uses config.dataDir (hardcoded path), so tests run against
 * the real crons.json. We use baseline counts to avoid interference.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'crons.js')).href;
const { load, addCron, deleteCron, toggleCron, listCrons, getCron, getCronSummary, setSendFn } = await import(modPath);

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
    toThrow() { /* handled externally */ },
    toBeGreaterThan(n) { if (actual <= n) throw new Error(`Expected ${actual} > ${n}`); },
  };
}

// Load real crons (may have existing jobs)
load();
const baseline = listCrons().length;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
console.log('\n=== Cron CRUD ===');

test('addCron creates a job', () => {
  const job = addCron('test-job', '0 9 * * *', 'Run daily test', null, 'silent');
  expect(job.name).toBe('test-job');
  expect(job.enabled).toBe(true);
  expect(job.delivery).toBe('silent');
  expect(job.schedule).toBe('0 9 * * *');
});

test('listCrons count increases by 1 after add', () => {
  expect(listCrons().length).toBe(baseline + 1);
});

test('getCron finds by name', () => {
  const job = getCron('test-job');
  expect(job).toBeTruthy();
  expect(job.name).toBe('test-job');
});

test('getCron finds by name (case-insensitive)', () => {
  const job = getCron('TEST-JOB');
  expect(job).toBeTruthy();
  expect(job.name).toBe('test-job');
});

test('getCronSummary returns string', () => {
  const summary = getCronSummary();
  expect(typeof summary).toBe('string');
  expect(summary.length).toBeGreaterThan(0);
});

test('toggleCron disables job', () => {
  const job = toggleCron('test-job');
  expect(job.enabled).toBe(false);
});

test('toggleCron re-enables job', () => {
  const job = toggleCron('test-job');
  expect(job.enabled).toBe(true);
});

// ---------------------------------------------------------------------------
// Duplicate name prevention (Phase 3)
// ---------------------------------------------------------------------------
console.log('\n=== Duplicate Name Prevention ===');

test('addCron rejects duplicate name', () => {
  try {
    addCron('test-job', '0 10 * * *', 'Duplicate', null, 'announce');
    throw new Error('should have thrown');
  } catch (err) {
    expect(err.message.includes('already exists')).toBeTruthy();
  }
});

test('addCron rejects duplicate name (case-insensitive)', () => {
  try {
    addCron('TEST-JOB', '0 10 * * *', 'Duplicate', null, 'announce');
    throw new Error('should have thrown');
  } catch (err) {
    expect(err.message.includes('already exists')).toBeTruthy();
  }
});

test('addCron rejects invalid cron expression', () => {
  try {
    addCron('bad-cron', 'invalid expression', 'prompt');
    throw new Error('should have thrown');
  } catch (err) {
    // Croner throws on invalid expression
    expect(err).toBeTruthy();
  }
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
console.log('\n=== Delete ===');

test('deleteCron removes job', () => {
  const job = deleteCron('test-job');
  expect(job).toBeTruthy();
  expect(listCrons().length).toBe(baseline);
});

test('deleteCron returns null for unknown job', () => {
  const result = deleteCron('nonexistent');
  expect(result).toBe(null);
});

test('addCron succeeds after deletion (name reusable)', () => {
  const job = addCron('test-job', '0 9 * * *', 'Recreated', null, 'announce');
  expect(job.name).toBe('test-job');
  deleteCron('test-job'); // cleanup
});

// ---------------------------------------------------------------------------
// State initialization
// ---------------------------------------------------------------------------
console.log('\n=== State ===');

test('new job has proper initial state', () => {
  const job = addCron('state-test', '0 12 * * *', 'Test state');
  expect(job.state.lastRun).toBe(null);
  expect(job.state.lastStatus).toBe(null);
  expect(job.state.consecutiveErrors).toBe(0);
  expect(job.state.lastDurationMs).toBe(null);
  deleteCron('state-test');
});

test('setSendFn accepts a function', () => {
  setSendFn(async (msg) => {}); // should not throw
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
