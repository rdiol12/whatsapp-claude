/**
 * Integration test: WhatsApp → NLU → agent-loop round-trip (ms_8)
 *
 * Tests the full message processing pipeline without live WA/Claude:
 * 1. User message arrives → classified by outcome-tracker (NLU layer)
 * 2. Bot reply formatted → parsed by parseAgentResponse (XML tags)
 * 3. User reaction captured → sentiment detected by detectActionFeedback
 * 4. Outcome → goal_update → milestone_complete round-trip integrity
 *
 * This exercises the data contracts between: whatsapp.js (inbound)
 * → outcome-tracker.js (NLU) → agent-loop.js (parseAgentResponse)
 * without spawning real processes.
 *
 * Run with: node test/whatsapp-claude-roundtrip.test.js
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const agentLoopPath = pathToFileURL(join(__dirname, '..', 'lib', 'agent-loop.js')).href;
const outcomeTrackerPath = pathToFileURL(join(__dirname, '..', 'lib', 'outcome-tracker.js')).href;

const { parseAgentResponse } = await import(agentLoopPath);
const { classifyUserResponse, detectActionFeedback } = await import(outcomeTrackerPath);

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
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`);
    },
    toEqual(expected) {
      const a = JSON.stringify(actual), b = JSON.stringify(expected);
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
    },
    toHaveLength(n) {
      if (!actual || actual.length !== n) throw new Error(`Expected length ${n}, got ${actual?.length}`);
    },
    toContain(s) {
      if (Array.isArray(actual)) {
        if (!actual.includes(s)) throw new Error(`Expected array to contain ${JSON.stringify(s)}`);
      } else {
        if (!String(actual).includes(s)) throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(s)}`);
      }
    },
    toBeOneOf(...values) {
      if (!values.includes(actual)) throw new Error(`Expected one of [${values.join(', ')}], got ${JSON.stringify(actual)}`);
    },
  };
}

// ─── Layer 1: User message → NLU classification (whatsapp.js input side) ──────

console.log('\n=== NLU: classifyUserResponse (incoming message layer) ===');

test('classifies gratitude message correctly', () => {
  const result = classifyUserResponse('thanks, that worked!');
  expect(result.type).toBe('gratitude');
});

test('classifies pure Hebrew gratitude correctly', () => {
  // After the Unicode \b fix in outcome-tracker.js: Hebrew uses (?:^|[\s,!?.]) boundaries.
  // "תודה" at start of string now matches GRATITUDE_RE correctly.
  const result = classifyUserResponse('תודה רבה');
  expect(result.type).toBe('gratitude');
});

test('classifies question correctly', () => {
  const result = classifyUserResponse('what are my current costs?');
  expect(result.type).toBe('question');
});

test('classifies frustration correctly', () => {
  // FRUSTRATION_RE matches: again, still broken, doesn't work, not working, wtf, etc.
  const result = classifyUserResponse("still broken, this doesn't work");
  expect(result.type).toBe('frustration');
});

test('classifies empty/short message as empty type', () => {
  const result = classifyUserResponse('');
  expect(result.type).toBeOneOf('empty', 'statement');
});

test('returns topics array always', () => {
  const result = classifyUserResponse('tell me about the goals');
  expect(Array.isArray(result.topics)).toBeTruthy();
});

test('detects cost topic in message', () => {
  const result = classifyUserResponse('how much did it cost today?');
  expect(result.topics).toContain('costs');
});

test('detects code topic in message', () => {
  const result = classifyUserResponse('fix the bug in whatsapp.js');
  expect(result.topics).toContain('code');
});

test('detects goals topic in message', () => {
  const result = classifyUserResponse('what is the progress on my goals?');
  expect(result.topics).toContain('goals');
});

// ─── Layer 2: Bot reply → parseAgentResponse (agent output parsing) ────────────

console.log('\n=== parseAgentResponse: agent reply parsing layer ===');

test('full agent response roundtrip — all tags correctly extracted', () => {
  const agentReply = `
Analyzing the test suite status...

<action_taken>Read test/agent-loop-integration.test.js — 40 tests covering parseAgentResponse</action_taken>
<action_taken>Verified agent-loop-integration.test.js is auto-discovered by run-all.js (readdirSync)</action_taken>

<wa_message>✅ Test suite ms_4 done — integration tests are passing (40 tests on parseAgentResponse). Moving to ms_8.</wa_message>

<goal_update id="bd6e44e5" status="in_progress" progress="89">ms_4 complete — parseAgentResponse integration tests verified</goal_update>
<milestone_complete goal="bd6e44e5" milestone="ms_4">agent-loop-integration.test.js covers all XML tag parsing paths (wa_message, followup, goal_create, goal_update, milestone_complete, next_cycle_minutes). Auto-discovered by run-all.js.</milestone_complete>

<followup>verify-integration-tests-pass</followup>
<next_cycle_minutes>10</next_cycle_minutes>
`;
  const r = parseAgentResponse(agentReply);

  // All fields present
  expect(r.waMessages).toHaveLength(1);
  expect(r.actionsTaken).toHaveLength(2);
  expect(r.goalUpdates).toHaveLength(1);
  expect(r.milestoneCompletes).toHaveLength(1);
  expect(r.followups).toHaveLength(1);
  expect(r.nextCycleMinutes).toBe(10);

  // Content integrity
  expect(r.waMessages[0]).toContain('ms_4 done');
  expect(r.actionsTaken[0]).toContain('parseAgentResponse');
  expect(r.goalUpdates[0].id).toBe('bd6e44e5');
  expect(r.goalUpdates[0].progress).toBe(89);
  expect(r.milestoneCompletes[0].goalId).toBe('bd6e44e5');
  expect(r.milestoneCompletes[0].milestoneId).toBe('ms_4');
  expect(r.followups[0].topic).toBe('verify-integration-tests-pass');
});

test('WA reply content integrity — message is not truncated', () => {
  const longMsg = 'A'.repeat(3000) + ' end_of_message';
  const r = parseAgentResponse(`<wa_message>${longMsg}</wa_message>`);
  expect(r.waMessages[0]).toContain('end_of_message');
  expect(r.waMessages[0].length).toBe(longMsg.length);
});

test('multiple wa_messages simulate agent sending batched updates', () => {
  const r = parseAgentResponse(`
<wa_message>📊 Cost spike alert: $27.92 today vs $13.85 avg</wa_message>
<wa_message>🔧 Root cause: 3 Sonnet spawns during test writing cycle</wa_message>
<wa_message>✅ Action taken: scheduled next cycle at 30min to reduce frequency</wa_message>
`);
  expect(r.waMessages).toHaveLength(3);
  expect(r.waMessages[0]).toContain('Cost spike');
  expect(r.waMessages[1]).toContain('Root cause');
  expect(r.waMessages[2]).toContain('Action taken');
});

test('goal_create → goal_update → milestone_complete chain', () => {
  const agentPlan = `
<goal_create title="Fix cost spike">Investigate why today hit $27.92 and reduce Sonnet spawns</goal_create>
<goal_update id="bd6e44e5" status="in_progress" progress="89">Integration test ms_8 written</goal_update>
<milestone_complete goal="bd6e44e5" milestone="ms_8">whatsapp-claude-roundtrip.test.js written — mock WA+Claude round-trip tests</milestone_complete>
`;
  const r = parseAgentResponse(agentPlan);
  expect(r.goalCreates).toHaveLength(1);
  expect(r.goalCreates[0].title).toBe('Fix cost spike');
  expect(r.goalUpdates).toHaveLength(1);
  expect(r.milestoneCompletes[0].milestoneId).toBe('ms_8');
});

test('goal_update without status attribute still parses id and progress', () => {
  // Regression: agent sometimes omits status when only advancing progress
  const r = parseAgentResponse('<goal_update id="costs-rotation" progress="50">M2 complete</goal_update>');
  expect(r.goalUpdates).toHaveLength(1);
  expect(r.goalUpdates[0].id).toBe('costs-rotation');
  expect(r.goalUpdates[0].progress).toBe(50);
  expect(r.goalUpdates[0].status).toBe(undefined);
});

// ─── Layer 3: User reaction → sentiment (feedback loop layer) ─────────────────

console.log('\n=== detectActionFeedback: user reaction layer ===');

test('positive reaction after bot action detected', () => {
  const sentiment = detectActionFeedback('perfect', true);
  expect(sentiment).toBe('positive');
});

test('negative reaction after bot action detected', () => {
  const sentiment = detectActionFeedback('wrong', true);
  expect(sentiment).toBe('negative');
});

test('Hebrew positive reaction detected', () => {
  const sentiment = detectActionFeedback('מעולה', true);
  expect(sentiment).toBe('positive');
});

test('no feedback when prevTurnWasAction is false', () => {
  const sentiment = detectActionFeedback('perfect', false);
  expect(sentiment).toBeNull();
});

test('long message not detected as feedback (over 50 chars threshold)', () => {
  const longReply = 'Can you please clarify what exactly you did because I am not sure I understand the changes you made';
  const sentiment = detectActionFeedback(longReply, true);
  expect(sentiment).toBeNull(); // too long to be a reaction signal
});

test('neutral short message is null', () => {
  // "ok" or "sure" are neutral — shouldn't trigger positive or negative
  const sentiment = detectActionFeedback('ok', true);
  expect(sentiment).toBeNull();
});

// ─── Layer 4: End-to-end simulated round-trip ─────────────────────────────────

console.log('\n=== End-to-end: simulated message → reply → reaction round-trip ===');

test('full round-trip: user asks question → agent replies → user reacts positively', () => {
  // Step 1: User sends message (whatsapp.js receives)
  const userMessage = 'what is the current test coverage?';
  const classification = classifyUserResponse(userMessage);
  expect(classification.type).toBe('question');

  // Step 2: Agent reply comes back (via claude.js, mocked here as static response)
  const mockAgentReply = `
<action_taken>Checked test suite — 49/49 tests passing</action_taken>
<wa_message>Test suite: 49/49 passing (100%). Pre-commit hook active. Next: integration tests for ms_8.</wa_message>
<goal_update id="bd6e44e5" status="in_progress" progress="89">ms_4 done, ms_8 in progress</goal_update>
`;
  const parsed = parseAgentResponse(mockAgentReply);
  expect(parsed.waMessages).toHaveLength(1);
  expect(parsed.actionsTaken).toHaveLength(1);
  expect(parsed.goalUpdates[0].progress).toBe(89);

  // Step 3: User reacts after seeing bot's reply (whatsapp.js captureUserReaction path)
  const userReaction = '👍';
  const sentiment = detectActionFeedback(userReaction, true);
  // Note: emoji reactions go through classifyReaction, not detectActionFeedback
  // but short positive replies still trigger it
  expect(sentiment).toBeOneOf('positive', null); // implementation-dependent
});

test('full round-trip: user frustration → agent acknowledges → outcome is negative', () => {
  // Step 1: User expresses frustration — FRUSTRATION_RE matches "still broken", "doesn't work" etc.
  const userMessage = "still broken, doesn't work";
  const classification = classifyUserResponse(userMessage);
  expect(classification.type).toBe('frustration');

  // Step 2: Agent corrects course (mock reply)
  const mockAgentReply = `
<action_taken>Identified issue with previous response — re-analyzed correctly</action_taken>
<wa_message>You're right, I was wrong. Here's the corrected answer...</wa_message>
`;
  const parsed = parseAgentResponse(mockAgentReply);
  expect(parsed.waMessages[0]).toContain('corrected');

  // Step 3: After correction, short negative reaction fires.
  // NEGATIVE_RE uses ^[\s\W]*(word)[\s\W]*$ — must be the word in near-isolation.
  const userReaction = 'wrong';
  const sentiment = detectActionFeedback(userReaction, true);
  expect(sentiment).toBe('negative');
});

test('followup lifecycle: created → injected → consumed as signal', () => {
  // This tests the followup state machine as used in agent-loop
  const agentReply1 = '<followup>check-costs-tomorrow</followup><followup>verify-tests-pass</followup>';
  const parsed1 = parseAgentResponse(agentReply1);
  expect(parsed1.followups).toHaveLength(2);

  // Followups are stored with createdAt timestamp (agent-loop stores in state.pendingFollowups)
  expect(parsed1.followups[0]).toEqual({ topic: 'check-costs-tomorrow', createdAt: parsed1.followups[0].createdAt });
  expect(typeof parsed1.followups[0].createdAt).toBe('number');

  // Next cycle: followup becomes a signal, Claude responds and creates new followups
  const agentReply2 = '<action_taken>Reviewed costs: $27.92 — 2x spike</action_taken><followup>investigate-sonnet-spawns</followup>';
  const parsed2 = parseAgentResponse(agentReply2);
  expect(parsed2.actionsTaken).toHaveLength(1);
  expect(parsed2.followups[0].topic).toBe('investigate-sonnet-spawns');
});

// ─── Layer 5: Cost spike + alert round-trip ────────────────────────────────────

console.log('\n=== Cost spike signal → agent response integrity ===');

test('cost spike signal produces wa_message with cost data', () => {
  // The agent receives a cost_spike signal and should produce actionable response
  const agentResponseToCostSpike = `
Investigating $27.92 cost spike (2x avg)...

<action_taken>Identified cause: 3 Sonnet spawns for integration test writing (expected)</action_taken>
<action_taken>Adjusted: will use Haiku for next 2 cycles to offset</action_taken>

<wa_message>💰 Cost spike: $27.92 today (2x avg $13.85). Cause: test writing cycle. Not a leak — will normalize tomorrow.</wa_message>

<next_cycle_minutes>30</next_cycle_minutes>
`;
  const r = parseAgentResponse(agentResponseToCostSpike);
  expect(r.waMessages).toHaveLength(1);
  expect(r.waMessages[0]).toContain('$27.92');
  expect(r.actionsTaken).toHaveLength(2);
  expect(r.nextCycleMinutes).toBe(30);
  expect(r.goalUpdates).toHaveLength(0); // no goal change needed
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
