/**
 * Tests for outcome-tracker sentiment detection.
 * Tests the regex logic directly to avoid importing heavy deps (claude.js).
 * Run with: node test/sentiment.test.js
 */

// Duplicate the regexes from outcome-tracker.js to avoid importing the full module
// (which pulls in claude.js, mcp-gateway.js, state.js with side effects)
const POSITIVE_RE = /^[\s\W]*(perfect|great|excellent|exactly|works|fixed it|done|love it|תותח|מעולה|אחלה|מושלם|עובד|כן בדיוק|👍|✅|💯|🔥)[\s\W]*$/i;
const NEGATIVE_RE = /^[\s\W]*(wrong|broken|useless|failed|not what|לא עובד|שגוי|לא מה שביקשתי|👎|❌|nope|garbage)[\s\W]*$/i;

function detectActionFeedback(text, prevTurnWasAction) {
  if (!text || !prevTurnWasAction) return null;
  const trimmed = text.trim();
  if (trimmed.length > 50) return null;
  // Check negative FIRST — "לא עובד" must not match positive "עובד"
  if (NEGATIVE_RE.test(trimmed)) return 'negative';
  if (POSITIVE_RE.test(trimmed)) return 'positive';
  return null;
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
    toBeNull() { if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`); },
  };
}

// ---------------------------------------------------------------------------
// Positive signals
// ---------------------------------------------------------------------------
console.log('\n=== Positive Feedback ===');

for (const phrase of ['perfect', 'great', 'excellent', 'works', 'done', 'love it', 'exactly', 'fixed it']) {
  test(`"${phrase}" → positive`, () => expect(detectActionFeedback(phrase, true)).toBe('positive'));
}

test('"Perfect!" with punctuation → positive', () => expect(detectActionFeedback('Perfect!', true)).toBe('positive'));
test('"👍" emoji → positive', () => expect(detectActionFeedback('👍', true)).toBe('positive'));
test('"✅" emoji → positive', () => expect(detectActionFeedback('✅', true)).toBe('positive'));
test('"מעולה" Hebrew → positive', () => expect(detectActionFeedback('מעולה', true)).toBe('positive'));
test('"אחלה" Hebrew → positive', () => expect(detectActionFeedback('אחלה', true)).toBe('positive'));
test('"תותח" Hebrew → positive', () => expect(detectActionFeedback('תותח', true)).toBe('positive'));

// ---------------------------------------------------------------------------
// Negative signals
// ---------------------------------------------------------------------------
console.log('\n=== Negative Feedback ===');

for (const phrase of ['wrong', 'broken', 'useless', 'failed', 'nope', 'garbage']) {
  test(`"${phrase}" → negative`, () => expect(detectActionFeedback(phrase, true)).toBe('negative'));
}

test('"not what" → negative', () => expect(detectActionFeedback('not what', true)).toBe('negative'));
test('"👎" emoji → negative', () => expect(detectActionFeedback('👎', true)).toBe('negative'));
test('"❌" emoji → negative', () => expect(detectActionFeedback('❌', true)).toBe('negative'));
test('"לא עובד" Hebrew → negative', () => expect(detectActionFeedback('לא עובד', true)).toBe('negative'));

// ---------------------------------------------------------------------------
// No signal (should return null)
// ---------------------------------------------------------------------------
console.log('\n=== No Signal ===');

test('neutral text → null', () => expect(detectActionFeedback('what time is it?', true)).toBeNull());
test('long text (>50 chars) → null', () => {
  expect(detectActionFeedback('This is a really long message that goes way beyond fifty characters and should be ignored', true)).toBeNull();
});
test('no prevTurnWasAction → null', () => expect(detectActionFeedback('perfect', false)).toBeNull());
test('empty text → null', () => expect(detectActionFeedback('', true)).toBeNull());
test('null text → null', () => expect(detectActionFeedback(null, true)).toBeNull());
test('"ok" → null (ack, not feedback)', () => expect(detectActionFeedback('ok', true)).toBeNull());
test('"thanks" → null (ack, not feedback)', () => expect(detectActionFeedback('thanks', true)).toBeNull());

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
