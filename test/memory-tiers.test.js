/**
 * Tests for memory-tiers.js — run with: node test/memory-tiers.test.js
 *
 * Tests fingerprinting, weight calculation, tier classification, tracking,
 * feedback, ranking, and decay.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'memory-tiers.js')).href;
const {
  fingerprint, trackAccess, trackSave, trackMention,
  recordFeedback, rankResults, getCoreMemories, runDecay, getTierStats,
} = await import(modPath);

// Access state directly for verification
const statePath = pathToFileURL(join(__dirname, '..', 'lib', 'state.js')).href;
const { getState, setState } = await import(statePath);

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
    toBeGreaterThan(n) { if (actual <= n) throw new Error(`Expected ${actual} > ${n}`); },
    toBeGreaterThanOrEqual(n) { if (actual < n) throw new Error(`Expected ${actual} >= ${n}`); },
    toBeLessThan(n) { if (actual >= n) throw new Error(`Expected ${actual} < ${n}`); },
  };
}

// Save initial state to restore later
const initialState = JSON.parse(JSON.stringify(getState('memory-tiers')));

// ---------------------------------------------------------------------------
// fingerprint
// ---------------------------------------------------------------------------
console.log('\n=== fingerprint ===');

test('returns 8-char hex string', () => {
  const fp = fingerprint('hello world test text for fingerprinting');
  expect(fp.length).toBe(8);
  expect(/^[0-9a-f]{8}$/.test(fp)).toBe(true);
});

test('same input → same fingerprint', () => {
  const a = fingerprint('consistent input text here test');
  const b = fingerprint('consistent input text here test');
  expect(a).toBe(b);
});

test('different input → different fingerprint', () => {
  const a = fingerprint('first unique text for hashing purposes');
  const b = fingerprint('second unique text for hashing purposes');
  expect(a === b).toBe(false);
});

test('case insensitive', () => {
  const a = fingerprint('Case Insensitive Text Sample Input');
  const b = fingerprint('case insensitive text sample input');
  expect(a).toBe(b);
});

test('trims whitespace', () => {
  const a = fingerprint('  trimmed text with spaces around it  ');
  const b = fingerprint('trimmed text with spaces around it');
  expect(a).toBe(b);
});

test('truncates at 120 chars', () => {
  const base = 'A'.repeat(120);
  const a = fingerprint(base + 'B'.repeat(50));
  const b = fingerprint(base + 'C'.repeat(50));
  expect(a).toBe(b); // both truncated to same 120 chars
});

// ---------------------------------------------------------------------------
// trackAccess
// ---------------------------------------------------------------------------
console.log('\n=== trackAccess ===');

test('creates new entry on first access', () => {
  const text = `test access entry ${Date.now()} unique text`;
  trackAccess(text);
  const fp = fingerprint(text);
  const entries = getState('memory-tiers').entries || {};
  expect(entries[fp]).toBeTruthy();
  expect(entries[fp].accessCount).toBe(1);
});

test('increments accessCount on repeat access', () => {
  const text = `repeat access test ${Date.now()} unique text`;
  trackAccess(text);
  trackAccess(text);
  trackAccess(text);
  const fp = fingerprint(text);
  const entries = getState('memory-tiers').entries || {};
  expect(entries[fp].accessCount).toBe(3);
});

test('ignores short text (< 10 chars)', () => {
  const before = Object.keys(getState('memory-tiers').entries || {}).length;
  trackAccess('short');
  const after = Object.keys(getState('memory-tiers').entries || {}).length;
  expect(after).toBe(before);
});

// ---------------------------------------------------------------------------
// trackSave
// ---------------------------------------------------------------------------
console.log('\n=== trackSave ===');

test('creates entry with correct type', () => {
  const text = `saved preference ${Date.now()} unique entry`;
  trackSave(text, 'preference', ['user-pref']);
  const fp = fingerprint(text);
  const entries = getState('memory-tiers').entries || {};
  expect(entries[fp].type).toBe('preference');
  expect(entries[fp].tags.includes('user-pref')).toBe(true);
});

test('preference type has higher base weight than fact', () => {
  const prefText = `preference item ${Date.now()} unique value one`;
  const factText = `factual data point ${Date.now()} unique value two`;
  trackSave(prefText, 'preference');
  trackSave(factText, 'fact');
  const prefFp = fingerprint(prefText);
  const factFp = fingerprint(factText);
  const entries = getState('memory-tiers').entries || {};
  expect(entries[prefFp].weight).toBeGreaterThan(entries[factFp].weight);
});

test('explicit type gets highest base weight', () => {
  const text = `explicit memory ${Date.now()} unique entry here`;
  trackSave(text, 'explicit');
  const fp = fingerprint(text);
  const entries = getState('memory-tiers').entries || {};
  expect(entries[fp].weight).toBeGreaterThan(0.7);
});

// ---------------------------------------------------------------------------
// trackMention
// ---------------------------------------------------------------------------
console.log('\n=== trackMention ===');

test('increments mentionCount for existing entry', () => {
  const text = `mention test entry ${Date.now()} unique text here`;
  trackSave(text, 'fact');
  trackMention(text);
  const fp = fingerprint(text);
  const entries = getState('memory-tiers').entries || {};
  expect(entries[fp].mentionCount).toBe(1);
});

test('ignores mention for unknown text', () => {
  // Should not throw or create a new entry
  trackMention(`nonexistent memory ${Date.now()} should be ignored`);
});

// ---------------------------------------------------------------------------
// recordFeedback
// ---------------------------------------------------------------------------
console.log('\n=== recordFeedback ===');

test('confirmed feedback boosts weight', () => {
  const text = `feedback confirmed ${Date.now()} unique test entry`;
  trackSave(text, 'fact');
  const fp = fingerprint(text);
  const before = getState('memory-tiers').entries[fp].weight;
  recordFeedback(text, 'confirmed');
  const after = getState('memory-tiers').entries[fp].weight;
  expect(after).toBeGreaterThan(before);
});

test('corrected feedback reduces weight', () => {
  const text = `feedback corrected ${Date.now()} unique test entry`;
  trackSave(text, 'preference');
  const fp = fingerprint(text);
  const before = getState('memory-tiers').entries[fp].weight;
  recordFeedback(text, 'corrected');
  const after = getState('memory-tiers').entries[fp].weight;
  expect(after).toBeLessThan(before);
});

test('invalid feedback is ignored', () => {
  const text = `feedback invalid ${Date.now()} unique test entry`;
  trackSave(text, 'fact');
  recordFeedback(text, 'invalid-value'); // should do nothing
});

// ---------------------------------------------------------------------------
// rankResults
// ---------------------------------------------------------------------------
console.log('\n=== rankResults ===');

test('returns empty buckets for null input', () => {
  const result = rankResults(null);
  expect(result.t1.length).toBe(0);
  expect(result.t2.length).toBe(0);
  expect(result.t3.length).toBe(0);
});

test('ranks text lines into buckets', () => {
  const lines = [
    `rank test line one ${Date.now()} unique content alpha`,
    `rank test line two ${Date.now()} unique content beta`,
  ].join('\n');
  const result = rankResults(lines);
  // Both should be in t2 (default tier for new facts)
  const totalRanked = result.t1.length + result.t2.length + result.t3.length;
  expect(totalRanked).toBe(2);
});

test('filters out short lines (< 10 chars)', () => {
  const result = rankResults('short\nToo tiny\nThis is a long enough line to be ranked');
  const totalRanked = result.t1.length + result.t2.length + result.t3.length;
  expect(totalRanked).toBe(1);
});

// ---------------------------------------------------------------------------
// getCoreMemories
// ---------------------------------------------------------------------------
console.log('\n=== getCoreMemories ===');

test('returns array of strings', () => {
  const core = getCoreMemories();
  expect(Array.isArray(core)).toBe(true);
  for (const item of core) {
    expect(typeof item).toBe('string');
  }
});

test('returns max 10 items', () => {
  const core = getCoreMemories();
  expect(core.length <= 10).toBe(true);
});

// ---------------------------------------------------------------------------
// runDecay
// ---------------------------------------------------------------------------
console.log('\n=== runDecay ===');

test('runDecay returns number of changed tiers', () => {
  const changed = runDecay();
  expect(typeof changed).toBe('number');
  expect(changed >= 0).toBe(true);
});

// ---------------------------------------------------------------------------
// getTierStats
// ---------------------------------------------------------------------------
console.log('\n=== getTierStats ===');

test('getTierStats returns valid stats', () => {
  const stats = getTierStats();
  expect(typeof stats.total).toBe('number');
  expect(typeof stats.t1).toBe('number');
  expect(typeof stats.t2).toBe('number');
  expect(typeof stats.t3).toBe('number');
  expect(stats.total).toBe(stats.t1 + stats.t2 + stats.t3);
});

test('avgWeight is between 0 and 1', () => {
  const stats = getTierStats();
  if (stats.total > 0) {
    expect(stats.avgWeight).toBeGreaterThan(0);
    expect(stats.avgWeight <= 1).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// Cleanup: restore initial state
// ---------------------------------------------------------------------------
setState('memory-tiers', initialState);

console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
