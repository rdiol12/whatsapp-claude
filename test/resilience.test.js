/**
 * Tests for resilience.js — run with: node test/resilience.test.js
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'resilience.js')).href;
const { writeFileAtomic, cleanupOrphanedTempFiles, classifyError, retry } = await import(modPath);

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
    toContain(substr) { if (!String(actual).includes(substr)) throw new Error(`Expected "${actual}" to contain "${substr}"`); },
  };
}

// Temp dir for tests
const TEST_DIR = join(tmpdir(), `resilience-test-${Date.now()}`);
mkdirSync(TEST_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// writeFileAtomic
// ---------------------------------------------------------------------------
console.log('\n=== writeFileAtomic ===');

test('writes file content correctly', () => {
  const fp = join(TEST_DIR, 'test1.json');
  writeFileAtomic(fp, '{"hello":"world"}');
  const content = readFileSync(fp, 'utf-8');
  expect(content).toBe('{"hello":"world"}');
});

test('overwrites existing file', () => {
  const fp = join(TEST_DIR, 'test2.json');
  writeFileAtomic(fp, 'first');
  writeFileAtomic(fp, 'second');
  expect(readFileSync(fp, 'utf-8')).toBe('second');
});

test('no temp files left after successful write', () => {
  const fp = join(TEST_DIR, 'test3.json');
  writeFileAtomic(fp, 'data');
  const tmpFiles = readdirSync(TEST_DIR).filter(f => f.includes('.tmp.'));
  expect(tmpFiles.length).toBe(0);
});

// ---------------------------------------------------------------------------
// cleanupOrphanedTempFiles
// ---------------------------------------------------------------------------
console.log('\n=== cleanupOrphanedTempFiles ===');

test('removes orphaned .tmp files', () => {
  const orphan1 = join(TEST_DIR, 'file.json.tmp.12345');
  const orphan2 = join(TEST_DIR, 'other.json.tmp.99999');
  const keepFile = join(TEST_DIR, 'keep.json');
  writeFileSync(orphan1, 'orphan');
  writeFileSync(orphan2, 'orphan');
  writeFileSync(keepFile, 'keep');

  cleanupOrphanedTempFiles(TEST_DIR);

  expect(existsSync(orphan1)).toBe(false);
  expect(existsSync(orphan2)).toBe(false);
  expect(existsSync(keepFile)).toBe(true);
});

test('handles empty directory', () => {
  const emptyDir = join(TEST_DIR, 'empty');
  mkdirSync(emptyDir, { recursive: true });
  cleanupOrphanedTempFiles(emptyDir); // should not throw
});

test('handles non-existent directory', () => {
  cleanupOrphanedTempFiles(join(TEST_DIR, 'does-not-exist')); // should not throw
});

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------
console.log('\n=== classifyError ===');

test('classifies timeout as transient', () => {
  expect(classifyError(new Error('request timeout'))).toBe('transient');
});

test('classifies ECONNREFUSED as transient', () => {
  expect(classifyError(new Error('connect ECONNREFUSED'))).toBe('transient');
});

test('classifies socket hang up as transient', () => {
  expect(classifyError(new Error('socket hang up'))).toBe('transient');
});

test('classifies exited as transient', () => {
  expect(classifyError(new Error('process exited code 1'))).toBe('transient');
});

test('classifies auth as permanent', () => {
  expect(classifyError(new Error('unauthorized'))).toBe('permanent');
});

test('classifies ENOENT as permanent', () => {
  const err = new Error('not found');
  err.code = 'ENOENT';
  expect(classifyError(err)).toBe('permanent');
});

test('classifies isPermanent flag as permanent', () => {
  const err = new Error('something');
  err.isPermanent = true;
  expect(classifyError(err)).toBe('permanent');
});

test('classifies invalid as permanent', () => {
  expect(classifyError(new Error('invalid request body'))).toBe('permanent');
});

test('classifies logged out as permanent', () => {
  expect(classifyError(new Error('logged out, please re-scan'))).toBe('permanent');
});

test('classifies unknown errors as transient (safe default)', () => {
  expect(classifyError(new Error('some random error'))).toBe('transient');
});

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------
console.log('\n=== retry ===');

await test('succeeds on first try', async () => {
  let calls = 0;
  const result = await retry(async () => { calls++; return 'ok'; }, { retries: 3, baseMs: 10 });
  expect(result).toBe('ok');
  expect(calls).toBe(1);
});

await test('retries on transient error and succeeds', async () => {
  let calls = 0;
  const result = await retry(async () => {
    calls++;
    if (calls < 3) throw new Error('timeout');
    return 'ok';
  }, { retries: 3, baseMs: 10 });
  expect(result).toBe('ok');
  expect(calls).toBe(3);
});

await test('does not retry permanent errors', async () => {
  let calls = 0;
  try {
    await retry(async () => {
      calls++;
      const err = new Error('unauthorized');
      throw err;
    }, { retries: 3, baseMs: 10 });
    throw new Error('should have thrown');
  } catch (err) {
    expect(calls).toBe(1);
    expect(err.message).toContain('unauthorized');
  }
});

await test('throws after max retries', async () => {
  let calls = 0;
  try {
    await retry(async () => {
      calls++;
      throw new Error('timeout');
    }, { retries: 3, baseMs: 10 });
    throw new Error('should have thrown');
  } catch (err) {
    expect(calls).toBe(3);
    expect(err.message).toContain('timeout');
  }
});

// ---------------------------------------------------------------------------
// Cleanup and summary
// ---------------------------------------------------------------------------
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
