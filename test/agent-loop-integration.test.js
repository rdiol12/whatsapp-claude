/**
 * Integration tests for lib/agent-loop.js — parseAgentResponse
 *
 * Tests the XML parsing pipeline that converts Claude's raw response
 * into structured actions: wa_message, followup, goal_update,
 * goal_create, milestone_complete, next_cycle_minutes, action_taken.
 *
 * This is the core of the "message → Claude → action" integration path.
 * Run with: node test/agent-loop-integration.test.js
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'agent-loop.js')).href;
const { parseAgentResponse } = await import(modPath);

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
    toBeGreaterThanOrEqual(n) {
      if (actual < n) throw new Error(`Expected >= ${n}, got ${actual}`);
    },
  };
}

// ─── parseAgentResponse is exported ──────────────────────────────────────────

console.log('\n=== parseAgentResponse export ===');

test('parseAgentResponse is a function', () => {
  expect(typeof parseAgentResponse).toBe('function');
});

test('returns object with expected keys on empty input', () => {
  const r = parseAgentResponse('');
  expect(typeof r).toBe('object');
  expect(Array.isArray(r.waMessages)).toBeTruthy();
  expect(Array.isArray(r.followups)).toBeTruthy();
  expect(Array.isArray(r.actionsTaken)).toBeTruthy();
  expect(Array.isArray(r.goalCreates)).toBeTruthy();
  expect(Array.isArray(r.goalUpdates)).toBeTruthy();
  expect(Array.isArray(r.milestoneCompletes)).toBeTruthy();
});

// ─── wa_message parsing ───────────────────────────────────────────────────────

console.log('\n=== wa_message parsing ===');

test('extracts single wa_message', () => {
  const r = parseAgentResponse('<wa_message>Hello!</wa_message>');
  expect(r.waMessages).toHaveLength(1);
  expect(r.waMessages[0]).toBe('Hello!');
});

test('extracts multiple wa_messages', () => {
  const r = parseAgentResponse('<wa_message>First message</wa_message>\n<wa_message>Second message</wa_message>');
  expect(r.waMessages).toHaveLength(2);
  expect(r.waMessages[0]).toBe('First message');
  expect(r.waMessages[1]).toBe('Second message');
});

test('trims whitespace from wa_message', () => {
  const r = parseAgentResponse('<wa_message>  \n  Trimmed  \n  </wa_message>');
  expect(r.waMessages[0]).toBe('Trimmed');
});

test('ignores empty wa_message blocks', () => {
  const r = parseAgentResponse('<wa_message>   </wa_message>');
  expect(r.waMessages).toHaveLength(0);
});

test('wa_message supports multi-line content', () => {
  const multiline = 'Line 1\nLine 2\nLine 3';
  const r = parseAgentResponse(`<wa_message>${multiline}</wa_message>`);
  expect(r.waMessages).toHaveLength(1);
  expect(r.waMessages[0]).toContain('Line 2');
});

test('no wa_message → empty array', () => {
  const r = parseAgentResponse('Just some text without XML tags');
  expect(r.waMessages).toHaveLength(0);
});

// ─── followup parsing ─────────────────────────────────────────────────────────

console.log('\n=== followup parsing ===');

test('extracts single followup', () => {
  const r = parseAgentResponse('<followup>check costs tomorrow</followup>');
  expect(r.followups).toHaveLength(1);
  expect(r.followups[0].topic).toBe('check costs tomorrow');
});

test('followup has createdAt timestamp', () => {
  const before = Date.now();
  const r = parseAgentResponse('<followup>test topic</followup>');
  const after = Date.now();
  expect(r.followups[0].createdAt).toBeGreaterThanOrEqual(before);
  expect(r.followups[0].createdAt).toBeGreaterThanOrEqual(0);
});

test('extracts multiple followups', () => {
  const r = parseAgentResponse('<followup>topic-one</followup><followup>topic-two</followup><followup>topic-three</followup>');
  expect(r.followups).toHaveLength(3);
  expect(r.followups[1].topic).toBe('topic-two');
});

test('ignores empty followup blocks', () => {
  const r = parseAgentResponse('<followup>  </followup>');
  expect(r.followups).toHaveLength(0);
});

// ─── next_cycle_minutes parsing ───────────────────────────────────────────────

console.log('\n=== next_cycle_minutes parsing ===');

test('extracts valid next_cycle_minutes', () => {
  const r = parseAgentResponse('<next_cycle_minutes>30</next_cycle_minutes>');
  expect(r.nextCycleMinutes).toBe(30);
});

test('next_cycle_minutes at minimum boundary (5)', () => {
  const r = parseAgentResponse('<next_cycle_minutes>5</next_cycle_minutes>');
  expect(r.nextCycleMinutes).toBe(5);
});

test('next_cycle_minutes at maximum boundary (120)', () => {
  const r = parseAgentResponse('<next_cycle_minutes>120</next_cycle_minutes>');
  expect(r.nextCycleMinutes).toBe(120);
});

test('next_cycle_minutes below minimum (4) → null', () => {
  const r = parseAgentResponse('<next_cycle_minutes>4</next_cycle_minutes>');
  expect(r.nextCycleMinutes).toBeNull();
});

test('next_cycle_minutes above maximum (121) → null', () => {
  const r = parseAgentResponse('<next_cycle_minutes>121</next_cycle_minutes>');
  expect(r.nextCycleMinutes).toBeNull();
});

test('no next_cycle_minutes → null', () => {
  const r = parseAgentResponse('No timing override here');
  expect(r.nextCycleMinutes).toBeNull();
});

// ─── action_taken parsing ─────────────────────────────────────────────────────

console.log('\n=== action_taken parsing ===');

test('extracts single action_taken', () => {
  const r = parseAgentResponse('<action_taken>Updated goals.json with new milestone</action_taken>');
  expect(r.actionsTaken).toHaveLength(1);
  expect(r.actionsTaken[0]).toBe('Updated goals.json with new milestone');
});

test('extracts multiple action_taken tags', () => {
  const r = parseAgentResponse('<action_taken>Action A</action_taken><action_taken>Action B</action_taken>');
  expect(r.actionsTaken).toHaveLength(2);
});

test('ignores empty action_taken blocks', () => {
  const r = parseAgentResponse('<action_taken></action_taken>');
  expect(r.actionsTaken).toHaveLength(0);
});

// ─── goal_create parsing ──────────────────────────────────────────────────────

console.log('\n=== goal_create parsing ===');

test('extracts goal_create with title and description', () => {
  const r = parseAgentResponse('<goal_create title="Add dark mode">Implement dark mode toggle for the UI</goal_create>');
  expect(r.goalCreates).toHaveLength(1);
  expect(r.goalCreates[0].title).toBe('Add dark mode');
  expect(r.goalCreates[0].description).toBe('Implement dark mode toggle for the UI');
});

test('goal_create with empty description', () => {
  const r = parseAgentResponse('<goal_create title="New goal"></goal_create>');
  expect(r.goalCreates).toHaveLength(1);
  expect(r.goalCreates[0].title).toBe('New goal');
});

test('goal_create without title → not added', () => {
  const r = parseAgentResponse('<goal_create>No title here</goal_create>');
  expect(r.goalCreates).toHaveLength(0);
});

// ─── goal_update parsing ──────────────────────────────────────────────────────

console.log('\n=== goal_update parsing ===');

test('extracts goal_update with id, status, progress', () => {
  const r = parseAgentResponse('<goal_update id="goal-abc" status="in_progress" progress="50">Working on it</goal_update>');
  expect(r.goalUpdates).toHaveLength(1);
  const u = r.goalUpdates[0];
  expect(u.id).toBe('goal-abc');
  expect(u.status).toBe('in_progress');
  expect(u.progress).toBe(50);
  expect(u.note).toBe('Working on it');
});

test('goal_update attributes can appear in any order', () => {
  const r = parseAgentResponse('<goal_update progress="75" id="goal-xyz" status="completed">Done!</goal_update>');
  expect(r.goalUpdates).toHaveLength(1);
  expect(r.goalUpdates[0].id).toBe('goal-xyz');
  expect(r.goalUpdates[0].progress).toBe(75);
});

test('goal_update without id → not added', () => {
  const r = parseAgentResponse('<goal_update status="done">No ID here</goal_update>');
  expect(r.goalUpdates).toHaveLength(0);
});

test('goal_update without status → update still included', () => {
  const r = parseAgentResponse('<goal_update id="goal-1" progress="25">Partial update</goal_update>');
  expect(r.goalUpdates).toHaveLength(1);
  expect(r.goalUpdates[0].id).toBe('goal-1');
  expect(r.goalUpdates[0].status).toBe(undefined);
  expect(r.goalUpdates[0].progress).toBe(25);
});

test('multiple goal_updates', () => {
  const r = parseAgentResponse(
    '<goal_update id="g1" status="completed" progress="100">Done</goal_update>' +
    '<goal_update id="g2" status="in_progress" progress="50">Ongoing</goal_update>'
  );
  expect(r.goalUpdates).toHaveLength(2);
  expect(r.goalUpdates[0].id).toBe('g1');
  expect(r.goalUpdates[1].id).toBe('g2');
});

// ─── milestone_complete parsing ───────────────────────────────────────────────

console.log('\n=== milestone_complete parsing ===');

test('extracts milestone_complete with goal and milestone', () => {
  const r = parseAgentResponse('<milestone_complete goal="goal-abc" milestone="ms_1">Done — confirmed in db.js</milestone_complete>');
  expect(r.milestoneCompletes).toHaveLength(1);
  const m = r.milestoneCompletes[0];
  expect(m.goalId).toBe('goal-abc');
  expect(m.milestoneId).toBe('ms_1');
  expect(m.evidence).toBe('Done — confirmed in db.js');
});

test('milestone_complete attributes can appear in any order', () => {
  const r = parseAgentResponse('<milestone_complete milestone="ms_2" goal="goal-xyz">Evidence here</milestone_complete>');
  expect(r.milestoneCompletes).toHaveLength(1);
  expect(r.milestoneCompletes[0].goalId).toBe('goal-xyz');
  expect(r.milestoneCompletes[0].milestoneId).toBe('ms_2');
});

test('milestone_complete without goal → not added', () => {
  const r = parseAgentResponse('<milestone_complete milestone="ms_1">No goal attr</milestone_complete>');
  expect(r.milestoneCompletes).toHaveLength(0);
});

test('milestone_complete without milestone → milestoneId is empty string', () => {
  const r = parseAgentResponse('<milestone_complete goal="goal-1">No milestone attr</milestone_complete>');
  expect(r.milestoneCompletes).toHaveLength(1);
  expect(r.milestoneCompletes[0].milestoneId).toBe('');
});

// ─── Combined response parsing (realistic agent output) ───────────────────────

console.log('\n=== Combined response (realistic) ===');

test('parses a realistic agent response with multiple tags', () => {
  const agentReply = `
I reviewed the current goals and found the test suite is at 78%.

<action_taken>Reviewed test coverage for agent-loop.js — XML parsing was untested</action_taken>
<action_taken>Exported parseAgentResponse for testability</action_taken>

<wa_message>✅ Added integration tests for agent-loop XML parsing. Test suite now at 85%.</wa_message>

<goal_update id="test-suite-goal" status="in_progress" progress="85">XML parsing integration tests written</goal_update>
<milestone_complete goal="test-suite-goal" milestone="ms_integration">Integration tests added in agent-loop-integration.test.js</milestone_complete>

<followup>run-full-test-suite</followup>
<next_cycle_minutes>10</next_cycle_minutes>
`;
  const r = parseAgentResponse(agentReply);
  expect(r.waMessages).toHaveLength(1);
  expect(r.actionsTaken).toHaveLength(2);
  expect(r.goalUpdates).toHaveLength(1);
  expect(r.milestoneCompletes).toHaveLength(1);
  expect(r.followups).toHaveLength(1);
  expect(r.nextCycleMinutes).toBe(10);

  expect(r.waMessages[0]).toContain('integration tests');
  expect(r.goalUpdates[0].progress).toBe(85);
  expect(r.milestoneCompletes[0].goalId).toBe('test-suite-goal');
  expect(r.followups[0].topic).toBe('run-full-test-suite');
});

test('parses response with no tags → all empty', () => {
  const r = parseAgentResponse('No actions needed this cycle. Everything looks good.');
  expect(r.waMessages).toHaveLength(0);
  expect(r.followups).toHaveLength(0);
  expect(r.actionsTaken).toHaveLength(0);
  expect(r.goalUpdates).toHaveLength(0);
  expect(r.milestoneCompletes).toHaveLength(0);
  expect(r.goalCreates).toHaveLength(0);
  expect(r.nextCycleMinutes).toBeNull();
});

test('handles malformed XML gracefully (no closing tag)', () => {
  // Should not throw; just ignore incomplete tags
  const r = parseAgentResponse('<wa_message>Unclosed tag...');
  expect(r.waMessages).toHaveLength(0); // regex requires closing tag
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
