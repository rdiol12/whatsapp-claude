/**
 * Task planner — handles /task commands with plan-then-execute pattern.
 * 1. Generates a step-by-step plan using one-shot Claude
 * 2. Executes each step with progress updates to WhatsApp
 * 3. Tracks task state for visibility
 */

import { chat, chatOneShot } from './claude.js';
import { buildHistoryForClaude } from './history.js';
import { createLogger } from './logger.js';
import { getState, setState } from './state.js';
import { smartIngest } from './mcp-gateway.js';
import { getTodayNotes, getNotesForDate } from './daily-notes.js';
import { listSkills } from './skills.js';
import { runWorkflow } from './workflow-engine.js';

const log = createLogger('task-planner');
const PLAN_TIMEOUT = 30_000; // 30s for planning
const STEP_TIMEOUT = 120_000; // 2min per step

/**
 * Parse a plan from Claude's response.
 * Expects numbered steps like "1. Do X\n2. Do Y\n3. Do Z"
 */
function parsePlan(text) {
  const steps = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)[.)]\s+(.+)/);
    if (match) {
      const desc = match[2].trim();
      const parallel = /\[PARALLEL\]/i.test(desc);
      steps.push({
        num: parseInt(match[1]),
        description: desc.replace(/\s*\[PARALLEL\]\s*/gi, '').trim(),
        parallel,
      });
    }
  }
  return steps;
}

/**
 * Execute a /task command with planning and step-by-step execution.
 * @param {string} taskDescription - The task description from /task <desc>
 * @param {Function} sendProgress - Async function to send progress messages to WhatsApp
 * @param {object} botContext - Bot context (jid, isMcpConnected, etc.)
 * @returns {object} { reply, steps, costUsd }
 */
export async function executeTask(taskDescription, sendProgress, botContext = {}) {
  const taskId = Date.now().toString(36);
  const taskStart = Date.now();
  let totalCost = 0;

  log.info({ taskId, desc: taskDescription.slice(0, 200) }, 'Task started');
  setState('active-task', { taskId, description: taskDescription, status: 'planning', startedAt: taskStart });

  // --- Step 1: Generate plan ---
  await sendProgress('_Planning task..._');

  const planPrompt = `You are a task planner. Break this task into 2-5 concrete steps. Each step should be a single action.
Return ONLY a numbered list like:
1. First step description
2. Second step description
3. Third step description

Task: ${taskDescription}

Important:
- Each step should be independently executable
- Be specific (not "check things" but "check cron job error logs")
- Max 5 steps. If the task is simple, 2-3 steps is fine.
- If steps can run in parallel (independent of each other), mark them with [PARALLEL] at the end
- Do NOT include explanation, just the numbered steps.`;

  let steps;
  try {
    const planTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Plan generation timed out')), PLAN_TIMEOUT)
    );
    const { reply: planText, costUsd: planCost } = await Promise.race([
      chatOneShot(planPrompt, null),
      planTimeout,
    ]);
    totalCost += planCost || 0;
    steps = parsePlan(planText);

    if (steps.length === 0) {
      // Couldn't parse plan — fall through to single-shot execution
      log.warn({ planText: planText.slice(0, 200) }, 'Could not parse plan, falling through to direct execution');
      steps = [{ num: 1, description: taskDescription }];
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Plan generation failed, using single step');
    steps = [{ num: 1, description: taskDescription }];
  }

  const stepList = steps.map(s => `${s.num}. ${s.description}`).join('\n');
  await sendProgress(`*Plan (${steps.length} steps):*\n${stepList}`);
  setState('active-task', { taskId, description: taskDescription, status: 'executing', steps: steps.length, startedAt: taskStart });

  // --- Step 2: Execute steps (parallel groups where possible) ---
  const results = [];
  let failedSteps = 0;

  // Group consecutive parallel steps into batches
  const batches = [];
  let currentBatch = [];
  for (const step of steps) {
    if (step.parallel && currentBatch.length > 0 && currentBatch[0].parallel) {
      currentBatch.push(step);
    } else {
      if (currentBatch.length > 0) batches.push(currentBatch);
      currentBatch = [step];
    }
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  const MAX_RETRIES = 1; // retry each step once on failure

  async function executeStep(step, stepNum, isLast, retryCount = 0) {
    const retryNote = retryCount > 0 ? `\n\nNOTE: Previous attempt failed. This is retry #${retryCount}. Try a different approach if needed.` : '';
    const stepPrompt = `Execute this step of a larger task:

Overall task: ${taskDescription}
Current step (${stepNum}/${steps.length}): ${step.description}
${results.length > 0 ? `\nPrevious steps completed:\n${results.map(r => `- ${r.step}: ${r.success ? 'OK' : 'FAILED'} — ${r.summary}`).join('\n')}` : ''}${retryNote}

Execute this step now. Be concise in your response — just report what you did and whether it worked.`;

    const { reply, costUsd } = await chatOneShot(stepPrompt, isLast ? botContext.onChunk : null);
    return { reply, costUsd };
  }

  async function executeStepWithRetry(step, stepNum, isLast) {
    try {
      return await executeStep(step, stepNum, isLast);
    } catch (err) {
      if (MAX_RETRIES > 0) {
        log.info({ taskId, stepNum, err: err.message }, 'Step failed, retrying');
        try {
          return await executeStep(step, stepNum, isLast, 1);
        } catch (retryErr) {
          throw retryErr; // retry also failed
        }
      }
      throw err;
    }
  }

  let stepCounter = 0;
  for (const batch of batches) {
    if (failedSteps > steps.length / 2) {
      await sendProgress(`_Task aborted after ${failedSteps} failures._`);
      break;
    }

    if (batch.length === 1) {
      // Sequential step
      const step = batch[0];
      stepCounter++;
      const isLast = stepCounter === steps.length;
      await sendProgress(`_Step ${stepCounter}/${steps.length}: ${step.description.slice(0, 80)}..._`);

      try {
        const { reply, costUsd } = await executeStepWithRetry(step, stepCounter, isLast);
        totalCost += costUsd || 0;
        results.push({ step: step.description, num: stepCounter, reply: reply.slice(0, 500), summary: reply.slice(0, 100), success: true });
        log.info({ taskId, stepNum: stepCounter, replyLen: reply.length }, 'Task step completed');
      } catch (err) {
        failedSteps++;
        results.push({ step: step.description, num: stepCounter, reply: err.message, summary: `Error: ${err.message.slice(0, 80)}`, success: false });
        log.warn({ taskId, stepNum: stepCounter, err: err.message }, 'Task step failed');
      }
    } else {
      // Parallel batch
      const batchStart = stepCounter + 1;
      const batchDesc = batch.map(s => s.description.slice(0, 40)).join(', ');
      await sendProgress(`_Steps ${batchStart}-${batchStart + batch.length - 1}/${steps.length} (parallel): ${batchDesc}..._`);

      const batchPromises = batch.map((step, idx) => {
        stepCounter++;
        const num = stepCounter;
        const isLast = num === steps.length;
        return executeStepWithRetry(step, num, isLast)
          .then(({ reply, costUsd }) => {
            totalCost += costUsd || 0;
            return { step: step.description, num, reply: reply.slice(0, 500), summary: reply.slice(0, 100), success: true };
          })
          .catch(err => {
            failedSteps++;
            return { step: step.description, num, reply: err.message, summary: `Error: ${err.message.slice(0, 80)}`, success: false };
          });
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      log.info({ taskId, batchSize: batch.length, succeeded: batchResults.filter(r => r.success).length }, 'Parallel batch completed');
    }
  }

  // --- Step 3: Summary with per-step results ---
  const succeeded = results.filter(r => r.success).length;
  const totalMs = Date.now() - taskStart;
  const stepSummaries = results.map(r =>
    `${r.success ? '\u2705' : '\u274c'} Step ${r.num}: ${r.summary.slice(0, 80)}`
  ).join('\n');
  const summary = `*Task complete* (${succeeded}/${steps.length} steps, ${(totalMs / 1000).toFixed(0)}s, $${totalCost.toFixed(4)})\n\n${stepSummaries}`;

  setState('active-task', {
    taskId, description: taskDescription, status: 'completed',
    steps: steps.length, succeeded, failed: failedSteps,
    durationMs: totalMs, costUsd: totalCost,
  });

  // Save task result to memory
  try {
    await smartIngest(
      `[task-complete] ${taskDescription} — ${succeeded}/${steps.length} steps succeeded`,
      ['task', 'auto-saved'],
      'fact',
      'task-planner'
    );
  } catch {}

  log.info({ taskId, succeeded, failed: failedSteps, totalMs, costUsd: totalCost.toFixed(4) }, 'Task completed');

  return {
    reply: summary,
    steps: results,
    costUsd: totalCost,
  };
}

/**
 * Execute a /task command as a workflow (persistent, survives restarts).
 * Falls back to executeTask() if workflow creation fails.
 */
export async function executeTaskAsWorkflow(taskDescription, sendProgress, botContext = {}) {
  const taskStart = Date.now();

  log.info({ desc: taskDescription.slice(0, 200) }, 'Task started (workflow mode)');
  await sendProgress('_Planning task..._');

  // Generate plan
  const planPrompt = `You are a task planner. Break this task into 2-5 concrete steps. Each step should be a single action.
Return ONLY a numbered list like:
1. First step description
2. Second step description
3. Third step description

Task: ${taskDescription}

Important:
- Each step should be independently executable
- Be specific (not "check things" but "check cron job error logs")
- Max 5 steps. If the task is simple, 2-3 steps is fine.
- Do NOT include explanation, just the numbered steps.`;

  let steps;
  try {
    const planTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Plan generation timed out')), PLAN_TIMEOUT)
    );
    const { reply: planText } = await Promise.race([
      chatOneShot(planPrompt, null),
      planTimeout,
    ]);
    steps = parsePlan(planText);
    if (steps.length === 0) steps = [{ num: 1, description: taskDescription }];
  } catch {
    steps = [{ num: 1, description: taskDescription }];
  }

  const stepList = steps.map(s => `${s.num}. ${s.description}`).join('\n');
  await sendProgress(`*Plan (${steps.length} steps):*\n${stepList}`);

  // Convert to workflow steps
  const wfSteps = steps.map((s, i) => ({
    id: `s${i + 1}`,
    type: 'claude',
    description: s.description,
    dependsOn: s.parallel && i > 0 ? steps[i - 1].parallel ? [`s${i}`] : [`s${i}`] : (i > 0 ? [`s${i}`] : []),
    config: {
      prompt: `Execute this step of a larger task:\n\nOverall task: ${taskDescription}\nCurrent step (${i + 1}/${steps.length}): ${s.description}\n\nExecute this step now. Be concise — just report what you did and whether it worked.`,
    },
  }));

  // Run as workflow
  const wf = runWorkflow(`Task: ${taskDescription.slice(0, 60)}`, wfSteps, {
    trigger: { type: 'chat', source: '/task' },
    notifyPolicy: 'verbose',
  });

  setState('active-task', {
    taskId: wf.id,
    description: taskDescription,
    status: 'executing',
    steps: steps.length,
    startedAt: taskStart,
    isWorkflow: true,
  });

  return { reply: `*Task running as workflow* (${wf.id})\nUse /wf status ${wf.id} to track progress.`, steps: [], costUsd: 0 };
}

/**
 * Get current active task status (for /tasks command).
 */
export function getActiveTask() {
  return getState('active-task');
}
