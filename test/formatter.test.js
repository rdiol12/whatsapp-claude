/**
 * Tests for formatter.js — run with: node test/formatter.test.js
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'formatter.js')).href;
const { formatForWhatsApp } = await import(modPath);

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

function expect(actual) {
  return {
    toBe(expected) { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
    toContain(str) { if (!actual.includes(str)) throw new Error(`Expected to contain ${JSON.stringify(str)}, got ${JSON.stringify(actual)}`); },
    notToContain(str) { if (actual.includes(str)) throw new Error(`Expected NOT to contain ${JSON.stringify(str)}, got ${JSON.stringify(actual)}`); },
  };
}

// ---------------------------------------------------------------------------
// Markdown → WhatsApp
// ---------------------------------------------------------------------------
console.log('\n=== Markdown Conversion ===');

test('# header → *bold*', () => {
  expect(formatForWhatsApp('# Hello World')).toBe('*Hello World*');
});

test('## header → *bold*', () => {
  expect(formatForWhatsApp('## Section Title')).toBe('*Section Title*');
});

test('### header → *bold*', () => {
  expect(formatForWhatsApp('### Sub Section')).toBe('*Sub Section*');
});

test('markdown link → plain text + URL', () => {
  expect(formatForWhatsApp('[Click here](https://example.com)')).toBe('Click here: https://example.com');
});

test('code block language stripped', () => {
  const input = '```javascript\nconst x = 1;\n```';
  const result = formatForWhatsApp(input);
  expect(result).notToContain('javascript');
  expect(result).toContain('const x = 1;');
});

// ---------------------------------------------------------------------------
// Whitespace cleanup
// ---------------------------------------------------------------------------
console.log('\n=== Whitespace ===');

test('triple newlines collapsed', () => {
  expect(formatForWhatsApp('a\n\n\nb')).toBe('a\n\nb');
});

test('4+ newlines collapsed', () => {
  expect(formatForWhatsApp('a\n\n\n\n\nb')).toBe('a\n\nb');
});

// ---------------------------------------------------------------------------
// Filler removal
// ---------------------------------------------------------------------------
console.log('\n=== Filler Phrases ===');

test('"Great question!" removed', () => {
  expect(formatForWhatsApp('Great question! Here is the answer.')).toBe('Here is the answer.');
});

test('"I\'d be happy to help!" removed', () => {
  expect(formatForWhatsApp("I'd be happy to help! The fix is simple.")).toBe('The fix is simple.');
});

test('"Sure thing!" removed', () => {
  expect(formatForWhatsApp('Sure thing! Done.')).toBe('Done.');
});

// ---------------------------------------------------------------------------
// Long code blocks
// ---------------------------------------------------------------------------
console.log('\n=== Code Block Truncation ===');

test('short code block preserved', () => {
  const input = '```\nline1\nline2\nline3\n```';
  const result = formatForWhatsApp(input);
  expect(result).toContain('line1');
  expect(result).toContain('line3');
});

test('long code block (>20 lines) truncated', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`);
  const input = '```\n' + lines.join('\n') + '\n```';
  const result = formatForWhatsApp(input);
  expect(result).toContain('line1');
  expect(result).toContain('_(truncated)_');
  expect(result).notToContain('line25');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
console.log('\n=== Edge Cases ===');

test('null/undefined passthrough', () => {
  expect(formatForWhatsApp(null)).toBe(null);
  expect(formatForWhatsApp(undefined)).toBe(undefined);
});

test('empty string', () => {
  expect(formatForWhatsApp('')).toBe('');
});

test('plain text unchanged', () => {
  expect(formatForWhatsApp('Hello world')).toBe('Hello world');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
