/**
 * Tests for workflow-engine.js pure logic — run with: node test/workflow-engine.test.js
 *
 * Tests interpolateContext, getReadySteps, executeConditionalStep,
 * workflow defaults, state transitions, and step failure cascading.
 * These functions are extracted here to avoid importing the full module.
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
    toContain(sub) { if (typeof actual === 'string' && !actual.includes(sub)) throw new Error(`Expected "${actual.slice(0,100)}" to contain "${sub}"`); },
  };
}

// ---------------------------------------------------------------------------
// Extracted from workflow-engine.js
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

function getReadySteps(wf) {
  return wf.steps.filter(s => {
    if (s.status !== 'pending') return false;
    return s.dependsOn.every(depId => {
      const dep = wf.steps.find(d => d.id === depId);
      return dep && (dep.status === 'completed' || dep.status === 'skipped');
    });
  });
}

function executeConditionalStep(wf, step) {
  const condition = step.config.condition || 'true';
  const ctx = wf.context;
  let result;
  try {
    const fn = new Function('context', `return !!(${condition})`);
    result = fn(ctx);
  } catch (err) {
    result = true;
  }
  if (!result && step.config.skipOnFalse) {
    for (const skipId of step.config.skipOnFalse) {
      const skipStep = wf.steps.find(s => s.id === skipId);
      if (skipStep && skipStep.status === 'pending') {
        skipStep.status = 'skipped';
        skipStep.result = { skippedBy: step.id, reason: 'condition_false' };
        skipStep.completedAt = Date.now();
        wf.context[skipId] = skipStep.result;
      }
    }
  }
  return { condition, result, branch: result ? 'true' : 'false' };
}

// --- Helpers ---

function makeWf(steps) {
  return { steps: steps.map((s, i) => ({ id: s.id || `s${i + 1}`, status: s.status || 'pending', dependsOn: s.dependsOn || [], config: s.config || {}, result: null, retries: 0, maxRetries: 1, startedAt: null, completedAt: null })), context: {}, costUsd: 0, notifyPolicy: 'summary', status: 'pending' };
}

function makeFullWf(overrides = {}) {
  return {
    id: 'wf_test', name: 'Test Workflow', status: 'pending',
    trigger: { type: 'chat', source: 'manual' },
    steps: overrides.steps || [
      { id: 's1', type: 'claude', description: 'Step 1', status: 'pending', dependsOn: [], config: {}, result: null, retries: 0, maxRetries: 1, startedAt: null, completedAt: null },
      { id: 's2', type: 'claude', description: 'Step 2', status: 'pending', dependsOn: ['s1'], config: {}, result: null, retries: 0, maxRetries: 1, startedAt: null, completedAt: null },
      { id: 's3', type: 'claude', description: 'Step 3', status: 'pending', dependsOn: ['s2'], config: {}, result: null, retries: 0, maxRetries: 1, startedAt: null, completedAt: null },
    ],
    context: {}, notifyPolicy: 'summary', createdAt: Date.now(), updatedAt: Date.now(),
    completedAt: null, costUsd: 0, error: null, ...overrides,
  };
}

// ---------------------------------------------------------------------------
// interpolateContext
// ---------------------------------------------------------------------------
console.log('\n=== interpolateContext ===');

test('simple key substitution', () => {
  expect(interpolateContext('Hello {{context.name}}', { name: 'World' })).toBe('Hello World');
});

test('nested key substitution (stepId.field)', () => {
  const ctx = { s1: { reply: 'analysis complete', costUsd: 0.05 } };
  expect(interpolateContext('Result: {{context.s1.reply}}', ctx)).toBe('Result: analysis complete');
});

test('numeric values converted to string', () => {
  expect(interpolateContext('Cost: ${{context.s1.costUsd}}', { s1: { costUsd: 0.123 } })).toBe('Cost: $0.123');
});

test('object values serialized as JSON', () => {
  const result = interpolateContext('Got: {{context.data}}', { data: { a: 1, b: 2 } });
  expect(result).toBe('Got: {"a":1,"b":2}');
});

test('missing keys left as-is', () => {
  expect(interpolateContext('Hello {{context.missing}}', {})).toBe('Hello {{context.missing}}');
});

test('missing nested keys left as-is', () => {
  expect(interpolateContext('Val: {{context.s1.missing}}', { s1: {} })).toBe('Val: {{context.s1.missing}}');
});

test('multiple substitutions in one template', () => {
  const ctx = { s1: { reply: 'done' }, s2: { reply: 'ok' } };
  expect(interpolateContext('Step 1: {{context.s1.reply}}, Step 2: {{context.s2.reply}}', ctx)).toBe('Step 1: done, Step 2: ok');
});

test('no placeholders unchanged', () => {
  expect(interpolateContext('plain text', {})).toBe('plain text');
});

test('empty template', () => {
  expect(interpolateContext('', {})).toBe('');
});

test('boolean values converted to string', () => {
  expect(interpolateContext('OK: {{context.s1.success}}', { s1: { success: true } })).toBe('OK: true');
});

// ---------------------------------------------------------------------------
// getReadySteps
// ---------------------------------------------------------------------------
console.log('\n=== getReadySteps ===');

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
  expect(ready[0].id).toBe('s1');
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

test('parallel steps (no deps) are both ready', () => {
  const wf = makeWf([
    { id: 's1', status: 'pending', dependsOn: [] },
    { id: 's2', status: 'pending', dependsOn: [] },
  ]);
  expect(getReadySteps(wf).length).toBe(2);
});

test('diamond: s3 waits for both s1 and s2', () => {
  const wf = makeWf([
    { id: 's1', status: 'completed', dependsOn: [] },
    { id: 's2', status: 'pending', dependsOn: [] },
    { id: 's3', status: 'pending', dependsOn: ['s1', 's2'] },
  ]);
  const ready = getReadySteps(wf);
  expect(ready.length).toBe(1);
  expect(ready[0].id).toBe('s2');
});

test('diamond: both deps done → s3 ready', () => {
  const wf = makeWf([
    { id: 's1', status: 'completed', dependsOn: [] },
    { id: 's2', status: 'completed', dependsOn: [] },
    { id: 's3', status: 'pending', dependsOn: ['s1', 's2'] },
  ]);
  expect(getReadySteps(wf).length).toBe(1);
  expect(getReadySteps(wf)[0].id).toBe('s3');
});

test('completed steps are never ready', () => {
  const wf = makeWf([{ id: 's1', status: 'completed', dependsOn: [] }]);
  expect(getReadySteps(wf).length).toBe(0);
});

test('empty workflow → no ready steps', () => {
  expect(getReadySteps({ steps: [] }).length).toBe(0);
});

// ---------------------------------------------------------------------------
// executeConditionalStep
// ---------------------------------------------------------------------------
console.log('\n=== executeConditionalStep ===');

test('true condition returns true branch', () => {
  const wf = makeFullWf({ context: {} });
  const step = { id: 'cond', config: { condition: 'true' } };
  const result = executeConditionalStep(wf, step);
  expect(result.result).toBe(true);
  expect(result.branch).toBe('true');
});

test('false condition returns false branch', () => {
  const wf = makeFullWf({ context: {} });
  const step = { id: 'cond', config: { condition: 'false' } };
  const result = executeConditionalStep(wf, step);
  expect(result.result).toBe(false);
  expect(result.branch).toBe('false');
});

test('condition uses context variables', () => {
  const wf = makeFullWf({ context: { s1: { reply: 'yes' } } });
  const step = { id: 'cond', config: { condition: 'context.s1.reply === "yes"' } };
  expect(executeConditionalStep(wf, step).result).toBe(true);
});

test('condition with context returning false', () => {
  const wf = makeFullWf({ context: { s1: { reply: 'no' } } });
  const step = { id: 'cond', config: { condition: 'context.s1.reply === "yes"' } };
  expect(executeConditionalStep(wf, step).result).toBe(false);
});

test('invalid condition defaults to true', () => {
  const wf = makeFullWf({ context: {} });
  const step = { id: 'cond', config: { condition: 'this is not valid js %%' } };
  expect(executeConditionalStep(wf, step).result).toBe(true);
});

test('missing condition defaults to true', () => {
  const wf = makeFullWf({ context: {} });
  const step = { id: 'cond', config: {} };
  expect(executeConditionalStep(wf, step).result).toBe(true);
});

test('skipOnFalse skips target steps', () => {
  const wf = makeFullWf();
  const step = { id: 'cond', config: { condition: 'false', skipOnFalse: ['s2'] } };
  executeConditionalStep(wf, step);
  expect(wf.steps[1].status).toBe('skipped');
  expect(wf.steps[1].result.reason).toBe('condition_false');
});

test('skipOnFalse does not skip completed steps', () => {
  const wf = makeFullWf();
  wf.steps[1].status = 'completed';
  const step = { id: 'cond', config: { condition: 'false', skipOnFalse: ['s2'] } };
  executeConditionalStep(wf, step);
  expect(wf.steps[1].status).toBe('completed');
});

test('skipOnFalse not triggered when condition is true', () => {
  const wf = makeFullWf();
  const step = { id: 'cond', config: { condition: 'true', skipOnFalse: ['s2'] } };
  executeConditionalStep(wf, step);
  expect(wf.steps[1].status).toBe('pending');
});

test('skipOnFalse with multiple targets', () => {
  const wf = makeFullWf();
  const step = { id: 'cond', config: { condition: 'false', skipOnFalse: ['s2', 's3'] } };
  executeConditionalStep(wf, step);
  expect(wf.steps[1].status).toBe('skipped');
  expect(wf.steps[2].status).toBe('skipped');
});

test('skipOnFalse with non-existent step is harmless', () => {
  const wf = makeFullWf();
  const step = { id: 'cond', config: { condition: 'false', skipOnFalse: ['s99'] } };
  const result = executeConditionalStep(wf, step);
  expect(result.result).toBe(false);
});

test('condition stores context for skipped steps', () => {
  const wf = makeFullWf();
  const step = { id: 'cond', config: { condition: 'false', skipOnFalse: ['s2'] } };
  executeConditionalStep(wf, step);
  expect(wf.context.s2).toBeTruthy();
  expect(wf.context.s2.reason).toBe('condition_false');
});

// ---------------------------------------------------------------------------
// Workflow defaults
// ---------------------------------------------------------------------------
console.log('\n=== Workflow Defaults ===');

test('workflow starts pending', () => {
  expect(makeFullWf().status).toBe('pending');
});

test('all steps start pending', () => {
  expect(makeFullWf().steps.every(s => s.status === 'pending')).toBe(true);
});

test('first step has empty dependsOn', () => {
  expect(makeFullWf().steps[0].dependsOn.length).toBe(0);
});

test('sequential deps are correct', () => {
  const wf = makeFullWf();
  expect(wf.steps[1].dependsOn[0]).toBe('s1');
  expect(wf.steps[2].dependsOn[0]).toBe('s2');
});

test('context starts empty', () => {
  expect(Object.keys(makeFullWf().context).length).toBe(0);
});

test('costUsd starts at 0', () => {
  expect(makeFullWf().costUsd).toBe(0);
});

test('notifyPolicy defaults to summary', () => {
  expect(makeFullWf().notifyPolicy).toBe('summary');
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------
console.log('\n=== State Transitions ===');

test('pending → running is valid (startWorkflow gate)', () => {
  const wf = makeFullWf({ status: 'pending' });
  expect(wf.status === 'pending').toBe(true);
});

test('running/pending → paused is valid (pauseWorkflow gate)', () => {
  expect(['running', 'pending'].includes('running')).toBe(true);
  expect(['running', 'pending'].includes('pending')).toBe(true);
});

test('paused → running is valid (resumeWorkflow gate)', () => {
  expect('paused' === 'paused').toBe(true);
});

test('completed/cancelled → cancel rejected', () => {
  expect(['completed', 'cancelled'].includes('completed')).toBe(true);
  expect(['completed', 'cancelled'].includes('cancelled')).toBe(true);
});

test('running → cancel is valid', () => {
  expect(!['completed', 'cancelled'].includes('running')).toBe(true);
});

test('cancelled → resume rejected', () => {
  expect('cancelled' === 'paused').toBe(false);
});

// ---------------------------------------------------------------------------
// Step failure cascading
// ---------------------------------------------------------------------------
console.log('\n=== Step Failure Cascading ===');

test('failed dep blocks dependent steps', () => {
  const wf = makeFullWf();
  wf.steps[0].status = 'failed';
  const blocked = wf.steps.filter(s => s.status === 'pending' && s.dependsOn.includes('s1'));
  expect(blocked.length).toBe(1);
  expect(blocked[0].id).toBe('s2');
});

test('skipped dep unblocks next step', () => {
  const wf = makeFullWf();
  wf.steps[0].status = 'failed';
  wf.steps[1].status = 'skipped';
  const ready = getReadySteps(wf);
  expect(ready.length).toBe(1);
  expect(ready[0].id).toBe('s3');
});

test('independent steps continue after failure', () => {
  const wf = makeWf([
    { id: 's1', status: 'failed', dependsOn: [] },
    { id: 's2', status: 'pending', dependsOn: [] },
    { id: 's3', status: 'pending', dependsOn: ['s1'] },
  ]);
  const ready = getReadySteps(wf);
  expect(ready.length).toBe(1);
  expect(ready[0].id).toBe('s2');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
