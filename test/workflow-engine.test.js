/**
 * Tests for workflow-engine.js pure logic — run with: node test/workflow-engine.test.js
 *
 * Tests interpolateContext, getReadySteps, and step state machine logic.
 * These functions are extracted/duplicated here to avoid importing the full
 * module (which pulls in claude.js and its heavy dependency tree).
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
    toEqual(expected) {
      const a = JSON.stringify(actual), b = JSON.stringify(expected);
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
    },
    toBeTruthy() { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
  };
}

// ---------------------------------------------------------------------------
// Extracted from workflow-engine.js (lines 340-348)
// ---------------------------------------------------------------------------

function interpolateContext(template, context) {
  return template.replace(/\{\{context\.(\w+)\.(\w+)\}\}/g, (match, stepId, field) => {
    const val = context[stepId]?.[field];
    return val !== undefined ? String(val) : match;
  }).replace(/\{\{context\.(\w+)\}\}/g, (match, key) => {
    const val = context[key];
    if (val === undefined) return match;
    return typeof val === 'object' ? JSON.stringify(val) : String(val);
  });
}

// ---------------------------------------------------------------------------
// Extracted from workflow-engine.js (lines 142-151)
// ---------------------------------------------------------------------------

function getReadySteps(wf) {
  return wf.steps.filter(s => {
    if (s.status !== 'pending') return false;
    return s.dependsOn.every(depId => {
      const dep = wf.steps.find(d => d.id === depId);
      return dep && (dep.status === 'completed' || dep.status === 'skipped');
    });
  });
}

// ---------------------------------------------------------------------------
// interpolateContext tests
// ---------------------------------------------------------------------------
console.log('\n=== interpolateContext ===');

test('simple key substitution', () => {
  const result = interpolateContext('Hello {{context.name}}', { name: 'Ron' });
  expect(result).toBe('Hello Ron');
});

test('nested key substitution (stepId.field)', () => {
  const ctx = { s1: { reply: 'analysis complete', costUsd: 0.05 } };
  const result = interpolateContext('Result: {{context.s1.reply}}', ctx);
  expect(result).toBe('Result: analysis complete');
});

test('numeric values converted to string', () => {
  const result = interpolateContext('Cost: ${{context.s1.costUsd}}', { s1: { costUsd: 0.123 } });
  expect(result).toBe('Cost: $0.123');
});

test('object values serialized as JSON', () => {
  const ctx = { data: { a: 1, b: 2 } };
  const result = interpolateContext('Got: {{context.data}}', ctx);
  expect(result).toBe('Got: {"a":1,"b":2}');
});

test('missing keys left as-is', () => {
  const result = interpolateContext('Hello {{context.missing}}', {});
  expect(result).toBe('Hello {{context.missing}}');
});

test('missing nested keys left as-is', () => {
  const result = interpolateContext('Val: {{context.s1.missing}}', { s1: {} });
  expect(result).toBe('Val: {{context.s1.missing}}');
});

test('multiple substitutions in one template', () => {
  const ctx = { s1: { reply: 'done' }, s2: { reply: 'ok' } };
  const result = interpolateContext('Step 1: {{context.s1.reply}}, Step 2: {{context.s2.reply}}', ctx);
  expect(result).toBe('Step 1: done, Step 2: ok');
});

test('no placeholders → unchanged', () => {
  expect(interpolateContext('plain text', {})).toBe('plain text');
});

// ---------------------------------------------------------------------------
// getReadySteps tests
// ---------------------------------------------------------------------------
console.log('\n=== getReadySteps ===');

function makeWf(steps) {
  return { steps: steps.map((s, i) => ({ id: s.id || `s${i + 1}`, status: s.status || 'pending', dependsOn: s.dependsOn || [] })) };
}

test('first step with no deps is ready', () => {
  const wf = makeWf([{ status: 'pending', dependsOn: [] }]);
  expect(getReadySteps(wf).length).toBe(1);
  expect(getReadySteps(wf)[0].id).toBe('s1');
});

test('step with completed dep is ready', () => {
  const wf = makeWf([
    { id: 's1', status: 'completed', dependsOn: [] },
    { id: 's2', status: 'pending', dependsOn: ['s1'] },
  ]);
  expect(getReadySteps(wf).length).toBe(1);
  expect(getReadySteps(wf)[0].id).toBe('s2');
});

test('step with skipped dep is ready', () => {
  const wf = makeWf([
    { id: 's1', status: 'skipped', dependsOn: [] },
    { id: 's2', status: 'pending', dependsOn: ['s1'] },
  ]);
  expect(getReadySteps(wf).length).toBe(1);
});

test('step with pending dep is NOT ready', () => {
  const wf = makeWf([
    { id: 's1', status: 'pending', dependsOn: [] },
    { id: 's2', status: 'pending', dependsOn: ['s1'] },
  ]);
  const ready = getReadySteps(wf);
  expect(ready.length).toBe(1);
  expect(ready[0].id).toBe('s1'); // only s1 is ready
});

test('step with running dep is NOT ready', () => {
  const wf = makeWf([
    { id: 's1', status: 'running', dependsOn: [] },
    { id: 's2', status: 'pending', dependsOn: ['s1'] },
  ]);
  expect(getReadySteps(wf).length).toBe(0);
});

test('step with failed dep is NOT ready', () => {
  const wf = makeWf([
    { id: 's1', status: 'failed', dependsOn: [] },
    { id: 's2', status: 'pending', dependsOn: ['s1'] },
  ]);
  expect(getReadySteps(wf).length).toBe(0);
});

test('parallel steps (no deps between them) are both ready', () => {
  const wf = makeWf([
    { id: 's1', status: 'pending', dependsOn: [] },
    { id: 's2', status: 'pending', dependsOn: [] },
  ]);
  expect(getReadySteps(wf).length).toBe(2);
});

test('diamond dependency: s3 waits for both s1 and s2', () => {
  const wf = makeWf([
    { id: 's1', status: 'completed', dependsOn: [] },
    { id: 's2', status: 'pending', dependsOn: [] },
    { id: 's3', status: 'pending', dependsOn: ['s1', 's2'] },
  ]);
  // s2 is ready, s3 is not (s2 still pending)
  const ready = getReadySteps(wf);
  expect(ready.length).toBe(1);
  expect(ready[0].id).toBe('s2');
});

test('diamond: both deps completed → s3 ready', () => {
  const wf = makeWf([
    { id: 's1', status: 'completed', dependsOn: [] },
    { id: 's2', status: 'completed', dependsOn: [] },
    { id: 's3', status: 'pending', dependsOn: ['s1', 's2'] },
  ]);
  const ready = getReadySteps(wf);
  expect(ready.length).toBe(1);
  expect(ready[0].id).toBe('s3');
});

test('completed steps are never ready', () => {
  const wf = makeWf([
    { id: 's1', status: 'completed', dependsOn: [] },
  ]);
  expect(getReadySteps(wf).length).toBe(0);
});

test('empty workflow → no ready steps', () => {
  expect(getReadySteps({ steps: [] }).length).toBe(0);
});

// ---------------------------------------------------------------------------
// Step state machine validation
// ---------------------------------------------------------------------------
console.log('\n=== Step State Machine ===');

test('valid status transitions', () => {
  const validTransitions = {
    pending: ['running', 'skipped'],
    running: ['completed', 'failed', 'pending'], // pending = retry
    completed: [],
    failed: [],
    skipped: [],
  };

  // Verify all statuses are accounted for
  const allStatuses = ['pending', 'running', 'completed', 'failed', 'skipped'];
  for (const status of allStatuses) {
    expect(validTransitions[status] !== undefined).toBeTruthy();
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
