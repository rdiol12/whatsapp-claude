/**
 * Tests for history.js — run with: node test/history.test.js
 *
 * Tests buildHistoryForClaude (ACK filtering, token budgeting, role enforcement).
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'history.js')).href;
const { addMessage, getMessages, buildHistoryForClaude, clear, trackTopic, getRecentTopics } = await import(modPath);

// Single run-stamp for ALL test JIDs — avoids accumulating unique sessions per test
const RUN = Date.now();
const testJids = new Set(); // track every JID created so we can clean up

function testJid(prefix) {
  const jid = `test-${prefix}-${RUN}@s.whatsapp.net`;
  testJids.add(jid);
  return jid;
}

function cleanupAll() {
  for (const jid of testJids) {
    try { clear(jid); } catch (_) {}
  }
}

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

function expect(actual) {
  return {
    toBe(expected) { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
    toBeAbove(n) { if (!(actual > n)) throw new Error(`Expected ${actual} > ${n}`); },
    toBeBelow(n) { if (!(actual < n)) throw new Error(`Expected ${actual} < ${n}`); },
    toBeTruthy() { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
  };
}

// Use a unique test JID to avoid conflicts
const JID = testJid('history');

// ---------------------------------------------------------------------------
// addMessage / getMessages
// ---------------------------------------------------------------------------
console.log('\n=== addMessage / getMessages ===');

test('empty history returns []', () => {
  expect(getMessages(JID).length).toBe(0);
});

test('addMessage stores messages', () => {
  addMessage(JID, 'user', 'hello');
  addMessage(JID, 'assistant', 'hi there');
  expect(getMessages(JID).length).toBe(2);
});

test('messages have role, content, ts', () => {
  const msgs = getMessages(JID);
  expect(msgs[0].role).toBe('user');
  expect(msgs[0].content).toBe('hello');
  expect(msgs[0].ts > 0).toBeTruthy();
});

// ---------------------------------------------------------------------------
// buildHistoryForClaude — ACK filtering
// ---------------------------------------------------------------------------
console.log('\n=== ACK Filtering ===');

const JID2 = testJid('ack');

test('small history returned as-is', () => {
  addMessage(JID2, 'user', 'hello');
  addMessage(JID2, 'assistant', 'hi');
  addMessage(JID2, 'user', 'how are you?');
  const result = buildHistoryForClaude(JID2);
  expect(result.length).toBe(3);
});

test('acks in older messages are filtered', () => {
  const jid = testJid('ack-filter');
  // Add 8 messages: user-assistant pairs, with acks in the older ones
  addMessage(jid, 'user', 'tell me about the project');
  addMessage(jid, 'assistant', 'The project is a Node.js app...');
  addMessage(jid, 'user', 'ok'); // ack — should be filtered from older
  addMessage(jid, 'assistant', '[acknowledged]'); // ack reply — filtered
  addMessage(jid, 'user', 'what about the database?');
  addMessage(jid, 'assistant', 'We use PostgreSQL...');
  // Last 5 (always kept)
  addMessage(jid, 'user', 'cool'); // ack in recent — kept (last 5)
  addMessage(jid, 'assistant', '[acknowledged]');
  addMessage(jid, 'user', 'thanks'); // ack in recent — kept
  addMessage(jid, 'assistant', 'You are welcome');
  addMessage(jid, 'user', 'one more question');

  const result = buildHistoryForClaude(jid);
  // The "ok" and "[acknowledged]" from older should be replaced with "[N brief exchanges]"
  const briefExchanges = result.filter(m => m.content.includes('brief exchanges'));
  expect(briefExchanges.length > 0).toBeTruthy();
  // Total should be less than 11 (some acks removed)
  expect(result.length).toBeBelow(11);
});

test('ack confirming a decision is kept', () => {
  const jid = testJid('ack-decision');
  addMessage(jid, 'user', 'should we use Redis?');
  addMessage(jid, 'assistant', 'I decided to use Redis for caching.');
  addMessage(jid, 'user', 'ok'); // confirms a decision — should be kept
  addMessage(jid, 'user', 'what next?');
  addMessage(jid, 'assistant', 'Now let me set up the config...');
  addMessage(jid, 'user', 'sounds good');
  addMessage(jid, 'assistant', 'Done.');
  addMessage(jid, 'user', 'test1');
  addMessage(jid, 'assistant', 'test2');
  addMessage(jid, 'user', 'test3');

  const result = buildHistoryForClaude(jid);
  // The "ok" after "decided" should be preserved
  const hasOk = result.some(m => m.content === 'ok');
  expect(hasOk).toBeTruthy();
});

// ---------------------------------------------------------------------------
// buildHistoryForClaude — first message must be user role
// ---------------------------------------------------------------------------
console.log('\n=== Role Enforcement ===');

test('first message in result is always user role', () => {
  const jid = testJid('role');
  addMessage(jid, 'user', 'hello');
  addMessage(jid, 'assistant', 'hi');
  const result = buildHistoryForClaude(jid);
  expect(result[0].role).toBe('user');
});

// ---------------------------------------------------------------------------
// buildHistoryForClaude — token budget
// ---------------------------------------------------------------------------
console.log('\n=== Token Budget ===');

test('respects maxTokens budget', () => {
  const jid = testJid('budget');
  // Add many long messages
  for (let i = 0; i < 20; i++) {
    addMessage(jid, 'user', 'A'.repeat(200) + ` message ${i}`);
    addMessage(jid, 'assistant', 'B'.repeat(200) + ` reply ${i}`);
  }
  // Build with a tiny budget
  const result = buildHistoryForClaude(jid, 500);
  // Should have trimmed many messages
  expect(result.length).toBeBelow(40);
  expect(result.length >= 5).toBeTruthy(); // always keeps last 5
});

// ---------------------------------------------------------------------------
// trackTopic / getRecentTopics
// ---------------------------------------------------------------------------
console.log('\n=== Topic Tracking ===');

test('trackTopic extracts meaningful words', () => {
  const jid = testJid('topic');
  trackTopic(jid, 'Working on the OpenClaw project today');
  const topics = getRecentTopics(jid);
  expect(topics.length > 0).toBeTruthy();
  expect(topics.includes('openclaw')).toBeTruthy();
});

test('trackTopic ignores stopwords', () => {
  const jid = testJid('topic-stop');
  trackTopic(jid, 'the and but if then');
  const topics = getRecentTopics(jid);
  expect(topics.length).toBe(0);
});

test('getRecentTopics returns [] for unknown jid', () => {
  expect(getRecentTopics('unknown-jid').length).toBe(0);
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------
console.log('\n=== Clear ===');

test('clear removes all messages', () => {
  const jid = testJid('clear');
  addMessage(jid, 'user', 'hello');
  addMessage(jid, 'assistant', 'hi');
  clear(jid);
  expect(getMessages(jid).length).toBe(0);
});

// Cleanup ALL test JIDs — prevents polluting production DB
cleanupAll();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
