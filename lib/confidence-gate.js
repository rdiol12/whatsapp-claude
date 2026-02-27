/**
 * Confidence Gate — Scores actions before execution and decides whether to
 * auto-execute, propose, or ask the user.
 *
 * Factor weights:
 * - Trust history (0-3): from trust-engine.js
 * - Target exists (0-2): does the target resource exist?
 * - Intent clarity (0-2): how clear is the agent's intent?
 * - Reversibility (0-1.5): can the action be undone?
 * - Reasoning support (0-1.5): is there a concluded hypothesis backing this?
 *
 * Total max: 10. Decision thresholds:
 * - <4: always ask (overrides trust)
 * - 4-6: always propose
 * - 7+: defer to trust tier
 */

import { createLogger } from './logger.js';
import config from './config.js';

const log = createLogger('confidence-gate');

const ENABLED = config.confidenceGateEnabled !== false;
const MIN_SCORE = config.confidenceGateMinScore || 4;

/**
 * Score the confidence of an action.
 * @param {object} opts
 * @param {string} opts.actionType - e.g. 'send_message', 'execute_tool', 'run_chain', 'goal_create'
 * @param {boolean} [opts.targetExists=true] - does the target exist?
 * @param {number} [opts.intentClarity=0.5] - 0-1, how clear is the intent?
 * @param {boolean} [opts.reversible=true] - can it be undone?
 * @param {boolean} [opts.reasoningSupport=false] - backed by a reasoning journal conclusion?
 * @returns {{ score: number, decision: string, factors: object }}
 */
export function scoreConfidence({ actionType, targetExists = true, intentClarity = 0.5, reversible = true, reasoningSupport = false } = {}) {
  // Factor 1: Trust history (0-3)
  let trustScore = 1.5; // default mid
  try {
    const { getAutonomyLevel } = require_trust_engine();
    if (getAutonomyLevel) {
      const trust = getAutonomyLevel(actionType);
      trustScore = Math.min(3, trust.level * 1); // L0=0, L1=1, L2=2, L3=3
    }
  } catch {}

  // Factor 2: Target exists (0-2)
  const targetScore = targetExists ? 2 : 0;

  // Factor 3: Intent clarity (0-2)
  const clarityScore = Math.min(2, intentClarity * 2);

  // Factor 4: Reversibility (0-1.5)
  const reverseScore = reversible ? 1.5 : 0;

  // Factor 5: Reasoning support (0-1.5)
  const reasonScore = reasoningSupport ? 1.5 : 0;

  const score = Math.min(10, trustScore + targetScore + clarityScore + reverseScore + reasonScore);
  const rounded = parseFloat(score.toFixed(1));

  let decision;
  if (rounded < MIN_SCORE) decision = 'ask';
  else if (rounded < 7) decision = 'propose';
  else decision = 'auto_execute';

  return {
    score: rounded,
    decision,
    factors: {
      trust: parseFloat(trustScore.toFixed(1)),
      targetExists: targetScore,
      intentClarity: parseFloat(clarityScore.toFixed(1)),
      reversibility: reverseScore,
      reasoningSupport: reasonScore,
    },
  };
}

// Lazy trust engine import to avoid circular deps
let _trustEngine = null;
function require_trust_engine() {
  if (!_trustEngine) {
    try {
      // Dynamic import is async; use cached module if already loaded
      const mod = globalThis.__trustEngineCache;
      if (mod) return mod;
    } catch {}
  }
  return _trustEngine || {};
}

// Pre-cache trust engine on first call
let _trustEngineLoaded = false;
async function loadTrustEngine() {
  if (_trustEngineLoaded) return;
  try {
    _trustEngine = await import('./trust-engine.js');
    globalThis.__trustEngineCache = _trustEngine;
    _trustEngineLoaded = true;
  } catch {}
}
// Fire and forget
loadTrustEngine();

/**
 * Gate an action: decide whether to auto_execute, propose, or ask.
 * Combines confidence scoring with trust level.
 * @returns {{ action: 'auto_execute'|'propose'|'ask', score: number, trustLevel: number }}
 */
export function gateAction(actionType, opts = {}) {
  if (!ENABLED) {
    return { action: 'auto_execute', score: 10, trustLevel: 3 };
  }

  const result = scoreConfidence({ actionType, ...opts });

  let trustLevel = 1;
  try {
    if (_trustEngine?.getAutonomyLevel) {
      trustLevel = _trustEngine.getAutonomyLevel(actionType).level;
    }
  } catch {}

  // Score <4: always ask (overrides trust)
  if (result.score < MIN_SCORE) {
    return { action: 'ask', score: result.score, trustLevel };
  }

  // Score 4-6: always propose
  if (result.score < 7) {
    return { action: 'propose', score: result.score, trustLevel };
  }

  // Score 7+: defer to trust tier
  if (trustLevel >= 2) {
    return { action: 'auto_execute', score: result.score, trustLevel };
  } else if (trustLevel >= 1) {
    return { action: 'propose', score: result.score, trustLevel };
  }
  return { action: 'ask', score: result.score, trustLevel };
}

/**
 * Format a visual confidence report for the /confidence command.
 */
export function formatConfidenceReport() {
  const actionTypes = ['send_message', 'execute_tool', 'run_chain', 'goal_create', 'goal_update', 'cron_modify'];
  const lines = ['*Confidence Gate*\n', `Enabled: ${ENABLED}`, `Min score: ${MIN_SCORE}`, ''];

  for (const type of actionTypes) {
    const result = scoreConfidence({ actionType: type });
    const barLen = Math.round(result.score);
    const bar = '█'.repeat(barLen) + '░'.repeat(10 - barLen);
    lines.push(`${type}: ${bar} ${result.score}/10 → ${result.decision}`);
  }

  return lines.join('\n');
}
