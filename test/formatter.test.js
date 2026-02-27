/**
 * Tests for formatter.js — run with: node test/formatter.test.js
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'formatter.js')).href;
const { formatForWhatsApp, chunkMessage } = await import(modPath);

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
// chunkMessage (extracted from whatsapp.js)
// ---------------------------------------------------------------------------
console.log('\n=== chunkMessage ===');

test('short text returns single chunk', () => {
  const result = chunkMessage('Hello world', 3800);
  if (!Array.isArray(result) || result.length !== 1) throw new Error(`Expected 1 chunk, got ${result.length}`);
  if (result[0] !== 'Hello world') throw new Error(`Expected "Hello world", got "${result[0]}"`);
});

test('text at exactly maxChunk returns single chunk', () => {
  const text = 'A'.repeat(3800);
  const result = chunkMessage(text, 3800);
  if (result.length !== 1) throw new Error(`Expected 1 chunk, got ${result.length}`);
});

test('text over maxChunk returns multiple chunks', () => {
  const text = 'A'.repeat(5000);
  const result = chunkMessage(text, 3800);
  if (result.length < 2) throw new Error(`Expected >= 2 chunks, got ${result.length}`);
});

test('chunks at natural paragraph break', () => {
  // First chunk fills maxChunk, second follows after \n\n
  const text = 'A'.repeat(3600) + '\n\nSecond paragraph here.';
  const result = chunkMessage(text, 3600);
  if (result.length !== 2) throw new Error(`Expected 2 chunks, got ${result.length}`);
  if (!result[1].startsWith('Second')) throw new Error(`Second chunk should start with "Second", got "${result[1].slice(0, 20)}"`);
});

test('chunks at newline when no paragraph break', () => {
  // Force a split: text longer than maxChunk, break is a single \n
  const text = 'A'.repeat(3600) + '\nSecond line.';
  const result = chunkMessage(text, 3600);
  if (result.length !== 2) throw new Error(`Expected 2 chunks, got ${result.length}`);
  if (!result[1].startsWith('Second')) throw new Error(`Second chunk should start with "Second", got "${result[1].slice(0, 20)}"`);
});

test('no chunk exceeds maxChunk on hard cut', () => {
  const text = 'A'.repeat(8000); // no natural breaks
  const result = chunkMessage(text, 3800);
  for (const chunk of result) {
    if (chunk.length > 3800) throw new Error(`Chunk length ${chunk.length} exceeds maxChunk 3800`);
  }
});

test('reassembled chunks cover all content', () => {
  const text = 'Word '.repeat(2000); // ~10000 chars with space-based natural breaks
  const result = chunkMessage(text, 3800);
  if (result.length < 2) throw new Error(`Expected multiple chunks, got ${result.length}`);
  // All chunks together should contain the same number of 'Word' occurrences as the original
  const totalWords = result.join(' ').split('Word').length - 1;
  const originalWords = text.split('Word').length - 1;
  if (totalWords !== originalWords) throw new Error(`Word count mismatch: original=${originalWords}, reassembled=${totalWords}`);
});

test('uses default maxChunk of 3800 when not specified', () => {
  const text = 'B'.repeat(3801);
  const result = chunkMessage(text); // no maxChunk arg
  if (result.length < 2) throw new Error(`Expected >= 2 chunks without explicit maxChunk, got ${result.length}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
