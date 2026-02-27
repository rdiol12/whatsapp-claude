/**
 * lib/agent-signals.js — Proactive signal detectors for agent-loop.
 *
 * Phase 1 signal detection functions that run zero-cost (no LLM) before
 * each agent cycle. Extracted from agent-loop.js for testability and
 * separation of concerns.
 *
 * Also exports shared time utilities (israelNow, isQuietHours, todayDateKey)
 * used across the agent-loop.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger.js';
import { listGoals, getUpcomingDeadlines } from './goals.js';
import { getErrors, kvGet, getDb } from './db.js';
import { alertCrash } from './notify.js';
import { getStaleT1Memories } from './memory-tiers.js';
import { getState } from './state.js';
import config from './config.js';
import { now } from './time.js';
import { getModuleSignalDetectors } from './module-loader.js';

const log = createLogger('agent-signals');

// ─── Time utilities ────────────────────────────────────────────────────────

export function israelNow() {
  return now();
}

export function isQuietHours() {
  const hour = israelNow().getHours();
  return hour >= config.quietStart || hour < config.quietEnd;
}

export function todayDateKey() {
  return israelNow().toISOString().slice(0, 10);
}

/**
 * @typedef {Object} Signal
 * @property {string} type - Signal category (e.g. 'goal_progress', 'error_spike', 'deadline_approaching')
 * @property {'critical'|'high'|'medium'|'low'} urgency - Priority level for agent-loop sorting
 * @property {string} summary - Human-readable description of the signal
 * @property {Object} [data] - Arbitrary payload relevant to the signal type
 */

// ─── Signal Detectors ──────────────────────────────────────────────────────

/**
 * Detect goals that recently completed milestones (within 2h).
 * Signals agent to verify, celebrate, and continue momentum.
 */
export function detectGoalProgressTriggers() {
  const signals = [];
  try {
    const twoHoursAgo = Date.now() - 2 * 3600_000;
    const goals = listGoals({ status: ['active', 'in_progress'] });
    for (const g of goals) {
      const recentDone = (g.milestones || []).filter(
        m => m.status === 'done' && m.completedAt && m.completedAt > twoHoursAgo
      );
      if (recentDone.length > 0) {
        signals.push({
          type: 'goal_progress',
          urgency: 'low',
          summary: `Goal "${g.title}" completed milestone "${recentDone[0].title}" recently — verify and continue`,
          data: { goalId: g.id, title: g.title, milestone: recentDone[0].title, completedAt: recentDone[0].completedAt },
        });
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: goal progress trigger check failed');
  }
  return signals;
}

/**
 * Detect anomalous patterns in recent cycle events (errors, backoffs).
 * Complements the error_spike signal with agent-loop-level anomalies.
 * @param {object} state - agent-loop state with recentEvents[]
 */
export function detectAnomalyTriggers(state) {
  const signals = [];
  try {
    const oneHourAgo = Date.now() - 3600_000;
    const recentErrors = (state.recentEvents || []).filter(
      e => e.event === 'agent:cycle:error' && e.ts > oneHourAgo
    );
    if (recentErrors.length >= 3) {
      signals.push({
        type: 'anomaly',
        urgency: 'high',
        summary: `${recentErrors.length} agent cycle errors in the last hour — something is broken`,
        data: { errorCount: recentErrors.length, window: '1h' },
      });
    } else if (recentErrors.length >= 2) {
      signals.push({
        type: 'anomaly',
        urgency: 'medium',
        summary: `${recentErrors.length} agent cycle errors in the last hour`,
        data: { errorCount: recentErrors.length, window: '1h' },
      });
    }
    // Detect repeated backoffs (agent is thrashing)
    const recentBackoffs = (state.recentEvents || []).filter(
      e => e.event === 'agent:cycle:skip' && e.data?.reason === 'backoff' && e.ts > oneHourAgo
    );
    if (recentBackoffs.length >= 2) {
      signals.push({
        type: 'anomaly',
        urgency: 'medium',
        summary: `Agent backoff triggered ${recentBackoffs.length} times in the last hour — costs may be high`,
        data: { backoffCount: recentBackoffs.length, window: '1h' },
      });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: anomaly trigger check failed');
  }
  return signals;
}

/**
 * Detect extended idle periods where agent hasn't spawned Claude.
 * Distinct from conversation_gap (user-side) — this is agent-side inactivity.
 * @param {object} state - agent-loop state with lastClaudeSpawnAt
 */
export function detectIdleTimeTriggers(state) {
  const signals = [];
  if (isQuietHours()) return signals; // expected to be idle during quiet hours
  try {
    const idleThresholdMs = 3 * 3600_000; // 3 hours
    const lastSpawn = state.lastClaudeSpawnAt;
    if (lastSpawn && (Date.now() - lastSpawn) >= idleThresholdMs) {
      const idleHours = Math.round((Date.now() - lastSpawn) / 3600_000);
      signals.push({
        type: 'idle_time',
        urgency: idleHours >= 6 ? 'medium' : 'low',
        summary: `Agent hasn't spawned Claude in ${idleHours}h — may be stuck or all signals are muted`,
        data: { idleHours, lastSpawnAt: lastSpawn },
      });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: idle time trigger check failed');
  }
  return signals;
}

/**
 * Detect error spikes using the SQLite errors table (hourly pattern analysis).
 * Compares this hour's error count vs the previous hour as a baseline.
 * Also sends a direct Telegram alert for critical spikes (1-hour cooldown).
 *
 * More accurate than in-memory detailedMetrics because:
 *   - Uses persistent SQLite data (survives agent restarts)
 *   - Compares to a real hourly baseline rather than an absolute threshold
 *   - Groups errors by module to identify the root cause
 *
 * @param {object} state - agent-loop state (mutates state.lastErrorSpikeAlertAt)
 */
/**
 * Detect chain opportunities: when multiple related signals fire together.
 * E.g., deadline + goal_work + stale_memory on same goal → chain instead of individual handling.
 * @param {Array} allSignals - All signals from current cycle
 */
export function detectChainOpportunities(allSignals) {
  const signals = [];
  if (allSignals.length < 3) return signals;

  try {
    // Group signals by related goal
    const goalSignals = {};
    for (const s of allSignals) {
      const goalId = s.data?.goalId || s.data?.goalTitle;
      if (goalId) {
        if (!goalSignals[goalId]) goalSignals[goalId] = [];
        goalSignals[goalId].push(s);
      }
    }

    // If 3+ signals relate to the same goal, suggest a chain
    for (const [goalId, related] of Object.entries(goalSignals)) {
      if (related.length >= 3) {
        const types = related.map(s => s.type).join(', ');
        signals.push({
          type: 'chain_opportunity',
          urgency: 'medium',
          summary: `Multiple related signals for goal "${goalId}": ${types} — consider handling as a chain workflow`,
          data: {
            goalId,
            relatedSignals: related.map(s => ({ type: s.type, urgency: s.urgency })),
            signalCount: related.length,
          },
        });
      }
    }

    // Detect deadline + goal_work combination
    const deadlineSignals = allSignals.filter(s => s.type === 'deadline_approaching');
    const goalWorkSignals = allSignals.filter(s => s.type === 'goal_work');
    if (deadlineSignals.length > 0 && goalWorkSignals.length > 0) {
      const alreadyChained = signals.some(s =>
        deadlineSignals.some(d => d.data?.goalId === s.data?.goalId)
      );
      if (!alreadyChained) {
        signals.push({
          type: 'chain_opportunity',
          urgency: 'medium',
          summary: `Deadline approaching with active goal work — consider a preparation chain`,
          data: {
            deadlines: deadlineSignals.map(s => s.data),
            goalWork: goalWorkSignals.map(s => s.data),
          },
        });
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: chain opportunity detection failed');
  }
  return signals;
}

/**
 * Detect self-improvement opportunities from error recovery patterns.
 * Fires when recurring error patterns have a clear improvement path.
 * Uses kvGet from db.js (already imported, sync, no circular deps).
 */
export function detectSelfImprovementOpportunities() {
  const signals = [];
  try {
    // kvGet is already imported from db.js (sync, better-sqlite3)
    const recoveryData = kvGet('error-recovery');
    if (!recoveryData) return signals;

    const patterns = recoveryData.errorPatterns || {};
    for (const [cause, data] of Object.entries(patterns)) {
      // Pattern with 5+ occurrences — likely automatable
      if (data.count >= 5) {
        signals.push({
          type: 'self_improvement_opportunity',
          urgency: 'low',
          summary: `Recurring error "${cause}" (${data.count}× in the last week) — may be automatable`,
          data: { rootCause: cause, count: data.count, firstSeen: data.firstSeen },
        });
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: self-improvement check failed');
  }
  return signals;
}

/**
 * Detect signal combinations that mean more together than individually.
 * Returns synthetic correlation signals representing compound situations.
 * Goal c758381b: Signal correlation.
 * @param {Array} signals - All signals collected so far in this cycle
 */
export function correlateSignals(signals) {
  const correlated = [];
  const types = new Set(signals.map(s => s.type));

  // stale_goal + conversation_gap → user disengaged (raise urgency, suggest outreach)
  if (types.has('stale_goal') && types.has('conversation_gap')) {
    correlated.push({
      type: 'user_disengaged',
      urgency: 'high',
      summary: 'User disengagement pattern: stale goals + conversation gap — consider proactive outreach',
      data: { correlatedTypes: ['stale_goal', 'conversation_gap'] },
    });
  }

  // memory_pressure + error_spike → single system incident (treat together, not separately)
  if (types.has('memory_pressure') && types.has('error_spike')) {
    correlated.push({
      type: 'system_incident',
      urgency: 'high',
      summary: 'System incident: memory pressure and error spike are likely related — investigate as one issue',
      data: { correlatedTypes: ['memory_pressure', 'error_spike'] },
    });
  }

  // cost_spike + high Sonnet call volume → escalate to auto-downgrade (goal c758381b)
  // Suppressed when COST_TRACKING=false (e.g. CLI subscription plan)
  if (types.has('cost_spike') && !config.costTrackingDisabled) {
    const costSignal = signals.find(s => s.type === 'cost_spike');
    const todayCount = costSignal?.data?.todayCount || 0;
    const todayUsd = costSignal?.data?.todayUsd || 0;
    // >15 API calls today is a proxy for heavy Sonnet usage → escalate urgency
    const sonnetHeavy = todayCount > 15;
    correlated.push({
      type: 'cost_downgrade_hint',
      urgency: sonnetHeavy ? 'high' : 'medium',
      summary: `Cost spike: $${todayUsd.toFixed(3)} today, ${todayCount} API calls${sonnetHeavy ? ' — heavy Sonnet usage, route to Haiku/Ollama' : ' — consider cheaper model'}`,
      data: { correlatedTypes: ['cost_spike'], todayCount, todayUsd, sonnetHeavy },
    });
  }

  return correlated;
}

/**
 * Detect recurring topic patterns in user messages (zero LLM cost).
 * If same topic keyword appears on 3+ different days in last 7 days, emit a signal.
 */
export function detectPatternObserved() {
  const signals = [];
  try {
    const db = getDb();
    const sevenDaysAgo = Date.now() - 7 * 86400_000;
    const rows = db.prepare(
      "SELECT content, ts FROM messages WHERE role = 'user' AND ts >= ? ORDER BY ts DESC LIMIT 200"
    ).all(sevenDaysAgo);

    if (rows.length < 10) return signals; // not enough data

    // Simple keyword frequency by day
    const topicDays = {}; // topic → Set<dateKey>
    const stopWords = new Set(['the', 'is', 'a', 'to', 'and', 'of', 'it', 'in', 'for', 'on', 'that', 'this', 'my', 'me', 'i', 'you', 'what', 'how', 'can', 'do', 'be', 'not', 'with']);

    for (const row of rows) {
      const day = new Date(row.ts).toISOString().slice(0, 10);
      const words = (row.content || '').toLowerCase().split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w));
      const uniqueWords = new Set(words);
      for (const w of uniqueWords) {
        if (!topicDays[w]) topicDays[w] = new Set();
        topicDays[w].add(day);
      }
    }

    // Find topics mentioned on 3+ different days
    for (const [topic, days] of Object.entries(topicDays)) {
      if (days.size >= 3) {
        signals.push({
          type: 'pattern_observed',
          urgency: 'low',
          summary: `Topic "${topic}" appeared on ${days.size} different days in the last week — consider creating a goal`,
          data: { topic, dayCount: days.size },
        });
      }
    }

    // Cap to top 3 by day count
    signals.sort((a, b) => b.data.dayCount - a.data.dayCount);
    return signals.slice(0, 3);
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: pattern observed check failed');
  }
  return signals;
}

/**
 * Detect workflows that have stalled (steps pending for 2+ hours or workflow exceeded maxDuration).
 * Uses listWorkflows + getWorkflow to inspect step timestamps.
 */
export function detectPlanStuck() {
  const signals = [];
  try {
    // Check for stalled workflows using a lightweight approach:
    // Read workflow JSON files directly to avoid circular imports.
    const wfDir = join(config.dataDir || '', 'workflows');
    let files;
    try { files = readdirSync(wfDir).filter(f => f.endsWith('.json')); } catch { return signals; }

    const stallThreshold = 2 * 3600_000; // 2 hours
    const now = Date.now();

    for (const file of files) {
      try {
        const wf = JSON.parse(readFileSync(join(wfDir, file), 'utf-8'));
        if (wf.status !== 'running') continue;

        const stalledSteps = [];
        for (const step of wf.steps || []) {
          if (step.status === 'running' && step.startedAt && (now - step.startedAt) > stallThreshold) {
            stalledSteps.push(step.id);
          }
        }

        // Check max duration (default 24h)
        const maxDuration = wf.maxDuration || 24 * 3600_000;
        const exceeded = (now - wf.createdAt) > maxDuration;

        if (stalledSteps.length > 0 || exceeded) {
          signals.push({
            type: 'plan_stuck',
            urgency: 'medium',
            summary: exceeded
              ? `Workflow "${wf.name}" exceeded max duration — consider pausing or cancelling`
              : `Workflow "${wf.name}" has ${stalledSteps.length} stalled step(s) — may need user input`,
            data: { wfId: wf.id, name: wf.name, stalledSteps, exceeded },
          });
        }
      } catch {}
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: plan stuck check failed');
  }
  return signals;
}

export function detectErrorSpikeSQLite(state) {
  const signals = [];
  try {
    const now = Date.now();
    const oneHourAgo = now - 3600_000;
    const twoHoursAgo = now - 7200_000;

    // Fetch last 2 hours of errors from SQLite (cap at 300 rows for performance)
    const allRecent = getErrors(300).filter(e => e.ts > twoHoursAgo);
    const thisHour = allRecent.filter(e => e.ts > oneHourAgo);
    const lastHour = allRecent.filter(e => e.ts <= oneHourAgo);

    const thisCount = thisHour.length;
    const lastCount = lastHour.length;

    // Compute spike ratio vs previous-hour baseline (floor at 1 to avoid div/0)
    const baselineRate = Math.max(lastCount, 1);
    const spikeRatio = thisCount / baselineRate;

    // Telegram alert cooldown: 1 hour between alerts
    const alertCooldownMs = 60 * 60_000;
    const canAlert = (now - (state.lastErrorSpikeAlertAt || 0)) > alertCooldownMs;

    if (thisCount >= 10 && spikeRatio >= 2) {
      // High urgency: 10+ errors AND doubled vs last hour — group by module
      const byModule = {};
      for (const e of thisHour) {
        byModule[e.module || 'unknown'] = (byModule[e.module || 'unknown'] || 0) + 1;
      }
      const topModule = Object.entries(byModule).sort(([, a], [, b]) => b - a)[0];
      const moduleInfo = topModule ? ` (top: ${topModule[0]}, ${topModule[1]}×)` : '';

      signals.push({
        type: 'error_spike',
        urgency: 'high',
        summary: `Error spike: ${thisCount} errors this hour vs ${lastCount} last hour (${spikeRatio.toFixed(1)}×)${moduleInfo}`,
        data: { thisHour: thisCount, lastHour: lastCount, spikeRatio: parseFloat(spikeRatio.toFixed(2)), byModule },
      });

      // Direct Telegram alert for critical spikes (not just a signal)
      if (canAlert) {
        alertCrash('error-spike', `${thisCount} errors in last hour (${spikeRatio.toFixed(1)}× spike)${moduleInfo}`);
        state.lastErrorSpikeAlertAt = now;
      }
    } else if (thisCount >= 5) {
      signals.push({
        type: 'error_spike',
        urgency: 'medium',
        summary: `${thisCount} errors in the last hour (vs ${lastCount} previous hour, ${spikeRatio.toFixed(1)}×)`,
        data: { thisHour: thisCount, lastHour: lastCount, spikeRatio: parseFloat(spikeRatio.toFixed(2)) },
      });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'detectErrorSpikeSQLite: SQLite check failed');
  }
  return signals;
}

/**
 * Detect signals from all loaded modules (e.g. Hattrick).
 * Module signal detectors are registered via lib/module-loader.js at startup.
 *
 * @param {object} state - agent-loop state
 */
export function detectModuleSignals(state) {
  const signals = [];
  for (const detect of getModuleSignalDetectors()) {
    try {
      const moduleSignals = detect(state);
      if (Array.isArray(moduleSignals)) signals.push(...moduleSignals);
    } catch (err) {
      log.warn({ err: err.message }, 'Module signal detection failed');
    }
  }
  return signals;
}

/**
 * Detect Hattrick transfer auctions with deadlines in the next 90 minutes.
 *
 * This fills a real gap: the agent had no dedicated signal for expiring
 * transfer auctions, causing deadlines to be missed (witnessed: Visnes
 * deadline passed while cycle was still analyzing; Weikun bid nearly missed).
 *
 * Urgency tiers:
 *   - HIGH:     deadline within 90 minutes — check and rebid if outbid
 *   - CRITICAL: deadline within 30 minutes — act immediately
 *
 * Reads kv_state key 'hattrick-transfer-watchlist'.
 */
export function detectTransferDeadlineUrgency() {
  const signals = [];
  try {
    const state = kvGet('hattrick-transfer-watchlist');
    if (!state) return signals;

    const items = Array.isArray(state.items) ? state.items : [];
    const nowMs = Date.now();
    const WINDOW_HIGH_MS     = 90 * 60 * 1000;  // 90 minutes
    const WINDOW_CRITICAL_MS = 30 * 60 * 1000;  // 30 minutes

    for (const it of items) {
      if (!it.deadline) continue;
      const deadlineMs = new Date(it.deadline).getTime();
      if (isNaN(deadlineMs) || deadlineMs <= nowMs) continue; // expired or unparseable
      const msLeft = deadlineMs - nowMs;
      if (msLeft > WINDOW_HIGH_MS) continue; // too far away — no signal yet

      const minutesLeft = Math.round(msLeft / 60000);
      const urgency = msLeft <= WINDOW_CRITICAL_MS ? 'critical' : 'high';
      const name = it.name || String(it.playerId || 'Unknown player');

      signals.push({
        type:    'transfer_deadline',
        urgency,
        summary: `Transfer deadline in ${minutesLeft}min: ${name} — check bid status and rebid if outbid`,
        data:    { playerName: name, minutesLeft, deadline: it.deadline, playerId: it.playerId },
      });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'detectTransferDeadlineUrgency: failed');
  }
  return signals;
}
