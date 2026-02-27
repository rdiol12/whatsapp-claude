/**
 * Chain Planner — Multi-step causal reasoning engine.
 *
 * Takes a goal + context and decomposes it into a workflow DAG compatible
 * with workflow-engine.js::createWorkflow(). Uses Haiku for cheap decomposition,
 * caches recurring chain templates to avoid repeat LLM calls.
 *
 * Chain templates are rule-based matching patterns:
 * - "meeting preparation" → check calendar → check files → draft → remind
 * - "deploy verification" → run tests → deploy → verify → notify
 *
 * For novel chains, uses a single Haiku one-shot to produce a step DAG.
 */

import { createLogger } from './logger.js';
import { chatOneShot } from './claude.js';
import { createWorkflow, startWorkflow } from './workflow-engine.js';
import { getState, setState } from './state.js';
import config from './config.js';

const log = createLogger('chain-planner');
const STATE_KEY = 'chain-planner';

// --- Built-in Chain Templates (rule-based, zero LLM cost) ---

const CHAIN_TEMPLATES = [
  {
    id: 'meeting_prep',
    triggers: /\b(meeting|appointment|call|zoom|teams)\b.*\b(prepare|prep|ready|slides|agenda)\b/i,
    name: 'Meeting Preparation',
    steps: [
      { id: 's1', type: 'tool', description: 'Check calendar for meeting details', config: { command: 'echo "Check google_calendar_list for upcoming meetings"' }, rollback: null },
      { id: 's2', type: 'claude', description: 'Check if related files/slides exist', config: { prompt: 'Search the workspace for any files related to this meeting. List what exists and what needs to be created.' }, dependsOn: ['s1'], rollback: null },
      { id: 's3', type: 'claude', description: 'Draft outline or agenda', config: { prompt: 'Based on the meeting details and existing files, draft an outline or agenda. {{context.s1}} {{context.s2}}' }, dependsOn: ['s2'], rollback: null },
      { id: 's4', type: 'delay', description: 'Wait until 2 hours before meeting', config: { durationMs: 7200_000 }, dependsOn: ['s3'], rollback: null },
      { id: 's5', type: 'claude', description: 'Send reminder with prep summary', config: { prompt: 'Send the user a WhatsApp reminder about the upcoming meeting with the prepared materials summary.' }, dependsOn: ['s4'], rollback: null },
    ],
  },
  {
    id: 'code_review',
    triggers: /\b(review|pr|pull request|code review)\b.*\b(check|look|examine|verify)\b/i,
    name: 'Code Review Chain',
    steps: [
      { id: 's1', type: 'tool', description: 'List open PRs', config: { command: 'gh pr list --limit 5 --json number,title,author' }, rollback: null },
      { id: 's2', type: 'claude', description: 'Analyze PR changes', config: { prompt: 'Review the open PRs and summarize key changes, potential issues, and recommendations. {{context.s1}}' }, dependsOn: ['s1'], rollback: null },
      { id: 's3', type: 'claude', description: 'Report findings to the user', config: { prompt: 'Send the user a concise code review summary via WhatsApp. {{context.s2}}' }, dependsOn: ['s2'], rollback: null },
    ],
  },
  {
    id: 'daily_planning',
    triggers: /\b(plan|schedule|organize)\b.*\b(day|today|morning|tasks)\b/i,
    name: 'Daily Planning',
    steps: [
      { id: 's1', type: 'tool', description: 'Check today\'s calendar', config: { command: 'echo "Use google_calendar_list with days=1"' }, rollback: null },
      { id: 's2', type: 'claude', description: 'Review active goals and priorities', config: { prompt: 'List active goals sorted by priority. Identify what should be worked on today. {{context.s1}}' }, dependsOn: ['s1'], rollback: null },
      { id: 's3', type: 'claude', description: 'Create daily plan', config: { prompt: 'Create a prioritized daily plan combining calendar events and goal milestones. Send to the user via WhatsApp. {{context.s2}}' }, dependsOn: ['s2'], rollback: null },
    ],
  },
  {
    id: 'email_digest',
    triggers: /\b(email|inbox|mail)\b.*\b(check|digest|summary|important)\b/i,
    name: 'Email Digest',
    steps: [
      { id: 's1', type: 'tool', description: 'Fetch recent emails', config: { command: 'echo "Use gmail_list with maxResults=20"' }, rollback: null },
      { id: 's2', type: 'claude', description: 'Categorize and summarize emails', config: { prompt: 'Categorize recent emails by urgency/importance. Summarize key items. {{context.s1}}' }, dependsOn: ['s1'], rollback: null },
      { id: 's3', type: 'claude', description: 'Report to the user', config: { prompt: 'Send the user a WhatsApp message with the email digest. Highlight action items. {{context.s2}}' }, dependsOn: ['s2'], rollback: null },
    ],
  },
  {
    id: 'health_check',
    triggers: /\b(health|status|system|monitor)\b.*\b(check|verify|audit|review)\b/i,
    name: 'System Health Check',
    steps: [
      { id: 's1', type: 'tool', description: 'Run health monitor', config: { command: 'node -e "import(\'./skills/health-monitor.js\').then(m => m.run().then(r => console.log(JSON.stringify(r))))"', cwd: config.dataDir + '/..' }, rollback: null },
      { id: 's2', type: 'claude', description: 'Analyze health results', config: { prompt: 'Analyze the system health results and identify any issues. {{context.s1}}' }, dependsOn: ['s1'], rollback: null },
      { id: 's3', type: 'conditional', description: 'Check if issues found', config: { condition: 'context.s2?.reply?.includes("issue") || context.s2?.reply?.includes("degraded") || context.s2?.reply?.includes("critical")', skipOnFalse: ['s4'] }, dependsOn: ['s2'], rollback: null },
      { id: 's4', type: 'claude', description: 'Alert the user about issues', config: { prompt: 'Send the user a WhatsApp alert about the system issues found. {{context.s2}}' }, dependsOn: ['s3'], rollback: null },
    ],
  },
];

/**
 * Match a goal description against chain templates.
 * Returns the first matching template or null.
 */
function matchTemplate(goalText) {
  for (const template of CHAIN_TEMPLATES) {
    if (template.triggers.test(goalText)) {
      return template;
    }
  }
  return null;
}

/**
 * Use Haiku to decompose a novel goal into workflow steps.
 * Returns steps array compatible with workflow-engine.
 */
async function decomposeWithLLM(goal, context = '') {
  const prompt = `You are a task decomposition engine. Break this goal into 3-6 sequential steps for an autonomous agent.

Goal: ${goal}
${context ? `Context: ${context}` : ''}

Return ONLY a JSON array of steps. Each step: { "id": "s1", "type": "claude"|"tool"|"delay"|"conditional", "description": "what to do", "config": { "prompt": "..." or "command": "..." }, "dependsOn": ["s0"], "rollback": "how to undo this step or null" }

Rules:
- Step IDs: s1, s2, s3, etc.
- First step has no dependencies. Others depend on previous step(s).
- Use "tool" type for commands, "claude" for reasoning/writing.
- Keep descriptions actionable and specific.
- Include rollback instructions for reversible steps (null for read-only steps).`;

  try {
    const { reply } = await chatOneShot(prompt, null, 'haiku');
    // Extract JSON array from response
    const jsonMatch = reply.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      log.warn({ goal, reply: reply.slice(0, 200) }, 'LLM decomposition returned no JSON array');
      return null;
    }

    let steps;
    try { steps = JSON.parse(jsonMatch[0]); } catch { return null; }
    if (!Array.isArray(steps) || steps.length === 0) return null;

    // Normalize steps
    return steps.map((s, i) => ({
      id: s.id || `s${i + 1}`,
      type: s.type || 'claude',
      description: s.description || `Step ${i + 1}`,
      config: s.config || { prompt: s.description },
      dependsOn: s.dependsOn || (i > 0 ? [`s${i}`] : []),
      rollback: s.rollback || null,
      maxRetries: 1,
    }));
  } catch (err) {
    log.error({ err: err.message, goal }, 'LLM decomposition failed');
    return null;
  }
}

/**
 * Plan a chain from a goal description. Tries template match first, falls back to LLM.
 * @param {string} goal - Natural language goal description
 * @param {string} context - Additional context (signals, active goals, etc.)
 * @returns {object|null} Workflow-compatible plan { name, steps, source }
 */
export async function planChain(goal, context = '') {
  // 1. Try template match (zero LLM cost)
  const template = matchTemplate(goal);
  if (template) {
    log.info({ templateId: template.id, goal: goal.slice(0, 100) }, 'Chain matched template');
    return {
      name: template.name,
      steps: template.steps.map(s => ({ ...s })), // deep copy
      source: `template:${template.id}`,
    };
  }

  // 2. Check cached templates (from previous LLM decompositions)
  const state = getState(STATE_KEY);
  const cachedTemplates = state.cachedTemplates || [];
  for (const ct of cachedTemplates) {
    if (ct.trigger && new RegExp(ct.trigger, 'i').test(goal)) {
      log.info({ cached: ct.name, goal: goal.slice(0, 100) }, 'Chain matched cached template');
      // Refresh hit count
      ct.hits = (ct.hits || 0) + 1;
      ct.lastUsed = Date.now();
      setState(STATE_KEY, { cachedTemplates });
      return {
        name: ct.name,
        steps: ct.steps.map(s => ({ ...s })),
        source: `cached:${ct.name}`,
      };
    }
  }

  // 3. Fall back to LLM decomposition
  const steps = await decomposeWithLLM(goal, context);
  if (!steps) return null;

  const plan = {
    name: goal.slice(0, 60),
    steps,
    source: 'llm',
  };

  // Cache this decomposition for future reuse (extract keywords as trigger)
  try {
    const keywords = goal.toLowerCase().match(/\b\w{4,}\b/g);
    if (keywords && keywords.length >= 2) {
      const trigger = keywords.slice(0, 4).join('.*');
      cachedTemplates.push({
        name: plan.name,
        trigger,
        steps,
        hits: 1,
        lastUsed: Date.now(),
        createdAt: Date.now(),
      });
      // Keep max 20 cached templates, evict least-used
      if (cachedTemplates.length > 20) {
        cachedTemplates.sort((a, b) => b.hits - a.hits);
        cachedTemplates.length = 20;
      }
      setState(STATE_KEY, { cachedTemplates });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to cache chain template');
  }

  return plan;
}

/**
 * Create and start a workflow from a chain plan.
 * @param {object} plan - { name, steps, source }
 * @param {object} opts - Workflow options (trigger, context, notifyPolicy)
 * @returns {object} The created workflow
 */
export function executeChain(plan, opts = {}) {
  if (!plan || !plan.steps || plan.steps.length === 0) {
    throw new Error('Invalid chain plan: no steps');
  }

  const wf = createWorkflow(plan.name, plan.steps, {
    trigger: { type: 'chain', source: plan.source || 'unknown' },
    context: opts.context || {},
    notifyPolicy: opts.notifyPolicy || 'summary',
    ...opts,
  });

  startWorkflow(wf.id);

  // Track chain creation
  const state = getState(STATE_KEY);
  const history = state.chainHistory || [];
  history.push({
    workflowId: wf.id,
    name: plan.name,
    source: plan.source,
    stepCount: plan.steps.length,
    createdAt: Date.now(),
  });
  if (history.length > 50) history.splice(0, history.length - 50);
  setState(STATE_KEY, { chainHistory: history });

  log.info({ wfId: wf.id, name: plan.name, steps: plan.steps.length, source: plan.source }, 'Chain started');
  return wf;
}

/**
 * Get chain planner statistics.
 */
export function getChainStats() {
  const state = getState(STATE_KEY);
  return {
    cachedTemplates: (state.cachedTemplates || []).length,
    builtInTemplates: CHAIN_TEMPLATES.length,
    totalChains: (state.chainHistory || []).length,
    recentChains: (state.chainHistory || []).slice(-5),
  };
}
