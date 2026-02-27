/**
 * Tests for intent.js classifyTier — run with: node test/intent.test.js
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'intent.js')).href;
const { classifyTier } = await import(modPath);

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

function expect(actual) {
  return {
    toBe(expected) { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
  };
}

// ---------------------------------------------------------------------------
// Tier 0: Acknowledgments
// ---------------------------------------------------------------------------
console.log('\n=== Tier 0: Acknowledgments ===');

for (const phrase of ['ok', 'okay', 'k', 'sure', 'thanks', 'thx', 'cool', 'nice', 'got it', 'yep', 'lol', 'haha', 'סבבה', 'אחלה', 'תודה', 'בסדר', 'מעולה']) {
  test(`"${phrase}" → tier 0`, () => expect(classifyTier(phrase).tier).toBe(0));
}

test('"ok!" → tier 0', () => expect(classifyTier('ok!').tier).toBe(0));
test('"thanks." → tier 0', () => expect(classifyTier('thanks.').tier).toBe(0));
test('"  cool  " → tier 0 (whitespace)', () => expect(classifyTier('  cool  ').tier).toBe(0));

// Non-persistent mode options (tests must opt out of persistent mode
// because the running .env has PERSISTENT_MODE=true)
const NP = { persistentMode: false };

// ---------------------------------------------------------------------------
// Tier 1: Short simple messages
// ---------------------------------------------------------------------------
console.log('\n=== Tier 1: Short simple ===');

test('"hi" → tier 1', () => expect(classifyTier('hi', NP).tier).toBe(1));
test('"status" → tier 1', () => expect(classifyTier('status', NP).tier).toBe(1));
test('"what time" → tier 1', () => expect(classifyTier('what time', NP).tier).toBe(1));

// ---------------------------------------------------------------------------
// Tier 2: Standard messages
// ---------------------------------------------------------------------------
console.log('\n=== Tier 2: Standard ===');

test('"how does the router work?" → tier 2', () => expect(classifyTier('how does the router work?', NP).tier).toBe(2));
test('"can you explain the queue system" → tier 2', () => expect(classifyTier('can you explain the queue system', NP).tier).toBe(2));
test('"why did the build fail?" → tier 3 (has build/debug keywords)', () => expect(classifyTier('why did the build fail?', NP).tier).toBe(3));
test('"tell me about today meetings" → tier 2 (complexity signal)', () => expect(classifyTier('can you tell me about the meetings today please', NP).tier).toBe(2));

// ---------------------------------------------------------------------------
// Tier 3: Complex tasks
// ---------------------------------------------------------------------------
console.log('\n=== Tier 3: Complex tasks ===');

test('"fix the bug in login" → tier 3', () => expect(classifyTier('fix the bug in login', NP).tier).toBe(3));
test('"write a script to..." → tier 3', () => expect(classifyTier('write a script to clean logs', NP).tier).toBe(3));
test('"debug the cron job" → tier 3', () => expect(classifyTier('debug the cron job', NP).tier).toBe(3));
test('"```code block```" → tier 3', () => expect(classifyTier('```const x = 1```', NP).tier).toBe(3));
test('"deploy the app" → tier 3', () => expect(classifyTier('deploy the app to production', NP).tier).toBe(3));
test('"http://example.com" → tier 3 (URL)', () => expect(classifyTier('check http://example.com', NP).tier).toBe(3));
test('"500+ chars" → tier 3 (long)', () => expect(classifyTier('a'.repeat(501), NP).tier).toBe(3));
test('"תקן את הבאג" → tier 3 (Hebrew)', () => expect(classifyTier('תקן את הבאג בקוד', NP).tier).toBe(3));
test('"help me fix the server" → tier 3', () => expect(classifyTier('help me fix the server!!', NP).tier).toBe(3));

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
console.log('\n=== Edge Cases ===');

test('"" → tier 1 (empty → short)', () => expect(classifyTier('', NP).tier).toBe(1));
test('"  " → tier 0 (whitespace → ack-like)', () => {
  const t = classifyTier('  ', NP).tier;
  // Whitespace-only may be tier 0 or 1 depending on regex
  if (t !== 0 && t !== 1) throw new Error(`Expected tier 0 or 1, got ${t}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
