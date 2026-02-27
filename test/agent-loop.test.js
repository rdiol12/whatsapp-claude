/**
 * Tests for lib/agent-loop.js — run with: node test/agent-loop.test.js
 *
 * Tests exported API surface: getAgentLoopStatus, getAgentLoopDetail,
 * trackUserEngagement. Also verifies module loads cleanly and exports
 * expected functions.
 *
 * Note: startAgentLoop/stopAgentLoop are not invoked here to avoid
 * spawning real timers or network calls in tests.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'agent-loop.js')).href;
const mod = await import(modPath);
const {
  startAgentLoop,
  stopAgentLoop,
  getAgentLoopStatus,
  getAgentLoopDetail,
  trackUserEngagement,
} = mod;

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => { passed++; console.log(`  PASS  ${name}`); })
        .catch(err => { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); });
    }
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
    },
    toBeGreaterThanOrEqual(n) {
      if (actual < n) throw new Error(`Expected >= ${n}, got ${actual}`);
    },
    toEqual(expected) {
      const a = JSON.stringify(actual), b = JSON.stringify(expected);
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
    },
  };
}

// ─── Module exports ───────────────────────────────────────────────────────────

console.log('\n=== Module exports ===');

test('startAgentLoop is a function', () => {
  expect(typeof startAgentLoop).toBe('function');
});

test('stopAgentLoop is a function', () => {
  expect(typeof stopAgentLoop).toBe('function');
});

test('getAgentLoopStatus is a function', () => {
  expect(typeof getAgentLoopStatus).toBe('function');
});

test('getAgentLoopDetail is a function', () => {
  expect(typeof getAgentLoopDetail).toBe('function');
});

test('trackUserEngagement is a function', () => {
  expect(typeof trackUserEngagement).toBe('function');
});

// ─── getAgentLoopStatus ───────────────────────────────────────────────────────

console.log('\n=== getAgentLoopStatus ===');

test('returns an object', () => {
  const status = getAgentLoopStatus();
  expect(typeof status).toBe('object');
});

test('has running field (boolean)', () => {
  const status = getAgentLoopStatus();
  expect(typeof status.running).toBe('boolean');
});

test('has cycleCount field (number)', () => {
  const status = getAgentLoopStatus();
  expect(typeof status.cycleCount).toBe('number');
});

test('cycleCount is non-negative', () => {
  const status = getAgentLoopStatus();
  expect(status.cycleCount).toBeGreaterThanOrEqual(0);
});

test('has intervalMin field', () => {
  const status = getAgentLoopStatus();
  if (!('intervalMin' in status)) throw new Error('Missing intervalMin');
  expect(typeof status.intervalMin).toBe('number');
});

test('has mode field set to autonomous', () => {
  const status = getAgentLoopStatus();
  expect(status.mode).toBe('autonomous');
});


test('has consecutiveSpawns field (number)', () => {
  const status = getAgentLoopStatus();
  expect(typeof status.consecutiveSpawns).toBe('number');
  expect(status.consecutiveSpawns).toBeGreaterThanOrEqual(0);
});

test('has pendingFollowups field (number)', () => {
  const status = getAgentLoopStatus();
  expect(typeof status.pendingFollowups).toBe('number');
});

test('has lastSignals field (array)', () => {
  const status = getAgentLoopStatus();
  if (!Array.isArray(status.lastSignals)) {
    throw new Error(`lastSignals should be array, got ${typeof status.lastSignals}`);
  }
  expect(true).toBe(true);
});

test('has context field with token info', () => {
  const status = getAgentLoopStatus();
  if (!status.context) throw new Error('Missing context field');
  if (typeof status.context.sessionTokens !== 'number') throw new Error('Missing context.sessionTokens');
  expect(true).toBe(true);
});

// ─── getAgentLoopDetail ───────────────────────────────────────────────────────

console.log('\n=== getAgentLoopDetail ===');

test('returns object with all status fields', () => {
  const detail = getAgentLoopDetail();
  expect(typeof detail).toBe('object');
  expect(typeof detail.cycleCount).toBe('number');
  expect(typeof detail.running).toBe('boolean');
});

test('detail has pendingFollowups as array', () => {
  const detail = getAgentLoopDetail();
  if (!Array.isArray(detail.pendingFollowups)) {
    throw new Error(`pendingFollowups should be array in detail, got ${typeof detail.pendingFollowups}`);
  }
  expect(true).toBe(true);
});

test('detail has lastSignals as array', () => {
  const detail = getAgentLoopDetail();
  if (!Array.isArray(detail.lastSignals)) {
    throw new Error(`lastSignals should be array in detail, got ${typeof detail.lastSignals}`);
  }
  expect(true).toBe(true);
});

test('detail has recentEvents as array', () => {
  const detail = getAgentLoopDetail();
  if (!Array.isArray(detail.recentEvents)) {
    throw new Error(`recentEvents should be array in detail, got ${typeof detail.recentEvents}`);
  }
  expect(true).toBe(true);
});

// ─── trackUserEngagement ─────────────────────────────────────────────────────

console.log('\n=== trackUserEngagement ===');

test('does not throw', () => {
  trackUserEngagement();
  expect(true).toBe(true);
});

// ─── Model routing logic (CODE_KEYWORDS) ─────────────────────────────────────

console.log('\n=== Model routing keyword detection ===');

// Test the CODE_KEYWORDS pattern used for Sonnet routing:
// /\b(create|build|implement|write|add|refactor|fix|hook|module|lib\/|\.js|endpoint|function|handler|parser|schema)\b/i
const CODE_KEYWORDS = /\b(create|build|implement|write|add|refactor|fix|hook|module|lib\/|\.js|endpoint|function|handler|parser|schema)\b/i;

test('code keywords match "implement transcribe.js"', () => {
  expect(CODE_KEYWORDS.test('implement transcribe.js')).toBe(true);
});

test('code keywords match "build proactive-engine.js"', () => {
  expect(CODE_KEYWORDS.test('build proactive-engine.js')).toBe(true);
});

test('code keywords match "write unit tests"', () => {
  expect(CODE_KEYWORDS.test('write unit tests')).toBe(true);
});

test('code keywords match "add a new endpoint"', () => {
  expect(CODE_KEYWORDS.test('add a new endpoint')).toBe(true);
});

test('code keywords match "refactor agent-loop"', () => {
  expect(CODE_KEYWORDS.test('refactor agent-loop')).toBe(true);
});

test('code keywords do NOT match "update goal status"', () => {
  expect(CODE_KEYWORDS.test('update goal status')).toBe(false);
});

test('code keywords do NOT match "review progress"', () => {
  expect(CODE_KEYWORDS.test('review progress')).toBe(false);
});

test('code keywords do NOT match "send summary"', () => {
  expect(CODE_KEYWORDS.test('send summary')).toBe(false);
});

// ─── stopAgentLoop (safe to call without starting) ───────────────────────────

console.log('\n=== stopAgentLoop safety ===');

test('stopAgentLoop does not throw when not started', () => {
  stopAgentLoop();
  expect(true).toBe(true);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
