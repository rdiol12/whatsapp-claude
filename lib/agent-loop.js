/**
 * Agent Loop — Fully autonomous cycle.
 *
 * Runs every 10min. 14 signal types + compound escalation.
 * Always-think: spawns Phase 2 every 2nd cycle even with zero signals.
 * Goal progression: advances milestones, creates goals, tracks effectiveness.
 * Time-aware: morning planning, evening review prompts.
 * Immediate re-cycle: 2min delay after productive cycles (2+ actions).
 * Compound signals: 3+ low signals escalate to medium.
 *
 * Cost controls: $3/day budget, backoff after 10 consecutive spawns.
 */

import { chatOneShot } from './claude.js';
import { createLogger } from './logger.js';
import { getState, setState } from './state.js';
import { listGoals, getStaleGoals, getUpcomingDeadlines, addGoal, getGoalsContext } from './goals.js';
import { listCrons } from './crons.js';
import { emit as wsEmit } from './ws-events.js';
import config from './config.js';
import { getCostOverview } from './cost-analytics.js';
import { getDetailedMetrics } from './metrics.js';
import { getMessages } from './history.js';
import { getConnectionStats as getMcpStats } from './mcp-gateway.js';
import { getStaleT1Memories } from './memory-tiers.js';
import { getLowEngagementCrons } from './outcome-tracker.js';
import { recordCycleOutcome, getLearningContext } from './agent-learning.js';

const log = createLogger('agent-loop');

const INTERVAL_MS = config.agentLoopInterval || 10 * 60_000;
const DAILY_BUDGET = config.agentLoopDailyBudget || 3;
const STATE_KEY = 'agent-loop';
const MAX_FOLLOWUPS = 5;
const BACKOFF_THRESHOLD = 10; // skip one cycle after this many consecutive spawns
const ALWAYS_THINK_EVERY = 2; // spawn Phase 2 every Nth cycle even with zero signals
const RECYCLE_DELAY_MS = 2 * 60_000; // immediate re-cycle after productive cycles

let cycleTimer = null;
let startupTimer = null;
let sendFn = null;
let queueRef = null;
let running = false;
let stopped = false;

// ─── Israel time helpers ────────────────────────────────────────────────────

function israelNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
}

function isQuietHours() {
  const hour = israelNow().getHours();
  return hour >= config.quietStart || hour < config.quietEnd;
}

function todayDateKey() {
  return israelNow().toISOString().slice(0, 10);
}

// ─── State management ───────────────────────────────────────────────────────

function loadState() {
  const raw = getState(STATE_KEY) || {};
  return {
    lastCycleAt: raw.lastCycleAt || null,
    lastClaudeSpawnAt: raw.lastClaudeSpawnAt || null,
    dailyCost: raw.dailyCost || 0,
    dailyCostDate: raw.dailyCostDate || todayDateKey(),
    cycleCount: raw.cycleCount || 0,
    consecutiveSpawns: raw.consecutiveSpawns || 0,
    pendingFollowups: raw.pendingFollowups || [],
    lastSignals: raw.lastSignals || [],
  };
}

function saveState(state) {
  setState(STATE_KEY, state);
}

function resetDailyBudgetIfNeeded(state) {
  const today = todayDateKey();
  if (state.dailyCostDate !== today) {
    state.dailyCost = 0;
    state.dailyCostDate = today;
  }
}

// ─── Phase 1: Signal Collection (pure JS, zero cost) ───────────────────────

function collectSignals(state) {
  const signals = [];

  // 1. Stale goals (in_progress but no activity for 48h)
  try {
    const stale = getStaleGoals(48);
    for (const g of stale) {
      const hoursSince = Math.round((Date.now() - g.updatedAt) / 3600_000);
      signals.push({
        type: 'stale_goal',
        urgency: hoursSince > 96 ? 'high' : 'medium',
        summary: `Goal "${g.title}" has had no activity for ${hoursSince}h`,
        data: { goalId: g.id, title: g.title, hoursSince },
      });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: stale goals check failed');
  }

  // 2. Blocked goals (status === 'blocked', 3+ days)
  try {
    const blocked = listGoals({ status: ['blocked'] });
    for (const g of blocked) {
      const daysSince = Math.round((Date.now() - g.updatedAt) / 86400_000);
      if (daysSince >= 3) {
        signals.push({
          type: 'blocked_goal',
          urgency: daysSince >= 7 ? 'high' : 'medium',
          summary: `Goal "${g.title}" has been blocked for ${daysSince} days`,
          data: { goalId: g.id, title: g.title, daysSince },
        });
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: blocked goals check failed');
  }

  // 3. Approaching deadlines (within 48h)
  try {
    const upcoming = getUpcomingDeadlines(2);
    for (const g of upcoming) {
      const hoursLeft = Math.round((new Date(g.deadline).getTime() - Date.now()) / 3600_000);
      signals.push({
        type: 'deadline_approaching',
        urgency: hoursLeft <= 24 ? 'high' : 'medium',
        summary: `Goal "${g.title}" deadline in ${hoursLeft}h`,
        data: { goalId: g.id, title: g.title, hoursLeft, deadline: g.deadline },
      });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: deadlines check failed');
  }

  // 4. Failing crons (3+ consecutive errors)
  try {
    const crons = listCrons();
    for (const c of crons) {
      if (c.enabled && c.state?.consecutiveErrors >= 3) {
        signals.push({
          type: 'failing_cron',
          urgency: c.state.consecutiveErrors >= 5 ? 'high' : 'medium',
          summary: `Cron "${c.name}" has failed ${c.state.consecutiveErrors} times in a row`,
          data: { cronId: c.id, name: c.name, errors: c.state.consecutiveErrors, lastStatus: c.state.lastStatus },
        });
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: crons check failed');
  }

  // 5. Pending follow-ups from previous cycles
  for (const f of state.pendingFollowups) {
    signals.push({
      type: 'followup',
      urgency: 'low',
      summary: `Follow-up from previous cycle: ${f.topic}`,
      data: { topic: f.topic, createdAt: f.createdAt },
    });
  }

  // 6. Cost spike (today vs daily average)
  try {
    const costs = getCostOverview();
    if (costs.dailyAvg > 0 && costs.today.total > 0) {
      const ratio = costs.today.total / costs.dailyAvg;
      if (ratio >= 3) {
        signals.push({ type: 'cost_spike', urgency: 'high', summary: `Today's cost $${costs.today.total.toFixed(2)} is ${ratio.toFixed(1)}x the daily avg ($${costs.dailyAvg.toFixed(2)})`, data: { todayCost: costs.today.total, dailyAvg: costs.dailyAvg, ratio } });
      } else if (ratio >= 2) {
        signals.push({ type: 'cost_spike', urgency: 'medium', summary: `Today's cost $${costs.today.total.toFixed(2)} is ${ratio.toFixed(1)}x the daily avg ($${costs.dailyAvg.toFixed(2)})`, data: { todayCost: costs.today.total, dailyAvg: costs.dailyAvg, ratio } });
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: cost spike check failed');
  }

  // Cache getDetailedMetrics() for signals 7 + 9
  let detailedMetrics = null;
  try {
    detailedMetrics = getDetailedMetrics();
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: failed to get detailed metrics');
  }

  // 7. Memory pressure (heap usage)
  if (detailedMetrics) {
    try {
      const heapMB = (detailedMetrics.heap_used || 0) / (1024 * 1024);
      if (heapMB >= 470) {
        signals.push({ type: 'memory_pressure', urgency: 'high', summary: `Heap usage ${Math.round(heapMB)}MB — nearing limit`, data: { heapMB: Math.round(heapMB) } });
      } else if (heapMB >= 420) {
        signals.push({ type: 'memory_pressure', urgency: 'medium', summary: `Heap usage ${Math.round(heapMB)}MB — elevated`, data: { heapMB: Math.round(heapMB) } });
      }
    } catch {}
  }

  // 8. MCP disconnected
  try {
    const mcpStats = getMcpStats();
    if (!mcpStats.connected) {
      const urgency = mcpStats.consecutiveFailures >= 3 ? 'high' : 'medium';
      signals.push({ type: 'mcp_disconnected', urgency, summary: `Vestige MCP disconnected (${mcpStats.consecutiveFailures} consecutive failures)`, data: { failures: mcpStats.consecutiveFailures } });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: MCP check failed');
  }

  // 9. Error spike (errors per hour)
  if (detailedMetrics) {
    try {
      const recentErrors = detailedMetrics.recent_errors || [];
      const oneHourAgo = Date.now() - 3600_000;
      const errorsLastHour = recentErrors.filter(e => e.ago_s != null && e.ago_s < 3600).length;
      if (errorsLastHour >= 10) {
        signals.push({ type: 'error_spike', urgency: 'high', summary: `${errorsLastHour} errors in the last hour`, data: { errorsLastHour } });
      } else if (errorsLastHour >= 5) {
        signals.push({ type: 'error_spike', urgency: 'medium', summary: `${errorsLastHour} errors in the last hour`, data: { errorsLastHour } });
      }
    } catch {}
  }

  // 10. Conversation gap (no messages for 18+ hours, outside quiet hours)
  if (!isQuietHours()) {
    try {
      const jid = config.allowedJid;
      const msgs = getMessages(jid);
      if (msgs.length > 0) {
        const lastMsg = msgs[msgs.length - 1];
        const hoursSince = (Date.now() - (lastMsg.ts || 0)) / 3600_000;
        if (hoursSince >= 18) {
          signals.push({ type: 'conversation_gap', urgency: 'low', summary: `No WhatsApp messages for ${Math.round(hoursSince)}h`, data: { hoursSince: Math.round(hoursSince) } });
        }
      }
    } catch (err) {
      log.warn({ err: err.message }, 'Signal collection: conversation gap check failed');
    }
  }

  // 11. Stale T1 memories (unaccessed 5+ days)
  try {
    const staleMemories = getStaleT1Memories(5, 3);
    for (const m of staleMemories) {
      const daysSince = Math.round((Date.now() - (m.lastAccessed || m.firstSeen)) / 86400_000);
      signals.push({ type: 'stale_memory', urgency: 'low', summary: `T1 memory "${(m.preview || m.id || '?').slice(0, 60)}" unaccessed for ${daysSince}d`, data: { memoryId: m.id, daysSince } });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: stale memory check failed');
  }

  // 12. Low engagement crons
  try {
    const lowCrons = getLowEngagementCrons();
    for (const c of lowCrons) {
      signals.push({ type: 'low_engagement_cron', urgency: 'low', summary: `Cron "${c.cronName}" has ${c.engagementRate}% engagement after ${c.deliveries} deliveries`, data: { cronName: c.cronName, rate: c.engagementRate, deliveries: c.deliveries } });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: low engagement cron check failed');
  }

  // 13. Goal work — pick top 2 active goals with pending milestones to advance
  try {
    const workable = listGoals({ status: ['active', 'in_progress'] })
      .filter(g => g.milestones?.some(m => m.status === 'pending'))
      .sort((a, b) => {
        const prio = { critical: 0, high: 1, normal: 2, low: 3 };
        return (prio[a.priority] ?? 2) - (prio[b.priority] ?? 2);
      });
    for (const g of workable.slice(0, 2)) {
      const nextMs = g.milestones.find(m => m.status === 'pending');
      signals.push({
        type: 'goal_work',
        urgency: g.priority === 'critical' || g.priority === 'high' ? 'medium' : 'low',
        summary: `Goal "${g.title}" (${g.progress}%) — next milestone: "${nextMs.title}"`,
        data: { goalId: g.id, title: g.title, progress: g.progress, nextMilestone: nextMs.title },
      });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: goal work check failed');
  }

  // 14. Compound signal escalation — 3+ low signals → add a medium compound
  const lowCount = signals.filter(s => s.urgency === 'low').length;
  if (lowCount >= 3) {
    signals.push({
      type: 'compound',
      urgency: 'medium',
      summary: `${lowCount} low-priority signals accumulated — worth investigating together`,
      data: { lowCount },
    });
  }

  return signals;
}

// ─── Phase 2: Claude Reasoning ──────────────────────────────────────────────

function buildAgentPrompt(signals) {
  const now = israelNow();
  const timeStr = now.toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = now.toISOString().slice(0, 10);
  const quiet = isQuietHours();

  const signalBlock = signals.map((s, i) => {
    const urgencyTag = s.urgency === 'high' ? ' [HIGH]' : s.urgency === 'medium' ? ' [MED]' : '';
    return `${i + 1}. [${s.type}]${urgencyTag} ${s.summary}`;
  }).join('\n');

  const learningBlock = getLearningContext();
  const goalsCtx = getGoalsContext();
  const hour = now.getHours();
  const timeContext = hour >= 8 && hour < 11 ? 'MORNING — good time to plan the day, set priorities, message Ron with a brief plan if useful.'
    : hour >= 21 && hour < 23 ? 'EVENING — good time to review what happened today, summarize progress, prep for tomorrow.'
    : '';

  return `AGENT_CYCLE: ${dateStr} ${timeStr}${quiet ? ' (QUIET HOURS — do NOT send WhatsApp messages)' : ''}
${timeContext ? `[${timeContext}]\n` : ''}
You are Ron's autonomous agent. You have initiative — use it. Don't wait for permission. If something needs doing, do it now.

## Detected signals:
${signalBlock}
${goalsCtx ? `\n## Active goals:\n${goalsCtx}` : ''}

## Instructions — Investigate → Decide → Act → Verify:
1. **Investigate**: Use tools to understand each signal deeply. Don't just glance — dig in.
2. **Decide**: What needs action NOW vs what can wait? Bias toward action.
3. **Act**: Update goals, advance milestones, create workflows, fix crons, clean up memories. Do multiple things if needed.
4. **Verify**: Confirm your actions worked. Re-check after changing state.

After handling signals, if you still have budget: pick an active goal and advance it.

## Output tags (XML, multiple allowed):
- <wa_message>text</wa_message> — message Ron${quiet ? ' (SUPPRESSED — quiet hours)' : ''}
- <followup>topic</followup> — check next cycle (max ${MAX_FOLLOWUPS})
- <next_cycle_minutes>N</next_cycle_minutes> — override interval (5-120, default ${INTERVAL_MS / 60_000})
- <action_taken>what you did</action_taken> — log every action
- <goal_create title="Title">description</goal_create> — create a goal (max 1/cycle)

## Rules:
- Be proactive. Take initiative. Do real work, not narration.
- Multiple actions per cycle is good — don't stop after one.
- Message Ron when something is useful, not just urgent.
- CYCLE_DONE only if genuinely nothing to do.
${learningBlock ? '\n' + learningBlock : ''}`;
}

function buildReflectionPrompt() {
  const now = israelNow();
  const timeStr = now.toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = now.toISOString().slice(0, 10);
  const quiet = isQuietHours();
  const goalsCtx = getGoalsContext();
  const learningBlock = getLearningContext();

  const hour = now.getHours();
  const timeContext = hour >= 8 && hour < 11 ? 'MORNING — plan the day, set priorities, give Ron a brief heads-up if useful.'
    : hour >= 21 && hour < 23 ? 'EVENING — review today, summarize progress, prep for tomorrow.'
    : '';

  return `AGENT_REFLECTION: ${dateStr} ${timeStr}${quiet ? ' (QUIET HOURS — do NOT send WhatsApp messages)' : ''}
${timeContext ? `[${timeContext}]\n` : ''}
You are Ron's autonomous agent. No signals fired — this is your free time. Use it well. Don't say CYCLE_DONE unless you've actually checked everything.

${goalsCtx ? `## Active goals:\n${goalsCtx}\n` : ''}
## Your checklist (do at least 2):
1. **Advance a goal**: Pick the highest-priority active goal. Work on its next milestone — research, plan, update progress, complete it if possible.
2. **Create a goal**: Notice something Ron should track? A project with no goal? A recurring issue? Create one.
3. **Review & reprioritize**: Are any goals stale, blocked without reason, or redundant? Fix them.
4. **Plan ahead**: What will Ron need this week? Upcoming deadlines? Create followups.
5. **Memory work**: Search Vestige for stale, contradictory, or duplicate memories. Clean up.
6. **Cron audit**: Any crons with low engagement or repeated failures? Disable or fix them.

## Output tags (XML, multiple allowed):
- <wa_message>text</wa_message> — message Ron${quiet ? ' (SUPPRESSED — quiet hours)' : ''}
- <followup>topic</followup> — check next cycle (max ${MAX_FOLLOWUPS})
- <next_cycle_minutes>N</next_cycle_minutes> — override interval (5-120, default ${INTERVAL_MS / 60_000})
- <action_taken>what you did</action_taken> — log every action
- <goal_create title="Title">description</goal_create> — create a goal (max 1/cycle)

## Rules:
- Take initiative. You're not waiting for instructions — you ARE the initiative.
- Multiple actions per cycle is expected. Do at least 2 things from the checklist.
- Message Ron with useful info, not just emergencies. A morning plan or evening summary is welcome.
- CYCLE_DONE only after genuinely exhausting the checklist.
${learningBlock ? '\n' + learningBlock : ''}`;
}

function parseAgentResponse(reply) {
  const result = {
    waMessages: [],
    followups: [],
    nextCycleMinutes: null,
    actionsTaken: [],
    goalCreates: [],
  };

  // Extract ALL <wa_message> blocks
  for (const m of reply.matchAll(/<wa_message>([\s\S]*?)<\/wa_message>/g)) {
    const msg = m[1].trim();
    if (msg) result.waMessages.push(msg);
  }

  // Extract follow-ups
  for (const m of reply.matchAll(/<followup>([\s\S]*?)<\/followup>/g)) {
    const topic = m[1].trim();
    if (topic) result.followups.push({ topic, createdAt: Date.now() });
  }

  // Extract adaptive timing
  const timingMatch = reply.match(/<next_cycle_minutes>(\d+)<\/next_cycle_minutes>/);
  if (timingMatch) {
    const mins = parseInt(timingMatch[1], 10);
    if (mins >= 5 && mins <= 120) result.nextCycleMinutes = mins;
  }

  // Extract action descriptions
  for (const m of reply.matchAll(/<action_taken>([\s\S]*?)<\/action_taken>/g)) {
    const action = m[1].trim();
    if (action) result.actionsTaken.push(action);
  }

  // Extract goal creation requests
  for (const m of reply.matchAll(/<goal_create\s+title="([^"]*)">([\s\S]*?)<\/goal_create>/g)) {
    const title = m[1].trim();
    const description = m[2].trim();
    if (title) result.goalCreates.push({ title, description });
  }

  return result;
}

// ─── Run one cycle ──────────────────────────────────────────────────────────

async function runAgentCycle() {
  if (running) {
    log.warn('Agent cycle skipped — previous cycle still running');
    return;
  }
  if (stopped) return;

  running = true;
  const state = loadState();
  resetDailyBudgetIfNeeded(state);
  state.cycleCount++;

  let nextIntervalMs = INTERVAL_MS;

  try {
    wsEmit('agent:cycle:start', { cycleCount: state.cycleCount });

    // ── Phase 1: Signal Collection ──
    const signals = collectSignals(state);
    state.lastSignals = signals.map(s => ({ type: s.type, urgency: s.urgency, summary: s.summary }));
    state.lastCycleAt = Date.now();

    wsEmit('agent:cycle:signals', { signalCount: signals.length, signals: state.lastSignals });

    // Always-think: every Nth cycle, spawn Phase 2 even with zero signals
    const isReflectionCycle = signals.length === 0 && (state.cycleCount % ALWAYS_THINK_EVERY === 0);

    if (signals.length === 0 && !isReflectionCycle) {
      state.consecutiveSpawns = 0;
      saveState(state);
      wsEmit('agent:cycle:skip', { reason: 'no_signals' });
      log.info({ cycleCount: state.cycleCount }, 'Agent cycle: no signals, skipping Phase 2');
      return;
    }

    if (isReflectionCycle) {
      log.info({ cycleCount: state.cycleCount }, 'Agent cycle: reflection cycle (always-think), entering Phase 2');
    } else {
      log.info({ signals: signals.length, types: signals.map(s => s.type) }, 'Agent cycle: signals detected, entering Phase 2');
    }

    // ── Guards before Phase 2 ──

    // Daily budget check
    if (state.dailyCost >= DAILY_BUDGET) {
      log.warn({ dailyCost: state.dailyCost.toFixed(2), budget: DAILY_BUDGET }, 'Agent cycle: daily budget exhausted, skipping Phase 2');
      wsEmit('agent:cycle:skip', { reason: 'budget_exhausted' });
      saveState(state);
      return;
    }

    // Consecutive spawn backoff
    if (state.consecutiveSpawns >= BACKOFF_THRESHOLD) {
      log.warn({ consecutiveSpawns: state.consecutiveSpawns }, 'Agent cycle: backoff — skipping one cycle');
      wsEmit('agent:cycle:skip', { reason: 'backoff' });
      state.consecutiveSpawns = 0;
      saveState(state);
      return;
    }

    // ── Phase 2: Claude Reasoning ──

    // Acquire queue slot (share concurrency with WhatsApp)
    if (queueRef) {
      log.info('Agent cycle: waiting for queue slot');
      await queueRef.acquireSlot();
    }

    let reply, costUsd;
    try {
      const prompt = isReflectionCycle ? buildReflectionPrompt() : buildAgentPrompt(signals);
      wsEmit('agent:cycle:phase2', { signalCount: signals.length, promptLen: prompt.length, reflection: isReflectionCycle });
      ({ reply, costUsd } = await chatOneShot(prompt, null));
      costUsd = costUsd || 0;
    } finally {
      if (queueRef) queueRef.releaseSlot();
    }

    // Update state
    state.lastClaudeSpawnAt = Date.now();
    state.dailyCost += costUsd;
    state.consecutiveSpawns++;

    log.info({ replyLen: reply.length, costUsd: costUsd.toFixed(4), dailyCost: state.dailyCost.toFixed(2) }, 'Agent cycle Phase 2 complete');

    // Parse response
    const parsed = parseAgentResponse(reply);

    // Send WhatsApp messages (suppress during quiet hours)
    const quiet = isQuietHours();
    for (const msg of parsed.waMessages) {
      if (quiet) {
        log.info({ msgLen: msg.length }, 'Agent cycle: WhatsApp message suppressed (quiet hours)');
      } else if (sendFn) {
        await sendFn(msg);
        log.info({ msgLen: msg.length }, 'Agent cycle: sent WhatsApp message');
      }
    }

    // Store follow-ups (cap at MAX_FOLLOWUPS, newest first)
    state.pendingFollowups = parsed.followups.slice(0, MAX_FOLLOWUPS);

    // Log actions taken
    if (parsed.actionsTaken.length > 0) {
      log.info({ actions: parsed.actionsTaken }, 'Agent cycle: actions taken');
      wsEmit('agent:cycle:actions', { actions: parsed.actionsTaken });
    }

    // Create goal from first <goal_create> tag (max 1 per cycle, max 5 agent goals active)
    let goalCreatedTitle = null;
    if (parsed.goalCreates.length > 0) {
      try {
        const agentGoals = listGoals({ status: ['active', 'in_progress'] }).filter(g => g.source === 'agent');
        if (agentGoals.length < 5) {
          const gc = parsed.goalCreates[0];
          const newGoal = addGoal(gc.title, { description: gc.description, source: 'agent' });
          goalCreatedTitle = gc.title;
          log.info({ goalId: newGoal.id, title: gc.title }, 'Agent cycle: goal created');
          wsEmit('agent:cycle:goal_created', { goalId: newGoal.id, title: gc.title });
        } else {
          log.info('Agent cycle: skipped goal creation — 5 agent goals already active');
        }
      } catch (err) {
        log.warn({ err: err.message }, 'Agent cycle: goal creation failed');
      }
    }

    // Record learning outcome
    try {
      recordCycleOutcome({
        signalTypes: signals.map(s => s.type),
        signalCount: signals.length,
        actionsTaken: parsed.actionsTaken,
        waMessageCount: parsed.waMessages.length,
        followupCount: parsed.followups.length,
        costUsd,
        spawned: true,
        goalCreated: goalCreatedTitle,
      });
    } catch (err) {
      log.warn({ err: err.message }, 'Agent cycle: failed to record learning outcome');
    }

    // Adaptive timing
    if (parsed.nextCycleMinutes) {
      nextIntervalMs = parsed.nextCycleMinutes * 60_000;
      log.info({ nextCycleMinutes: parsed.nextCycleMinutes }, 'Agent cycle: adaptive timing');
    } else if (parsed.actionsTaken.length >= 2 || parsed.goalCreates.length > 0) {
      // Productive cycle — re-cycle quickly to verify and continue
      nextIntervalMs = RECYCLE_DELAY_MS;
      log.info({ actionCount: parsed.actionsTaken.length }, 'Agent cycle: productive — re-cycling in 2min');
    }

    saveState(state);
    wsEmit('agent:cycle:complete', {
      costUsd, waMessageCount: parsed.waMessages.length,
      followupCount: parsed.followups.length,
      actionCount: parsed.actionsTaken.length,
      goalCreated: goalCreatedTitle,
      nextCycleMinutes: parsed.nextCycleMinutes || INTERVAL_MS / 60_000,
    });
    log.info('Agent cycle complete');
  } catch (err) {
    wsEmit('agent:cycle:error', { error: err.message });
    log.warn({ err: err.message }, 'Agent cycle failed');
    saveState(state);
  } finally {
    running = false;
    scheduleNext(nextIntervalMs);
  }
}

// ─── Scheduling (chained setTimeout, not setInterval) ───────────────────────

function scheduleNext(delayMs) {
  if (stopped) return;
  cycleTimer = setTimeout(() => {
    cycleTimer = null;
    runAgentCycle().catch(err => log.error({ err: err.message }, 'Agent cycle unhandled error'));
  }, delayMs);
  cycleTimer.unref();
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startAgentLoop(send, queue) {
  sendFn = send;
  queueRef = queue || null;
  stopped = false;

  // First cycle after 2 minutes (let the bot stabilize)
  startupTimer = setTimeout(() => {
    startupTimer = null;
    runAgentCycle().catch(err => log.error({ err: err.message }, 'Agent cycle startup error'));
  }, 2 * 60_000);
  startupTimer.unref();

  log.info({ intervalMin: INTERVAL_MS / 60_000, dailyBudget: DAILY_BUDGET, alwaysThinkEvery: ALWAYS_THINK_EVERY }, 'Agent loop started (autonomous)');
}

export function stopAgentLoop() {
  stopped = true;
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (cycleTimer) {
    clearTimeout(cycleTimer);
    cycleTimer = null;
  }
  log.info('Agent loop stopped');
}

export function getAgentLoopStatus() {
  const state = loadState();
  return {
    running: !stopped && (startupTimer !== null || cycleTimer !== null),
    cycleRunning: running,
    lastCycleAt: state.lastCycleAt ? new Date(state.lastCycleAt).toISOString() : null,
    lastClaudeSpawnAt: state.lastClaudeSpawnAt ? new Date(state.lastClaudeSpawnAt).toISOString() : null,
    intervalMin: INTERVAL_MS / 60_000,
    dailyBudget: DAILY_BUDGET,
    dailyCost: state.dailyCost?.toFixed(2) || '0.00',
    cycleCount: state.cycleCount || 0,
    consecutiveSpawns: state.consecutiveSpawns || 0,
    pendingFollowups: state.pendingFollowups?.length || 0,
    lastSignals: state.lastSignals || [],
    mode: 'autonomous',
  };
}

export function getAgentLoopDetail() {
  const state = loadState();
  return {
    ...getAgentLoopStatus(),
    pendingFollowups: state.pendingFollowups || [],
    lastSignals: state.lastSignals || [],
  };
}
