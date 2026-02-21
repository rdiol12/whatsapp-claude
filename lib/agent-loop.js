/**
 * Agent Loop — Two-Phase autonomous cycle.
 *
 * Phase 1: Signal Collection (pure JS, zero LLM cost)
 *   Checks stale goals, blocked goals, approaching deadlines,
 *   failing crons, and pending follow-ups from previous cycles.
 *   If no signals → log + skip. No Claude spawn.
 *
 * Phase 2: Claude Reasoning (only when signals found)
 *   Focused prompt with ONLY the detected signals.
 *   Claude has full MCP tool access (bot-ops + vestige).
 *   Supports <wa_message>, <followup>, <next_cycle_minutes> output tags.
 *
 * Cost controls: daily budget cap, consecutive spawn backoff, queue slot sharing.
 * Timing: chained setTimeout (not setInterval) to prevent stacking.
 */

import { chatOneShot } from './claude.js';
import { createLogger } from './logger.js';
import { getState, setState } from './state.js';
import { listGoals, getStaleGoals, getUpcomingDeadlines } from './goals.js';
import { listCrons } from './crons.js';
import { emit as wsEmit } from './ws-events.js';
import config from './config.js';

const log = createLogger('agent-loop');

const INTERVAL_MS = config.agentLoopInterval || 15 * 60_000;
const DAILY_BUDGET = config.agentLoopDailyBudget || 2;
const STATE_KEY = 'agent-loop';
const MAX_FOLLOWUPS = 5;
const BACKOFF_THRESHOLD = 5; // skip one cycle after this many consecutive spawns

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

  return `AGENT_CYCLE: ${dateStr} ${timeStr}${quiet ? ' (QUIET HOURS — do NOT send WhatsApp messages)' : ''}

You are running as an autonomous background agent for Ron. This is NOT a conversation — Ron is not watching. Use your tools silently.

## Detected signals (reason this cycle was triggered):
${signalBlock}

## Instructions:
1. Investigate the signals above using your tools (bot_goal_detail, bot_goal_list, bot_list_crons, etc.)
2. Take action where appropriate: update goals, create workflows, fix issues.
3. Only message Ron if something genuinely needs his attention (overdue deadline, blocked goal needing human input, repeated cron failures).

## Output tags (wrap in XML — multiple allowed):
- <wa_message>text for Ron</wa_message> — sends WhatsApp message${quiet ? ' (SUPPRESSED during quiet hours)' : ''}
- <followup>topic to check next cycle</followup> — schedule for next cycle (max ${MAX_FOLLOWUPS})
- <next_cycle_minutes>N</next_cycle_minutes> — override default ${INTERVAL_MS / 60_000}min interval (5-120)

## Rules:
- Act via tools, don't narrate.
- No routine status updates — only genuinely important items.
- If nothing needs reporting, respond with: CYCLE_DONE`;
}

function parseAgentResponse(reply) {
  const result = {
    waMessages: [],
    followups: [],
    nextCycleMinutes: null,
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

    if (signals.length === 0) {
      state.consecutiveSpawns = 0;
      saveState(state);
      wsEmit('agent:cycle:skip', { reason: 'no_signals' });
      log.info({ cycleCount: state.cycleCount }, 'Agent cycle: no signals, skipping Phase 2');
      return;
    }

    log.info({ signals: signals.length, types: signals.map(s => s.type) }, 'Agent cycle: signals detected, entering Phase 2');

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
      const prompt = buildAgentPrompt(signals);
      wsEmit('agent:cycle:phase2', { signalCount: signals.length, promptLen: prompt.length });
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

    // Adaptive timing
    if (parsed.nextCycleMinutes) {
      nextIntervalMs = parsed.nextCycleMinutes * 60_000;
      log.info({ nextCycleMinutes: parsed.nextCycleMinutes }, 'Agent cycle: adaptive timing');
    }

    saveState(state);
    wsEmit('agent:cycle:complete', {
      costUsd, waMessageCount: parsed.waMessages.length,
      followupCount: parsed.followups.length,
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
    mode: 'two-phase',
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
