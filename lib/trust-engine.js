/**
 * Trust Engine — Per-action-type trust scores with dynamic autonomy tiers.
 *
 * Trust = successRate * recencyBoost * volumeWeight
 *
 * Four autonomy tiers:
 * - Level 0 (trust < 0.3): Always ask permission
 * - Level 1 (0.3-0.6): Propose, auto-execute after 2min if no rejection
 * - Level 2 (0.6-0.8): Auto-execute, notify via Telegram
 * - Level 3 (trust > 0.8): Auto-execute silently (logged, reviewable)
 *
 * Hard ceiling: Destructive actions never exceed Level 1.
 *
 * Action types: send_message, create_cron, modify_cron, execute_tool,
 *               run_chain, modify_code, delete_data
 *
 * SQLite-backed for persistence across restarts.
 */

import { createLogger } from './logger.js';
import { getState, setState } from './state.js';
import config from './config.js';

const log = createLogger('trust-engine');
const STATE_KEY = 'trust-engine';

// Destructive action types that can never exceed Level 1
const DESTRUCTIVE_ACTIONS = new Set([
  'modify_code',
  'delete_data',
  'delete_cron',
  'force_push',
  'reset_session',
]);

// Autonomy tier boundaries
const TIERS = [
  { level: 0, min: 0, max: 0.3, label: 'ask_permission', description: 'Always ask permission' },
  { level: 1, min: 0.3, max: 0.6, label: 'propose', description: 'Propose, auto-execute after 2min' },
  { level: 2, min: 0.6, max: 0.8, label: 'auto_notify', description: 'Auto-execute, notify via Telegram' },
  { level: 3, min: 0.8, max: 1.0, label: 'auto_silent', description: 'Auto-execute silently' },
];

/**
 * Load trust data from state.
 */
function loadTrustData() {
  const state = getState(STATE_KEY);
  return state.actions || {};
}

/**
 * Save trust data to state.
 */
function saveTrustData(actions) {
  setState(STATE_KEY, { actions });
}

/**
 * Compute trust score for an action type.
 * trust = successRate * recencyBoost * volumeWeight
 *
 * @param {object} record - { successes, failures, total, lastSuccessAt, lastFailureAt }
 * @returns {number} Trust score 0-1
 */
function computeTrust(record) {
  if (!record || record.total === 0) return 0;

  const successRate = record.successes / record.total;

  // Recency boost: more recent successes count more
  const now = Date.now();
  const weekMs = 7 * 24 * 3600_000;
  const lastSuccess = record.lastSuccessAt || 0;
  const lastFailure = record.lastFailureAt || 0;

  // Boost if recent success, penalize if recent failure
  let recencyBoost = 1.0;
  if (lastSuccess > 0) {
    const successAge = (now - lastSuccess) / weekMs;
    recencyBoost += Math.max(0, 0.2 - successAge * config.trustDecayPerWeek);
  }
  if (lastFailure > 0 && lastFailure > lastSuccess) {
    // Recent failure penalizes more
    const failureAge = (now - lastFailure) / weekMs;
    recencyBoost -= Math.max(0, 0.3 - failureAge * 0.1);
  }
  recencyBoost = Math.max(0.5, Math.min(1.3, recencyBoost));

  // Volume weight: need minimum samples for high trust
  const minSamples = config.trustMinSamples || 5;
  const volumeWeight = Math.min(1.0, record.total / minSamples);

  return Math.min(1.0, Math.max(0, successRate * recencyBoost * volumeWeight));
}

/**
 * Get the autonomy level for an action type.
 * @param {string} actionType - e.g. 'send_message', 'execute_tool'
 * @returns {{ level: number, label: string, trust: number, canAutoExecute: boolean }}
 */
export function getAutonomyLevel(actionType) {
  if (!config.trustEngineEnabled) {
    // Default behavior when trust engine disabled: Level 1 for all
    return { level: 1, label: 'propose', trust: 0.5, canAutoExecute: false };
  }

  const actions = loadTrustData();
  const record = actions[actionType];
  const trust = computeTrust(record);

  // Find tier
  let tier = TIERS[0]; // default: ask permission
  for (const t of TIERS) {
    if (trust >= t.min && trust < t.max) {
      tier = t;
      break;
    }
    if (trust >= t.min) tier = t; // handle edge case for trust == 1.0
  }

  // Enforce destructive ceiling
  const maxLevel = DESTRUCTIVE_ACTIONS.has(actionType)
    ? (config.trustDestructiveMaxLevel || 1)
    : 3;
  const effectiveLevel = Math.min(tier.level, maxLevel);
  const effectiveTier = TIERS[effectiveLevel];

  return {
    level: effectiveLevel,
    label: effectiveTier.label,
    description: effectiveTier.description,
    trust: Math.round(trust * 1000) / 1000,
    canAutoExecute: effectiveLevel >= 2,
    record: record ? { total: record.total, successes: record.successes, failures: record.failures } : null,
  };
}

/**
 * Record an action outcome.
 * @param {string} actionType - Action type
 * @param {boolean} success - Whether it succeeded
 * @param {object} context - Optional context { reason, feedback }
 */
export function recordOutcome(actionType, success, context = {}) {
  const actions = loadTrustData();
  if (!actions[actionType]) {
    actions[actionType] = { successes: 0, failures: 0, total: 0, history: [] };
  }

  const record = actions[actionType];
  record.total++;
  if (success) {
    record.successes++;
    record.lastSuccessAt = Date.now();
  } else {
    record.failures++;
    record.lastFailureAt = Date.now();
  }

  // Keep last 50 outcomes for detailed analysis
  record.history = record.history || [];
  record.history.push({
    success,
    ts: Date.now(),
    reason: context.reason || null,
  });
  if (record.history.length > 50) {
    record.history = record.history.slice(-50);
  }

  saveTrustData(actions);
  log.info({
    actionType,
    success,
    trust: computeTrust(record).toFixed(3),
    total: record.total,
  }, 'Trust outcome recorded');
}

/**
 * Apply weekly trust decay to all action types.
 * Called from proactive maintenance.
 */
export function applyTrustDecay() {
  const actions = loadTrustData();
  const decay = config.trustDecayPerWeek || 0.05;

  for (const [actionType, record] of Object.entries(actions)) {
    if (record.total === 0) continue;

    // Decay by reducing success count slightly (simulates forgetting old data)
    const decayAmount = Math.ceil(record.total * decay);
    record.successes = Math.max(0, record.successes - Math.floor(decayAmount * 0.5));
    record.failures = Math.max(0, record.failures - Math.floor(decayAmount * 0.3));
    record.total = record.successes + record.failures;
  }

  saveTrustData(actions);
  log.info({ actionTypes: Object.keys(actions).length, decay }, 'Trust decay applied');
}

/**
 * Get trust report for all action types.
 * Returns sorted array of { actionType, trust, level, label, total, successRate }.
 */
export function getTrustReport() {
  const actions = loadTrustData();
  const report = [];

  for (const [actionType, record] of Object.entries(actions)) {
    const trust = computeTrust(record);
    const level = getAutonomyLevel(actionType);

    report.push({
      actionType,
      trust: Math.round(trust * 1000) / 1000,
      level: level.level,
      label: level.label,
      total: record.total,
      successes: record.successes,
      failures: record.failures,
      successRate: record.total > 0 ? Math.round(record.successes / record.total * 100) : 0,
      isDestructive: DESTRUCTIVE_ACTIONS.has(actionType),
    });
  }

  return report.sort((a, b) => b.trust - a.trust);
}

/**
 * Format trust report as human-readable text.
 */
export function formatTrustReport() {
  const report = getTrustReport();
  if (report.length === 0) return 'No trust data yet — agent needs more action outcomes.';

  const lines = ['*Trust Report*\n'];
  for (const r of report) {
    const bar = '█'.repeat(Math.round(r.trust * 10)) + '░'.repeat(10 - Math.round(r.trust * 10));
    const flag = r.isDestructive ? ' ⚠️' : '';
    lines.push(`${r.actionType}: ${bar} ${(r.trust * 100).toFixed(0)}% (L${r.level}) [${r.successes}/${r.total}]${flag}`);
  }

  lines.push('\n_Levels: L0=ask, L1=propose, L2=auto+notify, L3=auto+silent_');
  lines.push('_⚠️ = destructive (capped at L1)_');

  return lines.join('\n');
}

/**
 * Check if an action should auto-execute, propose, or require permission.
 * @param {string} actionType
 * @returns {'auto_execute'|'propose'|'ask_permission'}
 */
export function shouldAutoExecute(actionType) {
  const { level } = getAutonomyLevel(actionType);
  if (level >= 2) return 'auto_execute';
  if (level >= 1) return 'propose';
  return 'ask_permission';
}
