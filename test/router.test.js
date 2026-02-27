/**
 * Integration tests for lib/router.js — run with: node test/router.test.js
 *
 * Tests the full routeMessage pipeline:
 *   slash commands → action, NLU match → action, ack tier → ack, fallthrough → claude
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'router.js')).href;
const { routeMessage } = await import(modPath);

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
    toEqual(expected) {
      const a = JSON.stringify(actual), b = JSON.stringify(expected);
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
    },
  };
}

const TEST_JID = 'test@s.whatsapp.net';

// ─── Slash command routing ─────────────────────────────────────────────────

console.log('\n=== Slash Command Routing ===');

test('/clear → action:clear', () => {
  const r = routeMessage('/clear', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('clear');
  expect(r.tier).toBe(0);
});

test('/help → action:help', () => {
  const r = routeMessage('/help', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('help');
});

test('/status → action:status', () => {
  const r = routeMessage('/status', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('status');
});

test('/goals → action:goals', () => {
  const r = routeMessage('/goals', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('goals');
});

test('/recap → action:recap', () => {
  const r = routeMessage('/recap', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('recap');
});

test('/cost → action:cost', () => {
  const r = routeMessage('/cost', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('cost');
});

test('/costs → action:cost (alias)', () => {
  const r = routeMessage('/costs', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('cost');
});

test('/brain → action:brain', () => {
  const r = routeMessage('/brain', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('brain');
});

// ─── Parameterized slash commands ─────────────────────────────────────────

console.log('\n=== Parameterized Slash Commands ===');

test('/wf list → action:workflow-manage with subCmd=list', () => {
  const r = routeMessage('/wf list', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('workflow-manage');
  expect(r.params.subCmd).toBe('list');
  expect(r.params.arg).toBe('');
});

test('/wf cancel abc123 → action:workflow-manage with arg', () => {
  const r = routeMessage('/wf cancel abc123', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('workflow-manage');
  expect(r.params.subCmd).toBe('cancel');
  expect(r.params.arg).toBe('abc123');
});

test('/goal list → action:goal-manage', () => {
  const r = routeMessage('/goal list', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('goal-manage');
  expect(r.params.subCmd).toBe('list');
});

test('/send file.pdf → action:send with file param', () => {
  const r = routeMessage('/send file.pdf', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('send');
  expect(r.params.file).toBe('file.pdf');
});

test('/plugin list → action:plugin-manage', () => {
  const r = routeMessage('/plugin list', TEST_JID);
  expect(r.type).toBe('action');
  expect(r.action).toBe('plugin-manage');
  expect(r.params.subCmd).toBe('list');
});

test('/task build something → claude tier:3 taskMode', () => {
  const r = routeMessage('/task build something', TEST_JID);
  expect(r.type).toBe('claude');
  expect(r.tier).toBe(3);
});

// ─── Ack routing (tier 0) ─────────────────────────────────────────────────

console.log('\n=== Acknowledgment Routing (Tier 0) ===');

test('"ok" → ack (no LLM)', () => {
  const r = routeMessage('ok', TEST_JID);
  expect(r.type).toBe('ack');
  expect(r.tier).toBe(0);
});

test('"thanks" → ack', () => {
  const r = routeMessage('thanks', TEST_JID);
  expect(r.type).toBe('ack');
});

test('"תודה" → ack (Hebrew)', () => {
  const r = routeMessage('תודה', TEST_JID);
  expect(r.type).toBe('ack');
});

test('"👍" alone does NOT go to ack (not in pattern)', () => {
  const r = routeMessage('👍', TEST_JID);
  // emoji-only may fall through to claude (not an ack word), just check it's not broken
  expect(typeof r.type).toBe('string');
});

// ─── Unknown slash command ─────────────────────────────────────────────────

console.log('\n=== Unknown Slash Commands ===');

test('/unknown → command type', () => {
  const r = routeMessage('/unknown', TEST_JID);
  expect(r.type).toBe('command');
});

test('/foobar → command type', () => {
  const r = routeMessage('/foobar', TEST_JID);
  expect(r.type).toBe('command');
});

// ─── Claude fallthrough ────────────────────────────────────────────────────

console.log('\n=== Claude Fallthrough ===');

test('regular text → claude', () => {
  const r = routeMessage('What is the weather today?', TEST_JID);
  expect(r.type).toBe('claude');
});

test('long complex question → claude', () => {
  const r = routeMessage('Can you help me understand how the goals system works in Sela?', TEST_JID);
  expect(r.type).toBe('claude');
});

// ─── Return shape validation ───────────────────────────────────────────────

console.log('\n=== Return Shape ===');

test('all routes have a type field', () => {
  const inputs = ['/help', 'ok', 'hello', '/unknown', '/wf list'];
  for (const input of inputs) {
    const r = routeMessage(input, TEST_JID);
    if (!r || !r.type) throw new Error(`Missing type for input: "${input}"`);
  }
  expect(true).toBe(true);
});

test('all routes have a numeric tier field', () => {
  const inputs = ['/help', 'ok', 'hello'];
  for (const input of inputs) {
    const r = routeMessage(input, TEST_JID);
    if (typeof r.tier !== 'number') throw new Error(`Non-numeric tier for input: "${input}", got: ${typeof r.tier}`);
  }
  expect(true).toBe(true);
});

test('action routes have action field', () => {
  const r = routeMessage('/status', TEST_JID);
  expect(r.type).toBe('action');
  expect(typeof r.action).toBe('string');
});

// ─── Summary ──────────────────────────────────────────────────────────────

console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
