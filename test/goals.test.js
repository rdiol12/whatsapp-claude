/**
 * Tests for goals.js — run with: node test/goals.test.js
 *
 * Tests CRUD, status transitions, milestones, auto-complete, topic matching.
 * Uses baseline counts to avoid interference with real goals.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'goals.js')).href;
const {
  load, addGoal, updateGoal, deleteGoal, listGoals, getGoal,
  addMilestone, completeMilestone,
  getGoalSummary, getGoalDetail, getGoalsContext,
  matchGoalByTopic, getUpcomingDeadlines, getStaleGoals,
} = await import(modPath);

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
    toBeFalsy() { if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toContain(s) { if (!String(actual).includes(s)) throw new Error(`Expected "${actual}" to contain "${s}"`); },
    toBeGreaterThan(n) { if (actual <= n) throw new Error(`Expected ${actual} > ${n}`); },
    toBeNull() { if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`); },
  };
}

load();
const baseline = listGoals().length;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
console.log('\n=== Goal CRUD ===');

test('addGoal creates a goal', () => {
  const g = addGoal('Test Goal Alpha');
  expect(g.title).toBe('Test Goal Alpha');
  expect(g.status).toBe('active');
  expect(g.priority).toBe('normal');
  expect(g.category).toBe('project');
  expect(g.progress).toBe(0);
});

test('listGoals count increases', () => {
  expect(listGoals().length).toBe(baseline + 1);
});

test('getGoal finds by title', () => {
  const g = getGoal('Test Goal Alpha');
  expect(g).toBeTruthy();
  expect(g.title).toBe('Test Goal Alpha');
});

test('getGoal finds by partial title', () => {
  const g = getGoal('alpha');
  expect(g).toBeTruthy();
  expect(g.title).toBe('Test Goal Alpha');
});

test('getGoal returns null for unknown', () => {
  const g = getGoal('nonexistent-goal-xyz');
  expect(g).toBeFalsy();
});

test('addGoal with milestones', () => {
  const g = addGoal('Milestone Goal', { milestones: ['Step 1', 'Step 2', 'Step 3'] });
  expect(g.milestones.length).toBe(3);
  expect(g.milestones[0].title).toBe('Step 1');
  expect(g.milestones[0].status).toBe('pending');
  expect(g.progress).toBe(0);
  deleteGoal(g.id);
});

test('addGoal with options', () => {
  const g = addGoal('Priority Goal', {
    priority: 'high',
    category: 'health',
    linkedTopics: ['gym', 'exercise'],
    description: 'Stay fit',
  });
  expect(g.priority).toBe('high');
  expect(g.category).toBe('health');
  expect(g.description).toBe('Stay fit');
  expect(g.linkedTopics.length).toBe(2);
  deleteGoal(g.id);
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------
console.log('\n=== Status Transitions ===');

test('valid transition: active → in_progress', () => {
  const g = getGoal('Test Goal Alpha');
  const updated = updateGoal(g.id, { status: 'in_progress' });
  expect(updated.status).toBe('in_progress');
});

test('invalid transition: in_progress → active (returns null)', () => {
  const g = getGoal('Test Goal Alpha');
  const result = updateGoal(g.id, { status: 'active' });
  expect(result).toBeNull();
});

test('valid transition: in_progress → blocked', () => {
  const updated = updateGoal('Test Goal Alpha', { status: 'blocked' });
  expect(updated.status).toBe('blocked');
});

test('valid transition: blocked → in_progress', () => {
  const updated = updateGoal('Test Goal Alpha', { status: 'in_progress' });
  expect(updated.status).toBe('in_progress');
});

test('valid transition: in_progress → completed', () => {
  const updated = updateGoal('Test Goal Alpha', { status: 'completed' });
  expect(updated.status).toBe('completed');
  expect(updated.completedAt).toBeTruthy();
});

test('completed goal cannot transition', () => {
  const result = updateGoal('Test Goal Alpha', { status: 'active' });
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// Update fields
// ---------------------------------------------------------------------------
console.log('\n=== Update Fields ===');

test('updateGoal changes title', () => {
  const g = addGoal('Rename Me');
  const updated = updateGoal(g.id, { title: 'Renamed' });
  expect(updated.title).toBe('Renamed');
  deleteGoal(g.id);
});

test('updateGoal changes priority', () => {
  const g = addGoal('Priority Test');
  const updated = updateGoal(g.id, { priority: 'critical' });
  expect(updated.priority).toBe('critical');
  deleteGoal(g.id);
});

test('manual progress (no milestones)', () => {
  const g = addGoal('Progress Test');
  const updated = updateGoal(g.id, { progress: 60 });
  expect(updated.progress).toBe(60);
  deleteGoal(g.id);
});

test('progress clamped to 0-100', () => {
  const g = addGoal('Clamp Test');
  updateGoal(g.id, { progress: 150 });
  expect(getGoal(g.id).progress).toBe(100);
  updateGoal(g.id, { progress: -10 });
  expect(getGoal(g.id).progress).toBe(0);
  deleteGoal(g.id);
});

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------
console.log('\n=== Milestones ===');

test('addMilestone adds to goal', () => {
  const g = addGoal('MS Goal', { milestones: ['MS1'] });
  addMilestone(g.id, 'MS2');
  const updated = getGoal(g.id);
  expect(updated.milestones.length).toBe(2);
  deleteGoal(g.id);
});

test('completeMilestone updates progress', () => {
  const g = addGoal('Progress MS', { milestones: ['A', 'B'] });
  completeMilestone(g.id, 'A');
  const updated = getGoal(g.id);
  expect(updated.progress).toBe(50); // 1 of 2
  deleteGoal(g.id);
});

test('completeMilestone finds by title substring', () => {
  const g = addGoal('Substr MS', { milestones: ['Fix the login bug'] });
  const ms = completeMilestone(g.id, 'login bug');
  expect(ms).toBeTruthy();
  expect(ms.status).toBe('completed');
  deleteGoal(g.id);
});

test('completeMilestone with evidence', () => {
  const g = addGoal('Evidence MS', { milestones: ['Deploy v2'] });
  const ms = completeMilestone(g.id, 'Deploy v2', 'commit abc123');
  expect(ms.evidence).toBe('commit abc123');
  deleteGoal(g.id);
});

test('auto-complete goal when all milestones done', () => {
  const g = addGoal('Auto Goal', { milestones: ['Only step'] });
  completeMilestone(g.id, 'Only step');
  const updated = getGoal(g.id);
  expect(updated.status).toBe('completed');
  expect(updated.completedAt).toBeTruthy();
  deleteGoal(g.id);
});

// ---------------------------------------------------------------------------
// Topic matching
// ---------------------------------------------------------------------------
console.log('\n=== Topic Matching ===');

test('matchGoalByTopic matches linkedTopics', () => {
  const g = addGoal('Fitness Goal', { linkedTopics: ['gym', 'workout', 'exercise'] });
  const match = matchGoalByTopic('I went to the gym today');
  expect(match).toBeTruthy();
  expect(match.title).toBe('Fitness Goal');
  deleteGoal(g.id);
});

test('matchGoalByTopic returns null for no match', () => {
  const g = addGoal('Random Goal XYZ');
  const match = matchGoalByTopic('quantum physics lecture');
  // should not match — title words < 4 chars or not in text
  expect(match).toBeFalsy();
  deleteGoal(g.id);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
console.log('\n=== Formatting ===');

test('getGoalSummary returns string', () => {
  const g = addGoal('Summary Test Goal');
  const summary = getGoalSummary();
  expect(typeof summary).toBe('string');
  expect(summary).toContain('Summary Test Goal');
  deleteGoal(g.id);
});

test('getGoalDetail returns formatted string', () => {
  const g = addGoal('Detail Test', { description: 'A detailed goal', milestones: ['Step A'] });
  const detail = getGoalDetail(g.id);
  expect(detail).toContain('Detail Test');
  expect(detail).toContain('A detailed goal');
  expect(detail).toContain('Step A');
  deleteGoal(g.id);
});

test('getGoalsContext returns formatted list', () => {
  const g = addGoal('Context Goal');
  const ctx = getGoalsContext();
  expect(ctx).toContain('Context Goal');
  deleteGoal(g.id);
});

// ---------------------------------------------------------------------------
// Delete and cleanup
// ---------------------------------------------------------------------------
console.log('\n=== Delete ===');

test('deleteGoal removes goal', () => {
  deleteGoal('Test Goal Alpha');
  expect(listGoals().length).toBe(baseline);
});

test('deleteGoal returns null for unknown', () => {
  const result = deleteGoal('nonexistent-goal-xyz');
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
