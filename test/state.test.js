/**
 * Tests for state.js — run with: node test/state.test.js
 *
 * Tests state CRUD: getState, setState, updateStateField, incrementState.
 * Uses a unique state key to avoid interfering with real bot state.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'state.js')).href;
const { getState, setState, updateStateField, incrementState } = await import(modPath);

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
  };
}

// Use a unique key so we don't collide with real state
const KEY = `_test_state_${Date.now()}`;

// ---------------------------------------------------------------------------
// getState
// ---------------------------------------------------------------------------
console.log('\n=== getState ===');

test('returns empty object for unknown key', () => {
  const result = getState(KEY);
  expect(typeof result).toBe('object');
  expect(Object.keys(result).length).toBe(0);
});

test('returns cached value on second read', () => {
  const a = getState(KEY);
  const b = getState(KEY);
  expect(a === b).toBe(true); // same reference
});

// ---------------------------------------------------------------------------
// setState
// ---------------------------------------------------------------------------
console.log('\n=== setState ===');

test('merges data into state', () => {
  const result = setState(KEY, { foo: 'bar' });
  expect(result.foo).toBe('bar');
  expect(result.updatedAt).toBeTruthy();
});

test('shallow merges with existing state', () => {
  setState(KEY, { foo: 'bar' });
  const result = setState(KEY, { baz: 42 });
  expect(result.foo).toBe('bar');
  expect(result.baz).toBe(42);
});

test('overwrites existing fields', () => {
  setState(KEY, { foo: 'bar' });
  const result = setState(KEY, { foo: 'updated' });
  expect(result.foo).toBe('updated');
});

test('getState returns updated data after setState', () => {
  setState(KEY, { check: 'value' });
  const result = getState(KEY);
  expect(result.check).toBe('value');
});

// ---------------------------------------------------------------------------
// updateStateField
// ---------------------------------------------------------------------------
console.log('\n=== updateStateField ===');

test('updates a single field', () => {
  const result = updateStateField(KEY, 'singleField', 'hello');
  expect(result.singleField).toBe('hello');
  expect(result.updatedAt).toBeTruthy();
});

test('preserves other fields', () => {
  setState(KEY, { keep: 'me', other: 'value' });
  updateStateField(KEY, 'other', 'changed');
  const result = getState(KEY);
  expect(result.keep).toBe('me');
  expect(result.other).toBe('changed');
});

// ---------------------------------------------------------------------------
// incrementState
// ---------------------------------------------------------------------------
console.log('\n=== incrementState ===');

test('increments a counter from 0', () => {
  const result = incrementState(KEY, 'counter');
  expect(result.counter).toBe(1);
});

test('increments existing counter', () => {
  incrementState(KEY, 'counter'); // now 2
  const result = incrementState(KEY, 'counter'); // now 3
  expect(result.counter).toBe(3);
});

test('increments by custom amount', () => {
  setState(KEY, { customCounter: 10 });
  const result = incrementState(KEY, 'customCounter', 5);
  expect(result.customCounter).toBe(15);
});

test('sets updatedAt on increment', () => {
  const before = Date.now();
  const result = incrementState(KEY, 'counter');
  expect(result.updatedAt).toBeGreaterThan(before - 1);
});

// ---------------------------------------------------------------------------
// Cleanup: remove test state file
// ---------------------------------------------------------------------------
import { unlinkSync } from 'fs';
import config from '../lib/config.js';
try { unlinkSync(join(config.dataDir, 'state', `${KEY}.json`)); } catch {}

console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
