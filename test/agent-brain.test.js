/**
 * Tests for agent-brain.js pure logic — run with: node test/agent-brain.test.js
 *
 * Tests pattern management, confidence scoring, decay, rate limiting,
 * and proposal response detection. Functions extracted to avoid heavy imports.
 */

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
    toBeNull() { if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`); },
  };
}

// ---------------------------------------------------------------------------
// Extracted constants (from agent-brain.js lines 37-49)
// ---------------------------------------------------------------------------

const THRESHOLDS = { AUTO_EXECUTE: 0.9, PROPOSE: 0.7, SUGGEST: 0.5, MIN_OBSERVE: 0.3 };
const MAX_PROPOSALS_PER_DAY = 4;
const MIN_HOURS_BETWEEN_SAME_TOPIC = 2;
const REJECTION_COOLDOWN_DAYS = 3;
const CONFIDENCE_DECAY_PER_WEEK = 0.05;
const REJECTION_PENALTY = 0.15;
const MAX_PATTERNS = 100;

// ---------------------------------------------------------------------------
// Extracted functions (from agent-brain.js)
// ---------------------------------------------------------------------------

function findPattern(patterns, type, key) {
  return patterns.find(p => p.type === type && p.key === key);
}

function upsertPattern(patterns, { type, key, description, confidence, proposedAction }) {
  let existing = findPattern(patterns, type, key);
  if (existing) {
    existing.occurrences++;
    existing.lastSeen = Date.now();
    existing.confidence = Math.min(0.95, existing.confidence + 0.05);
    if (description) existing.description = description;
    if (proposedAction) existing.proposedAction = proposedAction;
  } else {
    existing = {
      type, key, description,
      confidence: confidence || 0.4,
      firstSeen: Date.now(), lastSeen: Date.now(),
      occurrences: 1, proposedAction,
      status: 'observed', userFeedback: null, feedbackAt: null,
    };
    patterns.push(existing);
  }
  return existing;
}

function decayPatterns(patterns) {
  const now = Date.now();
  const weekMs = 7 * 24 * 3600_000;
  for (let i = patterns.length - 1; i >= 0; i--) {
    const p = patterns[i];
    const weeksSinceLastSeen = (now - p.lastSeen) / weekMs;
    if (weeksSinceLastSeen > 1) {
      p.confidence -= CONFIDENCE_DECAY_PER_WEEK * Math.floor(weeksSinceLastSeen);
      if (p.confidence < 0.1) patterns.splice(i, 1);
    }
  }
}

// Simplified canPropose (without getState dependency)
function canPropose(pattern, todayCount, lastProposalTs) {
  if (todayCount >= MAX_PROPOSALS_PER_DAY) return false;
  if (lastProposalTs && (Date.now() - lastProposalTs) < MIN_HOURS_BETWEEN_SAME_TOPIC * 3600_000) return false;
  if (pattern.userFeedback === 'rejected' && pattern.feedbackAt) {
    if (Date.now() - pattern.feedbackAt < REJECTION_COOLDOWN_DAYS * 24 * 3600_000) return false;
  }
  return true;
}

function addProposal(proposals, pattern, message) {
  const proposal = {
    id: `prop_${Date.now().toString(36)}`,
    patternKey: pattern.key, patternType: pattern.type,
    message, confidence: pattern.confidence,
    status: 'pending', createdAt: Date.now(),
    respondedAt: null, response: null,
  };
  proposals.push(proposal);
  return proposal;
}

// Extracted response detection regexes
const APPROVE = /^(do it|yes|sure|go ahead|approve|ok|yeah|yep|כן|יאללה|סבבה|תעשה|עשה|בוא)/i;
const REJECT = /^(no|skip|don't|nope|nah|pass|dismiss|לא|עזוב|דלג|תשכח|לא צריך)/i;
const SNOOZE = /^(later|not now|remind|snooze|אח.?כ|לא עכשיו|תזכיר|מאוחר)/i;

function detectResponse(text) {
  const t = text.trim().toLowerCase();
  // Check SNOOZE before REJECT — "not now" / "לא עכשיו" must not match "no" / "לא"
  if (SNOOZE.test(t)) return 'snoozed';
  if (APPROVE.test(t)) return 'approved';
  if (REJECT.test(t)) return 'rejected';
  return null;
}

// ---------------------------------------------------------------------------
// upsertPattern tests
// ---------------------------------------------------------------------------
console.log('\n=== upsertPattern ===');

test('creates new pattern with defaults', () => {
  const patterns = [];
  const p = upsertPattern(patterns, { type: 'cron_failing', key: 'test_1', description: 'test' });
  expect(patterns.length).toBe(1);
  expect(p.confidence).toBe(0.4);
  expect(p.occurrences).toBe(1);
  expect(p.status).toBe('observed');
});

test('creates pattern with custom confidence', () => {
  const patterns = [];
  const p = upsertPattern(patterns, { type: 'metric', key: 'cost_spike', confidence: 0.85 });
  expect(p.confidence).toBe(0.85);
});

test('re-observation increases confidence by 0.05', () => {
  const patterns = [];
  upsertPattern(patterns, { type: 'test', key: 'k1', confidence: 0.5 });
  upsertPattern(patterns, { type: 'test', key: 'k1' });
  expect(patterns[0].confidence).toBe(0.55);
  expect(patterns[0].occurrences).toBe(2);
});

test('confidence capped at 0.95', () => {
  const patterns = [];
  upsertPattern(patterns, { type: 'test', key: 'k1', confidence: 0.93 });
  upsertPattern(patterns, { type: 'test', key: 'k1' }); // +0.05 → 0.98 → capped at 0.95
  expect(patterns[0].confidence).toBe(0.95);
});

test('updates description on re-observation', () => {
  const patterns = [];
  upsertPattern(patterns, { type: 'test', key: 'k1', description: 'old' });
  upsertPattern(patterns, { type: 'test', key: 'k1', description: 'new' });
  expect(patterns[0].description).toBe('new');
});

test('does not duplicate patterns', () => {
  const patterns = [];
  upsertPattern(patterns, { type: 'a', key: 'b' });
  upsertPattern(patterns, { type: 'a', key: 'b' });
  upsertPattern(patterns, { type: 'a', key: 'b' });
  expect(patterns.length).toBe(1);
  expect(patterns[0].occurrences).toBe(3);
});

test('different type+key creates separate patterns', () => {
  const patterns = [];
  upsertPattern(patterns, { type: 'a', key: 'k1' });
  upsertPattern(patterns, { type: 'b', key: 'k1' });
  upsertPattern(patterns, { type: 'a', key: 'k2' });
  expect(patterns.length).toBe(3);
});

// ---------------------------------------------------------------------------
// decayPatterns tests
// ---------------------------------------------------------------------------
console.log('\n=== decayPatterns ===');

test('no decay within first week', () => {
  const patterns = [{ type: 'x', key: 'y', confidence: 0.7, lastSeen: Date.now() - 5 * 24 * 3600_000 }];
  decayPatterns(patterns);
  expect(patterns[0].confidence).toBe(0.7);
});

test('decays by 0.05 per week after 1 week', () => {
  const patterns = [{ type: 'x', key: 'y', confidence: 0.7, lastSeen: Date.now() - 2 * 7 * 24 * 3600_000 }];
  decayPatterns(patterns);
  expect(patterns[0].confidence).toBe(0.6); // 0.7 - 2*0.05
});

test('removes pattern when confidence drops below 0.1', () => {
  const patterns = [{ type: 'x', key: 'y', confidence: 0.2, lastSeen: Date.now() - 4 * 7 * 24 * 3600_000 }];
  decayPatterns(patterns);
  expect(patterns.length).toBe(0); // 0.2 - 4*0.05 = 0.0 < 0.1
});

test('preserves recently seen patterns', () => {
  const now = Date.now();
  const patterns = [
    { type: 'a', key: '1', confidence: 0.5, lastSeen: now },           // fresh
    { type: 'b', key: '2', confidence: 0.3, lastSeen: now - 10 * 7 * 24 * 3600_000 }, // very old, will die
  ];
  decayPatterns(patterns);
  expect(patterns.length).toBe(1);
  expect(patterns[0].key).toBe('1');
});

// ---------------------------------------------------------------------------
// canPropose tests
// ---------------------------------------------------------------------------
console.log('\n=== canPropose ===');

test('allows proposal when under daily limit', () => {
  const pattern = { key: 'test', userFeedback: null, feedbackAt: null };
  expect(canPropose(pattern, 0, null)).toBe(true);
});

test('blocks when daily limit reached', () => {
  const pattern = { key: 'test', userFeedback: null, feedbackAt: null };
  expect(canPropose(pattern, MAX_PROPOSALS_PER_DAY, null)).toBe(false);
});

test('blocks when same topic proposed too recently', () => {
  const pattern = { key: 'test', userFeedback: null, feedbackAt: null };
  expect(canPropose(pattern, 0, Date.now() - 30 * 60_000)).toBe(false); // 30 min ago
});

test('allows when same topic cooldown expired', () => {
  const pattern = { key: 'test', userFeedback: null, feedbackAt: null };
  expect(canPropose(pattern, 0, Date.now() - 3 * 3600_000)).toBe(true); // 3 hours ago
});

test('blocks recently rejected pattern', () => {
  const pattern = { key: 'test', userFeedback: 'rejected', feedbackAt: Date.now() - 1 * 24 * 3600_000 };
  expect(canPropose(pattern, 0, null)).toBe(false); // 1 day ago, cooldown is 3 days
});

test('allows rejected pattern after cooldown', () => {
  const pattern = { key: 'test', userFeedback: 'rejected', feedbackAt: Date.now() - 4 * 24 * 3600_000 };
  expect(canPropose(pattern, 0, null)).toBe(true); // 4 days ago, cooldown is 3 days
});

// ---------------------------------------------------------------------------
// addProposal tests
// ---------------------------------------------------------------------------
console.log('\n=== addProposal ===');

test('creates proposal with correct fields', () => {
  const proposals = [];
  const pattern = { type: 'cron_failing', key: 'test_cron', confidence: 0.85 };
  const p = addProposal(proposals, pattern, 'Cron is failing repeatedly');
  expect(p.status).toBe('pending');
  expect(p.confidence).toBe(0.85);
  expect(p.patternKey).toBe('test_cron');
  expect(proposals.length).toBe(1);
});

// ---------------------------------------------------------------------------
// detectResponse tests
// ---------------------------------------------------------------------------
console.log('\n=== Proposal Response Detection ===');

// Approve
for (const phrase of ['do it', 'yes', 'sure', 'go ahead', 'approve', 'ok', 'yeah', 'yep']) {
  test(`"${phrase}" → approved`, () => expect(detectResponse(phrase)).toBe('approved'));
}
test('"כן" → approved (Hebrew)', () => expect(detectResponse('כן')).toBe('approved'));
test('"יאללה" → approved (Hebrew)', () => expect(detectResponse('יאללה')).toBe('approved'));
test('"סבבה" → approved (Hebrew)', () => expect(detectResponse('סבבה')).toBe('approved'));

// Reject
for (const phrase of ['no', 'skip', "don't", 'nope', 'nah', 'pass', 'dismiss']) {
  test(`"${phrase}" → rejected`, () => expect(detectResponse(phrase)).toBe('rejected'));
}
test('"לא" → rejected (Hebrew)', () => expect(detectResponse('לא')).toBe('rejected'));
test('"עזוב" → rejected (Hebrew)', () => expect(detectResponse('עזוב')).toBe('rejected'));

// Snooze
for (const phrase of ['later', 'not now', 'snooze']) {
  test(`"${phrase}" → snoozed`, () => expect(detectResponse(phrase)).toBe('snoozed'));
}
test('"לא עכשיו" → snoozed (Hebrew)', () => expect(detectResponse('לא עכשיו')).toBe('snoozed'));

// No match
test('"how are you?" → null', () => expect(detectResponse('how are you?')).toBeNull());
test('"tell me more" → null', () => expect(detectResponse('tell me more')).toBeNull());

// ---------------------------------------------------------------------------
// Threshold validation
// ---------------------------------------------------------------------------
console.log('\n=== Threshold Logic ===');

test('AUTO_EXECUTE > PROPOSE > SUGGEST > MIN_OBSERVE', () => {
  expect(THRESHOLDS.AUTO_EXECUTE > THRESHOLDS.PROPOSE).toBeTruthy();
  expect(THRESHOLDS.PROPOSE > THRESHOLDS.SUGGEST).toBeTruthy();
  expect(THRESHOLDS.SUGGEST > THRESHOLDS.MIN_OBSERVE).toBeTruthy();
});

test('new pattern (0.4) is above MIN_OBSERVE', () => {
  expect(0.4 > THRESHOLDS.MIN_OBSERVE).toBeTruthy();
});

test('new pattern (0.4) is below SUGGEST', () => {
  expect(0.4 < THRESHOLDS.SUGGEST).toBeTruthy();
});

test('3 observations brings pattern to SUGGEST level', () => {
  const patterns = [];
  upsertPattern(patterns, { type: 't', key: 'k', confidence: 0.4 });
  upsertPattern(patterns, { type: 't', key: 'k' }); // 0.45
  upsertPattern(patterns, { type: 't', key: 'k' }); // 0.50
  expect(patterns[0].confidence >= THRESHOLDS.SUGGEST).toBeTruthy();
});

test('7 observations brings pattern to PROPOSE level', () => {
  const patterns = [];
  upsertPattern(patterns, { type: 't', key: 'k', confidence: 0.4 });
  for (let i = 0; i < 6; i++) upsertPattern(patterns, { type: 't', key: 'k' });
  // 0.4 + 6*0.05 = 0.70
  expect(patterns[0].confidence >= THRESHOLDS.PROPOSE).toBeTruthy();
});

test('rejection drops confidence by 0.15', () => {
  const conf = 0.8;
  const after = Math.max(0.1, conf - REJECTION_PENALTY);
  expect(after).toBe(0.65);
});

test('rejection penalty capped at 0.1 minimum', () => {
  const conf = 0.2;
  const after = Math.max(0.1, conf - REJECTION_PENALTY);
  expect(after).toBe(0.1);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
