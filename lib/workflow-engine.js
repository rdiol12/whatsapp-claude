/**
 * Workflow Engine — persistent, multi-step autonomous workflows.
 *
 * Workflows are DAGs of steps that execute asynchronously, survive restarts,
 * and support multiple step types (claude, tool, wait_input, conditional, delay).
 *
 * Design:
 * - Event-driven: "kick and check", not blocking loops
 * - Steps go through the queue for concurrency control
 * - Per-workflow JSON files in data/workflows/
 * - Lightweight index for fast listing
 *
 * Integration:
 * - /task creates workflows via task-planner
 * - Crons can trigger workflows
 * - /wf commands manage workflows
 * - Claude can create/manage via MCP tools
 */

import { readFileSync, readdirSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { chatOneShot } from './claude.js';
import config from './config.js';
import { createLogger } from './logger.js';
import { writeFileAtomic } from './resilience.js';
import { appendEvent } from './daily-notes.js';
import { notify } from './notify.js';

const log = createLogger('workflow');
const WORKFLOWS_DIR = join(config.dataDir, 'workflows');
mkdirSync(WORKFLOWS_DIR, { recursive: true });

// In-memory registry of active workflows
const activeWorkflows = new Map(); // id → workflow object
let sendFn = null;
let queueRef = null;

// Pending user inputs: jid → { workflowId, stepId, resolve }
const pendingInputs = new Map();

// Delay timers: stepKey → timeout
const delayTimers = new Map();

// --- Persistence ---

function workflowPath(id) {
  return join(WORKFLOWS_DIR, `${id}.json`);
}

function saveWorkflow(wf) {
  writeFileAtomic(workflowPath(wf.id), JSON.stringify(wf, null, 2));
}

function loadWorkflow(id) {
  try {
    return JSON.parse(readFileSync(workflowPath(id), 'utf-8'));
  } catch { return null; }
}

function deleteWorkflowFile(id) {
  try { unlinkSync(workflowPath(id)); } catch {}
}

// --- Lifecycle ---

/**
 * Create a new workflow.
 * @param {string} name - Human-readable name
 * @param {Array} steps - Step definitions
 * @param {object} opts - { trigger, context, notifyPolicy }
 * @returns {object} The created workflow
 */
export function createWorkflow(name, steps, opts = {}) {
  const id = `wf_${randomBytes(4).toString('hex')}`;
  const wf = {
    id,
    name,
    status: 'pending',
    trigger: opts.trigger || { type: 'chat', source: 'manual' },
    steps: steps.map((s, i) => ({
      id: s.id || `s${i + 1}`,
      type: s.type || 'claude',
      description: s.description,
      status: 'pending',
      dependsOn: s.dependsOn || (i > 0 ? [`s${i}`] : []),
      config: s.config || {},
      result: null,
      retries: 0,
      maxRetries: s.maxRetries ?? 1,
      rollback: s.rollback || null,
      startedAt: null,
      completedAt: null,
    })),
    chainSource: opts.trigger?.source || null,
    context: opts.context || {},
    notifyPolicy: opts.notifyPolicy || 'summary',
    maxDuration: opts.maxDuration || 24 * 3600_000,
    maxRetries: opts.maxRetries ?? 2,
    userVeto: opts.userVeto ?? false,
    lastAdvancedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    costUsd: 0,
    error: null,
  };

  saveWorkflow(wf);
  activeWorkflows.set(id, wf);
  log.info({ id, name, steps: wf.steps.length }, 'Workflow created');
  return wf;
}

/**
 * Start a pending workflow.
 */
export function startWorkflow(id) {
  const wf = activeWorkflows.get(id) || loadWorkflow(id);
  if (!wf || wf.status !== 'pending') return null;

  wf.status = 'running';
  wf.updatedAt = Date.now();
  activeWorkflows.set(id, wf);
  saveWorkflow(wf);

  appendEvent('workflow', `Started: ${wf.name} (${wf.steps.length} steps)`);
  if (wf.notifyPolicy !== 'silent' && sendFn) {
    sendFn(`*Workflow started:* ${wf.name} (${wf.steps.length} steps)`);
  }

  log.info({ id, name: wf.name }, 'Workflow started');
  advanceWorkflow(id);
  return wf;
}

/**
 * Create and immediately start a workflow.
 */
export function runWorkflow(name, steps, opts = {}) {
  const wf = createWorkflow(name, steps, opts);
  startWorkflow(wf.id);
  return wf;
}

// --- Step Execution ---

function getReadySteps(wf) {
  return wf.steps.filter(s => {
    if (s.status !== 'pending') return false;
    // Check all dependencies completed
    return s.dependsOn.every(depId => {
      const dep = wf.steps.find(d => d.id === depId);
      return dep && (dep.status === 'completed' || dep.status === 'skipped');
    });
  });
}

async function executeStep(wf, step) {
  // Phase 4: Confidence gate check before trust check
  try {
    const { gateAction } = await import('./confidence-gate.js');
    const actionType = step.type === 'tool' ? 'execute_tool' : step.type === 'claude' ? 'run_chain' : step.type;
    const gate = gateAction(actionType, { targetExists: true, intentClarity: 0.6, reversible: step.rollback != null });
    if (gate.action === 'ask') {
      log.info({ wfId: wf.id, stepId: step.id, score: gate.score }, 'Step paused by confidence gate (low score)');
      step.status = 'running';
      wf.status = 'paused';
      wf.updatedAt = Date.now();
      saveWorkflow(wf);
      if (sendFn) {
        await sendFn(`*[${wf.name}]* Step "${step.description}" confidence too low (${gate.score}/10).\nReply "approve" to continue or "/wf cancel ${wf.id}" to abort.`);
      }
      return;
    }
  } catch {}

  // Phase 3: Trust check before execution
  try {
    const { getAutonomyLevel } = await import('./trust-engine.js');
    const trustActionType = step.type === 'tool' ? 'execute_tool' : step.type === 'claude' ? 'run_chain' : step.type;
    const trust = getAutonomyLevel(trustActionType);
    if (trust.level === 0) {
      // Needs permission — pause workflow for approval
      log.info({ wfId: wf.id, stepId: step.id, trustLevel: trust.level, actionType: trustActionType }, 'Step paused for approval (low trust)');
      step.status = 'running';
      wf.status = 'paused';
      wf.updatedAt = Date.now();
      saveWorkflow(wf);
      if (sendFn) {
        await sendFn(`*[${wf.name}]* Step "${step.description}" needs approval (trust level 0).\nReply "approve" to continue or "/wf cancel ${wf.id}" to abort.`);
      }
      return;
    }
  } catch {
    // Trust engine not available — proceed normally
  }

  step.status = 'running';
  step.startedAt = Date.now();
  wf.updatedAt = Date.now();
  saveWorkflow(wf);

  const verbose = wf.notifyPolicy === 'verbose';
  if (verbose && sendFn) {
    await sendFn(`_[${wf.name}] Step: ${step.description}_`);
  }

  log.info({ wfId: wf.id, stepId: step.id, type: step.type, desc: step.description.slice(0, 80) }, 'Executing step');

  try {
    let result;

    switch (step.type) {
      case 'claude':
        result = await executeClaudeStep(wf, step);
        break;
      case 'tool':
        result = await executeToolStep(wf, step);
        break;
      case 'wait_input':
        result = await executeWaitInputStep(wf, step);
        if (result === 'waiting') return; // Don't advance — waiting for user
        break;
      case 'conditional':
        result = executeConditionalStep(wf, step);
        break;
      case 'delay':
        executeDelayStep(wf, step);
        return; // Don't advance — timer will call back
      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }

    // Step completed
    step.status = 'completed';
    step.result = result;
    step.completedAt = Date.now();
    wf.context[step.id] = result;
    wf.updatedAt = Date.now();
    saveWorkflow(wf);

    log.info({ wfId: wf.id, stepId: step.id, ms: step.completedAt - step.startedAt }, 'Step completed');

    // Continue workflow
    advanceWorkflow(wf.id);
  } catch (err) {
    // Route through error-recovery for smart retry strategies
    let recovered = false;
    try {
      const { attemptRecovery } = await import('./error-recovery.js');
      const actionType = step.type === 'tool' ? 'execute_tool' : step.type === 'claude' ? 'run_chain' : step.type;
      const recovery = await attemptRecovery(err, async () => {
        let result;
        switch (step.type) {
          case 'claude': result = await executeClaudeStep(wf, step); break;
          case 'tool': result = await executeToolStep(wf, step); break;
          default: throw err; // Non-retryable step types
        }
        return result;
      }, {
        source: 'workflow-engine',
        action: `step:${step.id}`,
        actionType,
        wfId: wf.id,
      });

      if (recovery.recovered) {
        recovered = true;
        step.status = 'completed';
        step.result = recovery.result;
        step.completedAt = Date.now();
        wf.context[step.id] = recovery.result;
        wf.updatedAt = Date.now();
        saveWorkflow(wf);
        log.info({ wfId: wf.id, stepId: step.id, recoveryAttempts: recovery.attempts }, 'Step recovered via error-recovery');
        advanceWorkflow(wf.id);
      }
    } catch (recoveryErr) {
      log.warn({ wfId: wf.id, stepId: step.id, err: recoveryErr.message }, 'Error-recovery itself failed, falling back');
    }

    if (!recovered) {
      step.retries++;
      if (step.retries <= step.maxRetries) {
        log.warn({ wfId: wf.id, stepId: step.id, retry: step.retries, err: err.message }, 'Step failed, retrying');
        step.status = 'pending';
        step.startedAt = null;
        wf.updatedAt = Date.now();
        saveWorkflow(wf);
        setTimeout(() => advanceWorkflow(wf.id), 2000);
      } else {
        step.status = 'failed';
        step.result = { error: err.message };
        step.completedAt = Date.now();
        wf.updatedAt = Date.now();
        saveWorkflow(wf);

        log.error({ wfId: wf.id, stepId: step.id, err: err.message }, 'Step failed permanently');
        handleStepFailure(wf, step);
      }
    }
  }
}

async function executeClaudeStep(wf, step) {
  // Interpolate context variables in prompt
  let prompt = step.config.prompt || step.description;
  prompt = interpolateContext(prompt, wf.context);

  // Add workflow context
  prompt = `[Workflow: ${wf.name}, Step ${step.id}]\n\n${prompt}`;

  const { reply, costUsd } = await chatOneShot(prompt, null, step.config.model || null);
  wf.costUsd += costUsd || 0;
  return { reply, costUsd };
}

async function executeToolStep(wf, step) {
  const cmd = interpolateContext(step.config.command || '', wf.context);
  if (!cmd) throw new Error('Tool step has no command');

  // Execute via child_process (shell: true needed for command strings with pipes/redirects)
  const { execSync } = await import('child_process');
  const timeout = step.config.timeout || 30_000;
  try {
    const stdout = execSync(cmd, {
      timeout,
      encoding: 'utf-8',
      shell: true,
      cwd: step.config.cwd || config.workspaceDir,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stdout.slice(0, 2000), exitCode: 0 };
  } catch (err) {
    return { stdout: (err.stdout || '').slice(0, 1000), stderr: (err.stderr || '').slice(0, 1000), exitCode: err.status || 1 };
  }
}

async function executeWaitInputStep(wf, step) {
  const question = interpolateContext(step.config.question || 'Waiting for your input:', wf.context);
  const jid = step.config.jid || config.allowedJid;

  // Send question to user
  if (sendFn) {
    await sendFn(`*[${wf.name}]* ${question}\n\n_Reply to continue, or "/wf cancel ${wf.id}" to abort._`);
  }

  // Set up pending input
  return new Promise((resolve) => {
    const timeoutMs = step.config.timeout || 24 * 3600_000; // Default 24h

    const timer = setTimeout(() => {
      pendingInputs.delete(jid);
      resolve({ input: null, timedOut: true });
    }, timeoutMs);

    pendingInputs.set(jid, {
      workflowId: wf.id,
      stepId: step.id,
      resolve: (input) => {
        clearTimeout(timer);
        pendingInputs.delete(jid);
        resolve({ input, timedOut: false });
      },
    });

    // Mark as waiting (not 'running')
    wf.status = 'paused';
    step.status = 'running'; // still running, waiting for input
    wf.updatedAt = Date.now();
    saveWorkflow(wf);
  });
}

function executeConditionalStep(wf, step) {
  const condition = step.config.condition || 'true';
  const ctx = wf.context;

  let result;
  try {
    // Safe evaluation — only allow property access, comparisons, and boolean logic
    // Reject anything that could be code injection (function calls, assignments, require, import)
    if (/[{};\[\]`\\]|(?:require|import|eval|Function|process|global|__proto__|constructor)\b/.test(condition)) {
      log.warn({ wfId: wf.id, stepId: step.id, condition }, 'Condition rejected — contains unsafe pattern');
      result = true;
    } else {
      const fn = new Function('context', `"use strict"; return !!(${condition})`);
      result = fn(Object.freeze({ ...ctx }));
    }
  } catch (err) {
    log.warn({ wfId: wf.id, stepId: step.id, condition, err: err.message }, 'Condition eval failed, defaulting to true');
    result = true;
  }

  // Skip steps on the false branch
  if (!result && step.config.skipOnFalse) {
    for (const skipId of step.config.skipOnFalse) {
      const skipStep = wf.steps.find(s => s.id === skipId);
      if (skipStep && skipStep.status === 'pending') {
        skipStep.status = 'skipped';
        skipStep.result = { skippedBy: step.id, reason: 'condition_false' };
        skipStep.completedAt = Date.now();
        wf.context[skipId] = skipStep.result;
        log.info({ wfId: wf.id, skipped: skipId, condition }, 'Step skipped (condition false)');
      }
    }
  }

  return { condition, result, branch: result ? 'true' : 'false' };
}

function executeDelayStep(wf, step) {
  const durationMs = step.config.durationMs || 60_000;
  const timerKey = `${wf.id}_${step.id}`;

  log.info({ wfId: wf.id, stepId: step.id, durationMs }, 'Delay step started');

  const timer = setTimeout(() => {
    delayTimers.delete(timerKey);
    step.status = 'completed';
    step.result = { delayMs: durationMs };
    step.completedAt = Date.now();
    wf.context[step.id] = step.result;
    wf.updatedAt = Date.now();
    saveWorkflow(wf);
    log.info({ wfId: wf.id, stepId: step.id }, 'Delay step completed');
    advanceWorkflow(wf.id);
  }, durationMs);

  timer.unref();
  delayTimers.set(timerKey, timer);
}

/** Escape a value for safe shell interpolation (prevents injection via semicolons, pipes, backticks) */
function shellEscape(val) {
  const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
  // Remove shell metacharacters that enable command injection
  return str.replace(/[;&|`$(){}[\]<>!#*?\n\r]/g, '');
}

function interpolateContext(template, context) {
  return template.replace(/\{\{context\.(\w+)\.(\w+)\}\}/g, (match, stepId, field) => {
    const val = context[stepId]?.[field];
    return val !== undefined ? shellEscape(val) : match;
  }).replace(/\{\{context\.(\w+)\}\}/g, (match, key) => {
    const val = context[key];
    if (val === undefined) return match;
    return shellEscape(val);
  });
}

// --- Workflow Advancement ---

function advanceWorkflow(id) {
  const wf = activeWorkflows.get(id);
  if (!wf || wf.status === 'paused' || wf.status === 'cancelled') return;
  wf.lastAdvancedAt = Date.now();

  // Check if workflow is complete
  const allDone = wf.steps.every(s => ['completed', 'skipped', 'failed'].includes(s.status));
  if (allDone) {
    completeWorkflow(wf);
    return;
  }

  // Find ready steps
  const ready = getReadySteps(wf);
  if (ready.length === 0) return; // Nothing to do yet

  // Execute ready steps (possibly in parallel)
  for (const step of ready) {
    if (queueRef) {
      // Run through queue with workflow-specific userId for fairness
      queueRef.enqueue(`wf:${wf.id}`, () => executeStep(wf, step));
    } else {
      // No queue — run directly
      executeStep(wf, step);
    }
  }
}

function completeWorkflow(wf) {
  const succeeded = wf.steps.filter(s => s.status === 'completed').length;
  const failed = wf.steps.filter(s => s.status === 'failed').length;
  const totalMs = Date.now() - wf.createdAt;

  wf.status = failed > 0 ? 'failed' : 'completed';
  wf.completedAt = Date.now();
  wf.updatedAt = Date.now();
  saveWorkflow(wf);
  activeWorkflows.delete(wf.id);

  // Clean up any pending inputs for this workflow
  for (const [jid, pending] of pendingInputs.entries()) {
    if (pending.workflowId === wf.id) {
      pendingInputs.delete(jid);
    }
  }

  // Clean up delay timers
  for (const [key, timer] of delayTimers.entries()) {
    if (key.startsWith(`${wf.id}_`)) {
      clearTimeout(timer);
      delayTimers.delete(key);
    }
  }

  const emoji = wf.status === 'completed' ? 'Done' : 'Failed';
  const summary = `*Workflow ${emoji}:* ${wf.name}\n${succeeded}/${wf.steps.length} steps, ${(totalMs / 1000).toFixed(0)}s, $${wf.costUsd.toFixed(4)}`;

  appendEvent('workflow', `${emoji}: ${wf.name} (${succeeded}/${wf.steps.length})`);

  if (wf.notifyPolicy !== 'silent' && sendFn) {
    sendFn(summary);
  }
  if (wf.status === 'failed') {
    notify(`Workflow failed: ${wf.name} (${failed} step failures)`);
  }

  log.info({ id: wf.id, name: wf.name, status: wf.status, succeeded, failed, totalMs, costUsd: wf.costUsd.toFixed(4) }, 'Workflow complete');
}

async function handleStepFailure(wf, step) {
  // Attempt rollback if defined (Phase 2: chain rollback support)
  if (step.rollback) {
    try {
      log.info({ wfId: wf.id, stepId: step.id, rollback: String(step.rollback).slice(0, 100) }, 'Attempting step rollback');
      if (typeof step.rollback === 'string' && step.rollback.trim()) {
        // Rollback is a shell command
        const { execSync } = await import('child_process');
        execSync(step.rollback, { timeout: 15000, encoding: 'utf-8', shell: true, cwd: config.workspaceDir });
      }
      step.result = { ...step.result, rolledBack: true };
      log.info({ wfId: wf.id, stepId: step.id }, 'Rollback succeeded');
    } catch (rbErr) {
      log.warn({ wfId: wf.id, stepId: step.id, err: rbErr.message }, 'Rollback failed');
      step.result = { ...step.result, rolledBack: false, rollbackError: rbErr.message };
    }
    wf.updatedAt = Date.now();
    saveWorkflow(wf);
  }

  // Check if any remaining steps depend on the failed step
  const blocked = wf.steps.filter(s =>
    s.status === 'pending' && s.dependsOn.includes(step.id)
  );

  // Skip blocked steps
  for (const s of blocked) {
    s.status = 'skipped';
    s.result = { skippedDueTo: step.id };
    s.completedAt = Date.now();
  }

  if (blocked.length > 0) {
    wf.updatedAt = Date.now();
    saveWorkflow(wf);
  }

  // Try to advance (other independent steps may still run)
  advanceWorkflow(wf.id);
}

// --- User Input Handling ---

/**
 * Check if there's a workflow waiting for input from this JID.
 * If so, provide the input and resume the workflow.
 * @returns {boolean} true if input was consumed
 */
export function handleUserInput(jid, text) {
  const pending = pendingInputs.get(jid);
  if (!pending) return false;

  const wf = activeWorkflows.get(pending.workflowId);
  if (!wf) {
    pendingInputs.delete(jid);
    return false;
  }

  // Resume workflow
  wf.status = 'running';
  wf.updatedAt = Date.now();
  saveWorkflow(wf);

  pending.resolve(text);
  log.info({ wfId: wf.id, stepId: pending.stepId }, 'User input received, workflow resuming');
  return true;
}

/**
 * Check if a JID has a workflow waiting for input.
 */
export function hasWaitingWorkflow(jid) {
  return pendingInputs.has(jid);
}

// --- Control ---

export function pauseWorkflow(id) {
  const wf = activeWorkflows.get(id) || loadWorkflow(id);
  if (!wf || !['running', 'pending'].includes(wf.status)) return null;
  wf.status = 'paused';
  wf.updatedAt = Date.now();
  saveWorkflow(wf);
  if (activeWorkflows.has(id)) activeWorkflows.set(id, wf);
  log.info({ id, name: wf.name }, 'Workflow paused');
  return wf;
}

export function resumeWorkflow(id) {
  const wf = activeWorkflows.get(id) || loadWorkflow(id);
  if (!wf || wf.status !== 'paused') return null;
  wf.status = 'running';
  wf.updatedAt = Date.now();
  activeWorkflows.set(id, wf);
  saveWorkflow(wf);
  log.info({ id, name: wf.name }, 'Workflow resumed');
  advanceWorkflow(id);
  return wf;
}

export function cancelWorkflow(id) {
  const wf = activeWorkflows.get(id) || loadWorkflow(id);
  if (!wf || ['completed', 'cancelled'].includes(wf.status)) return null;
  wf.status = 'cancelled';
  wf.updatedAt = Date.now();
  wf.completedAt = Date.now();
  saveWorkflow(wf);
  activeWorkflows.delete(id);

  // Clean up any pending inputs
  for (const [jid, pending] of pendingInputs.entries()) {
    if (pending.workflowId === id) {
      pending.resolve(null);
      pendingInputs.delete(jid);
    }
  }

  // Clean up delay timers
  for (const [key, timer] of delayTimers.entries()) {
    if (key.startsWith(`${id}_`)) {
      clearTimeout(timer);
      delayTimers.delete(key);
    }
  }

  log.info({ id, name: wf.name }, 'Workflow cancelled');
  if (sendFn) sendFn(`Workflow cancelled: *${wf.name}*`);
  return wf;
}

// --- Listing & Status ---

export function listWorkflows(filter = {}) {
  const files = readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json'));
  const workflows = [];

  for (const file of files) {
    try {
      const wf = JSON.parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf-8'));
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        if (!statuses.includes(wf.status)) continue;
      }
      workflows.push({
        id: wf.id,
        name: wf.name,
        status: wf.status,
        steps: wf.steps.length,
        completed: wf.steps.filter(s => s.status === 'completed').length,
        failed: wf.steps.filter(s => s.status === 'failed').length,
        costUsd: wf.costUsd,
        createdAt: wf.createdAt,
        completedAt: wf.completedAt,
      });
    } catch {}
  }

  return workflows.sort((a, b) => b.createdAt - a.createdAt);
}

export function getWorkflow(id) {
  return activeWorkflows.get(id) || loadWorkflow(id);
}

/**
 * Detect workflows with stalled steps (running longer than threshold) or exceeded maxDuration.
 * @param {number} stallThresholdMs - How long a step must be running to be considered stalled (default 2h)
 * @returns {Array<{ id, name, stalledSteps: string[], exceeded: boolean }>}
 */
export function detectStalledWorkflows(stallThresholdMs = 2 * 3600_000) {
  const now = Date.now();
  const results = [];

  for (const [id, wf] of activeWorkflows) {
    if (wf.status !== 'running') continue;

    const stalledSteps = [];
    for (const step of wf.steps || []) {
      if (step.status === 'running' && step.startedAt && (now - step.startedAt) > stallThresholdMs) {
        stalledSteps.push(step.id);
      }
    }

    const maxDuration = wf.maxDuration || 24 * 3600_000;
    const exceeded = (now - wf.createdAt) > maxDuration;

    if (stalledSteps.length > 0 || exceeded) {
      results.push({ id: wf.id, name: wf.name, stalledSteps, exceeded });
    }
  }

  return results;
}

export function getWorkflowSummary() {
  const all = listWorkflows();
  const running = all.filter(w => ['running', 'paused', 'pending'].includes(w.status));
  const recent = all.filter(w => ['completed', 'failed', 'cancelled'].includes(w.status)).slice(0, 5);

  if (running.length === 0 && recent.length === 0) return 'No workflows.';

  const parts = [];
  if (running.length > 0) {
    parts.push('*Active:*');
    for (const w of running) {
      const pct = w.steps > 0 ? Math.round((w.completed / w.steps) * 100) : 0;
      parts.push(`- *${w.name}* [${w.status}] ${w.completed}/${w.steps} steps (${pct}%)`);
    }
  }
  if (recent.length > 0) {
    parts.push('');
    parts.push('*Recent:*');
    for (const w of recent) {
      const ago = Math.round((Date.now() - (w.completedAt || w.createdAt)) / 3600_000);
      parts.push(`- ${w.name} [${w.status}] ${ago}h ago`);
    }
  }
  return parts.join('\n');
}

export function getWorkflowDetail(id) {
  const wf = getWorkflow(id);
  if (!wf) return null;

  const parts = [];
  parts.push(`*${wf.name}* [${wf.status}]`);
  const totalMs = (wf.completedAt || Date.now()) - wf.createdAt;
  parts.push(`Duration: ${(totalMs / 1000).toFixed(0)}s | Cost: $${wf.costUsd.toFixed(4)}`);

  parts.push('');
  parts.push('*Steps:*');
  for (const step of wf.steps) {
    const icon = step.status === 'completed' ? 'v' : step.status === 'failed' ? 'x' : step.status === 'running' ? '>' : step.status === 'skipped' ? '-' : 'o';
    const ms = step.completedAt && step.startedAt ? ` (${((step.completedAt - step.startedAt) / 1000).toFixed(1)}s)` : '';
    parts.push(`  ${icon} [${step.type}] ${step.description.slice(0, 60)}${ms}`);
  }

  if (wf.error) {
    parts.push(`\n*Error:* ${wf.error}`);
  }

  return parts.join('\n');
}

// --- Initialization ---

/**
 * Initialize the workflow engine. Call on startup.
 * Resumes interrupted workflows.
 */
export function init({ send, queue }) {
  sendFn = send;
  queueRef = queue;

  // Load running workflows from disk
  const files = readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json'));
  let resumed = 0;

  for (const file of files) {
    try {
      const wf = JSON.parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf-8'));
      if (wf.status === 'running') {
        // Reset any 'running' steps back to 'pending' (they were interrupted)
        for (const step of wf.steps) {
          if (step.status === 'running') {
            step.status = 'pending';
            step.startedAt = null;
          }
        }
        activeWorkflows.set(wf.id, wf);
        saveWorkflow(wf);
        advanceWorkflow(wf.id);
        resumed++;
      } else if (wf.status === 'paused') {
        activeWorkflows.set(wf.id, wf);
      }
    } catch {}
  }

  if (resumed > 0) {
    log.info({ resumed }, 'Resumed interrupted workflows');
  }
  log.info({ total: files.length, active: activeWorkflows.size }, 'Workflow engine initialized');
}

/**
 * Set/update the send function (called when WhatsApp connects).
 */
export function setSendFn(fn) {
  sendFn = fn;
}

/**
 * Flush: nothing to flush — we persist per-operation.
 * But clean up old completed workflows (keep last 50).
 */
export function cleanup() {
  const all = listWorkflows();
  const completed = all.filter(w => ['completed', 'failed', 'cancelled'].includes(w.status));
  if (completed.length > 50) {
    const toDelete = completed.slice(50);
    for (const wf of toDelete) {
      deleteWorkflowFile(wf.id);
    }
    log.info({ deleted: toDelete.length }, 'Cleaned up old workflows');
  }

  // Prune orphaned pendingInputs (workflow no longer active)
  for (const [jid, pending] of pendingInputs.entries()) {
    if (!activeWorkflows.has(pending.workflowId)) {
      pendingInputs.delete(jid);
      log.info({ jid, workflowId: pending.workflowId }, 'Pruned orphaned pendingInput');
    }
  }

  // Prune orphaned delay timers
  for (const [key, timer] of delayTimers.entries()) {
    const wfId = key.split('_').slice(0, 2).join('_'); // wf_<hex>
    if (!activeWorkflows.has(wfId)) {
      clearTimeout(timer);
      delayTimers.delete(key);
      log.info({ key }, 'Pruned orphaned delay timer');
    }
  }
}
