/**
 * Agent Learning — cycle outcome tracking + effectiveness analytics.
 *
 * Records what the agent loop does each cycle and whether its actions
 * (WhatsApp messages, followups) actually get engagement.
 * After 10+ cycles, injects self-correcting advice into the agent prompt.
 *
 * State: data/state/agent-learning.json via state.js
 */

import { getState, setState } from './state.js';
import { createLogger } from './logger.js';

const log = createLogger('agent-learning');
const STATE_KEY = 'agent-learning';
const MAX_CYCLES = 20;

// ─── State helpers ──────────────────────────────────────────────────────────

function loadLearning() {
  const raw = getState(STATE_KEY) || {};
  return {
    cycles: raw.cycles || [],
    messagesSent: raw.messagesSent || 0,
    messagesEngaged: raw.messagesEngaged || 0,
    followupsCreated: raw.followupsCreated || 0,
    followupsActed: raw.followupsActed || 0,
    followupsDiscarded: raw.followupsDiscarded || 0,
  };
}

function saveLearning(data) {
  setState(STATE_KEY, data);
}

// ─── Recording ──────────────────────────────────────────────────────────────

/**
 * Record the outcome of one agent cycle.
 * @param {object} data
 * @param {string[]} data.signalTypes - types of signals that triggered the cycle
 * @param {number} data.signalCount - total signals
 * @param {string[]} data.actionsTaken - descriptions from <action_taken> tags
 * @param {number} data.waMessageCount - WhatsApp messages sent
 * @param {number} data.followupCount - followups created
 * @param {number} data.costUsd - LLM cost
 * @param {boolean} data.spawned - whether Phase 2 ran (Claude was spawned)
 * @param {string|null} data.goalCreated - title of goal created, if any
 */
export function recordCycleOutcome(data) {
  const learning = loadLearning();

  learning.cycles.push({
    ts: Date.now(),
    signalTypes: data.signalTypes || [],
    signalCount: data.signalCount || 0,
    actionsTaken: data.actionsTaken || [],
    waMessageCount: data.waMessageCount || 0,
    followupCount: data.followupCount || 0,
    costUsd: data.costUsd || 0,
    spawned: data.spawned ?? true,
    goalCreated: data.goalCreated || null,
  });

  // Keep rolling window
  if (learning.cycles.length > MAX_CYCLES) {
    learning.cycles = learning.cycles.slice(-MAX_CYCLES);
  }

  learning.messagesSent += data.waMessageCount || 0;
  learning.followupsCreated += data.followupCount || 0;

  saveLearning(learning);
  log.debug({ signalCount: data.signalCount, actions: data.actionsTaken?.length || 0 }, 'Cycle outcome recorded');
}

/**
 * Track whether an agent-initiated WhatsApp message got a reply.
 * @param {boolean} gotResponse
 */
export function recordMessageEngagement(gotResponse) {
  const learning = loadLearning();
  if (gotResponse) learning.messagesEngaged++;
  saveLearning(learning);
}

/**
 * Track whether a followup from a previous cycle was acted on or discarded.
 * @param {'acted'|'discarded'} outcome
 */
export function recordFollowupOutcome(outcome) {
  const learning = loadLearning();
  if (outcome === 'acted') learning.followupsActed++;
  else if (outcome === 'discarded') learning.followupsDiscarded++;
  saveLearning(learning);
}

// ─── Analytics ──────────────────────────────────────────────────────────────

/**
 * Full effectiveness stats for dashboard / IPC.
 */
export function getEffectivenessStats() {
  const learning = loadLearning();
  const cycles = learning.cycles;
  const totalCycles = cycles.length;

  if (totalCycles === 0) {
    return {
      totalCycles: 0,
      spawnedCycles: 0,
      signalToActionRatio: 0,
      avgCostPerCycle: 0,
      totalCost: 0,
      engagementRate: null,
      followupEffectiveness: null,
      topSignalTypes: [],
      recentCycles: [],
    };
  }

  const spawnedCycles = cycles.filter(c => c.spawned).length;
  const totalSignals = cycles.reduce((s, c) => s + c.signalCount, 0);
  const totalActions = cycles.reduce((s, c) => s + (c.actionsTaken?.length || 0), 0);
  const totalCost = cycles.reduce((s, c) => s + (c.costUsd || 0), 0);

  // Signal type frequency
  const typeCounts = {};
  for (const c of cycles) {
    for (const t of c.signalTypes) {
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
  }
  const topSignalTypes = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  // Engagement rate (messages that got replies)
  const engagementRate = learning.messagesSent > 0
    ? Math.round((learning.messagesEngaged / learning.messagesSent) * 100)
    : null;

  // Followup effectiveness
  const followupTotal = learning.followupsActed + learning.followupsDiscarded;
  const followupEffectiveness = followupTotal > 0
    ? Math.round((learning.followupsActed / followupTotal) * 100)
    : null;

  return {
    totalCycles,
    spawnedCycles,
    signalToActionRatio: totalSignals > 0 ? parseFloat((totalActions / totalSignals).toFixed(2)) : 0,
    avgCostPerCycle: spawnedCycles > 0 ? parseFloat((totalCost / spawnedCycles).toFixed(4)) : 0,
    totalCost: parseFloat(totalCost.toFixed(4)),
    engagementRate,
    followupEffectiveness,
    topSignalTypes,
    recentCycles: cycles.slice(-5).reverse().map(c => ({
      ts: c.ts,
      signals: c.signalCount,
      actions: c.actionsTaken?.length || 0,
      cost: c.costUsd,
      msgs: c.waMessageCount,
      goalCreated: c.goalCreated,
    })),
  };
}

// ─── Prompt context (injected into agent prompt after 10+ cycles) ───────────

/**
 * Returns a compact string for agent prompt injection.
 * Empty string until 10+ cycles have been recorded.
 */
export function getLearningContext() {
  const stats = getEffectivenessStats();
  if (stats.totalCycles < 10) return '';

  const lines = [];
  lines.push('## Learning from past cycles');

  // Action ratio insight
  if (stats.signalToActionRatio < 0.3) {
    lines.push('- LOW action rate: most signals go unacted. Investigate more before skipping.');
  } else if (stats.signalToActionRatio > 1.5) {
    lines.push('- HIGH action rate: good investigation depth.');
  }

  // Cost insight
  if (stats.avgCostPerCycle > 0.15) {
    lines.push(`- HIGH avg cost per cycle ($${stats.avgCostPerCycle}). Be more focused.`);
  }

  // Engagement insight
  if (stats.engagementRate !== null) {
    if (stats.engagementRate < 30) {
      lines.push(`- LOW engagement (${stats.engagementRate}%): send fewer WhatsApp messages. Only message for truly urgent items.`);
    } else if (stats.engagementRate > 70) {
      lines.push(`- HIGH engagement (${stats.engagementRate}%): messages are well-targeted.`);
    }
  }

  // Followup insight
  if (stats.followupEffectiveness !== null && stats.followupEffectiveness < 30) {
    lines.push(`- LOW followup effectiveness (${stats.followupEffectiveness}%): create fewer, more targeted followups.`);
  }

  // Top signals
  if (stats.topSignalTypes.length > 0) {
    const top = stats.topSignalTypes.slice(0, 3).map(t => `${t.type}(${t.count})`).join(', ');
    lines.push(`- Most common signals: ${top}`);
  }

  return lines.length > 1 ? lines.join('\n') : '';
}
