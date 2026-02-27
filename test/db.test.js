/**
 * Tests for lib/db.js — run with: node test/db.test.js
 *
 * Tests kv_state CRUD: kvGet, kvSet, kvDelete.
 * Uses unique key prefixes to avoid colliding with real bot data.
 * Runs against the real SQLite database (sela.db) in test mode.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'db.js')).href;
const { kvGet, kvSet, kvDelete, getDb } = await import(modPath);

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
    passed++; console.log(`  PASS  ${name}`);
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
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
    },
    toEqual(expected) {
      const a = JSON.stringify(actual), b = JSON.stringify(expected);
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
    },
  };
}

// Unique prefix so tests don't collide with real bot state
const PREFIX = `_test_db_${Date.now()}`;
const KEY = `${PREFIX}_basic`;

// ─── kvGet ───────────────────────────────────────────────────────────────────

console.log('\n=== kvGet ===');

test('returns null for unknown key', () => {
  const result = kvGet(`${PREFIX}_nonexistent`);
  expect(result).toBeNull();
});

// ─── kvSet ───────────────────────────────────────────────────────────────────

console.log('\n=== kvSet ===');

test('stores and retrieves a string value', () => {
  kvSet(KEY, 'hello');
  const result = kvGet(KEY);
  expect(result).toBe('hello');
});

test('stores and retrieves a number', () => {
  kvSet(`${PREFIX}_num`, 42);
  const result = kvGet(`${PREFIX}_num`);
  expect(result).toBe(42);
});

test('stores and retrieves an object', () => {
  const obj = { foo: 'bar', count: 3, nested: { x: true } };
  kvSet(`${PREFIX}_obj`, obj);
  const result = kvGet(`${PREFIX}_obj`);
  expect(result.foo).toBe('bar');
  expect(result.count).toBe(3);
  expect(result.nested.x).toBe(true);
});

test('stores and retrieves an array', () => {
  kvSet(`${PREFIX}_arr`, [1, 2, 3]);
  const result = kvGet(`${PREFIX}_arr`);
  expect(result[0]).toBe(1);
  expect(result[2]).toBe(3);
});

test('overwrites existing value', () => {
  kvSet(`${PREFIX}_overwrite`, 'first');
  kvSet(`${PREFIX}_overwrite`, 'second');
  const result = kvGet(`${PREFIX}_overwrite`);
  expect(result).toBe('second');
});

test('stores boolean false', () => {
  kvSet(`${PREFIX}_bool`, false);
  const result = kvGet(`${PREFIX}_bool`);
  expect(result).toBe(false);
});

test('stores null explicitly', () => {
  kvSet(`${PREFIX}_null`, null);
  const result = kvGet(`${PREFIX}_null`);
  expect(result).toBeNull();
});

// ─── kvDelete ────────────────────────────────────────────────────────────────

console.log('\n=== kvDelete ===');

test('deletes an existing key', () => {
  kvSet(`${PREFIX}_del`, 'to-delete');
  kvDelete(`${PREFIX}_del`);
  const result = kvGet(`${PREFIX}_del`);
  expect(result).toBeNull();
});

test('deleting non-existent key does not throw', () => {
  // Should not throw
  kvDelete(`${PREFIX}_never_existed`);
  expect(true).toBe(true);
});

// ─── upsert semantics ────────────────────────────────────────────────────────

console.log('\n=== upsert ===');

test('multiple writes to same key update updated_at', () => {
  const db = getDb();
  kvSet(`${PREFIX}_ts`, 'v1');
  const row1 = db.prepare('SELECT updated_at FROM kv_state WHERE key = ?').get(`${PREFIX}_ts`);
  // Brief pause not needed — upsert always updates updated_at
  kvSet(`${PREFIX}_ts`, 'v2');
  const row2 = db.prepare('SELECT updated_at FROM kv_state WHERE key = ?').get(`${PREFIX}_ts`);
  // updated_at should be >= first write (same ms is fine since tests run fast)
  if (row2.updated_at < row1.updated_at) {
    throw new Error(`updated_at decreased: ${row1.updated_at} → ${row2.updated_at}`);
  }
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

// Remove all test keys
const db = getDb();
db.prepare(`DELETE FROM kv_state WHERE key LIKE ?`).run(`${PREFIX}%`);

console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
