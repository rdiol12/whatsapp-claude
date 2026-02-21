/**
 * Agent Loop — Autonomous cycle with always-think + goal progression.
 *
 * Phase 1: Signal Collection (pure JS, zero LLM cost)
 *   13 signal types: stale/blocked goals, deadlines, failing crons,
 *   followups, cost spikes, memory pressure, MCP, errors, conversation
 *   gaps, stale memories, low-engagement crons, goal work.
 *
 * Phase 2: Claude Reasoning
 *   - Signal-driven: when signals found, investigate → decide → act → verify.
 *   - Reflection: every 3rd cycle with zero signals, spawns anyway to
 *     advance goals, plan, clean up, and self-initiate.
 *
 * Goal progression: active goals with pending milestones are injected as
 * signals and context. The agent can advance milestones, create goals,
 * and track its own effectiveness via agent-learning.js.
 *
 * Cost controls: daily budget cap, consecutive spawn backoff, queue slot sharing.
 * Timing: chained setTimeout (not setInterval) to prevent stacking.
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

const INTERVAL_MS = config.agentLoopInterval || 15 * 60_000;
const DAILY_BUDGET = config.agentLoopDailyBudget || 2;
const STATE_KEY = 'agent-loop';
const MAX_FOLLOWUPS = 5;
const BACKOFF_THRESHOLD = 8; // skip one cycle after this many consecutive spawns
const ALWAYS_THINK_EVERY = 3; // spawn Phase 2 every Nth cycle even with zero signals

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

  // 13. Goal work — pick top active goal with pending milestones to advance
  try {
    const workable = listGoals({ status: ['active', 'in_progress'] })
      .filter(g => g.milestones?.some(m => m.status === 'pending'))
      .sort((a, b) => {
        const prio = { critical: 0, high: 1, normal: 2, low: 3 };
        return (prio[a.priority] ?? 2) - (prio[b.priority] ?? 2);
      });
    if (workable.length > 0) {
      const g = workable[0];
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

  return `AGENT_CYCLE: ${dateStr} ${timeStr}${quiet ? ' (QUIET HOURS — do NOT send WhatsApp messages)' : ''}

You are running as an autonomous background agent for Ron. This is NOT a conversation — Ron is not watching. Use your tools silently.

## Detected signals (reason this cycle was triggered):
${signalBlock}
${goalsCtx ? `\n## Active goals (context):\n${goalsCtx}` : ''}

## Instructions — follow this chain:
1. **Investigate**: Use your tools to understand each signal (bot_goal_detail, bot_goal_list, bot_list_crons, etc.)
2. **Decide**: For each signal, decide if action is needed or if it can wait.
3. **Act**: Update goals, create workflows, fix issues, disable broken crons — whatever the signal calls for.
4. **Verify**: After acting, confirm the action worked (re-check status, re-read the goal, etc.)

Only message Ron if something genuinely needs his attention (overdue deadline, blocked goal needing human input, repeated cron failures).

## Output tags (wrap in XML — multiple allowed):
- <wa_message>text for Ron</wa_message> — sends WhatsApp message${quiet ? ' (SUPPRESSED during quiet hours)' : ''}
- <followup>topic to check next cycle</followup> — schedule for next cycle (max ${MAX_FOLLOWUPS})
- <next_cycle_minutes>N</next_cycle_minutes> — override default ${INTERVAL_MS / 60_000}min interval (5-120)
- <action_taken>description of what you did</action_taken> — log each action you take
- <goal_create title="Goal title">description of new goal</goal_create> — create a new goal (max 1 per cycle)

## Rules:
- Act via tools, don't narrate.
- No routine status updates — only genuinely important items.
- If nothing needs reporting, respond with: CYCLE_DONE
${learningBlock ? '\n' + learningBlock : ''}`;
}

function buildReflectionPrompt() {
  const now = israelNow();
  const timeStr = now.toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = now.toISOString().slice(0, 10);
  const quiet = isQuietHours();
  const goalsCtx = getGoalsContext();
  const learningBlock = getLearningContext();

  return `AGENT_REFLECTION: ${dateStr} ${timeStr}${quiet ? ' (QUIET HOURS — do NOT send WhatsApp messages)' : ''}

You are running as an autonomous background agent for Ron. No signals were detected, but this is a scheduled reflection cycle.

## Your job right now:
Think freely. No fires to put out — use this time productively.

${goalsCtx ? `## Active goals:\n${goalsCtx}\n` : ''}
## What you can do:
1. **Advance a goal**: Pick the most important active goal and work on its next milestone. Research, plan, update progress.
2. **Create a goal**: If you notice something Ron should be tracking, create one.
3. **Review & clean up**: Check if any goals are stale, redundant, or should be re-prioritized.
4. **Plan ahead**: Think about what Ron might need tomorrow or this week. Set up followups.
5. **Memory maintenance**: Search memories for stale or contradictory info to clean up.

## Output tags (wrap in XML — multiple allowed):
- <wa_message>text for Ron</wa_message> — sends WhatsApp message${quiet ? ' (SUPPRESSED during quiet hours)' : ''}
- <followup>topic to check next cycle</followup> — schedule for next cycle (max ${MAX_FOLLOWUPS})
- <next_cycle_minutes>N</next_cycle_minutes> — override default ${INTERVAL_MS / 60_000}min interval (5-120)
- <action_taken>description of what you did</action_taken> — log each action you take
- <goal_create title="Goal title">description of new goal</goal_create> — create a new goal (max 1 per cycle)

## Rules:
- Act via tools, don't narrate. Do real work.
- Don't message Ron unless you have something genuinely useful to say.
- If you truly find nothing to do, respond with: CYCLE_DONE
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

  log.info({ intervalMin: INTERVAL_MS / 60_000, dailyBudget: DAILY_BUDGET }, 'Agent loop started (two-phase)');
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
