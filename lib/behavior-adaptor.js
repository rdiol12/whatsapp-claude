/**
 * Behavior Adaptor — Consumes mood-engine, outputs behavior modifiers.
 *
 * Maps mood states to concrete behavior changes:
 * - stressed + negative: suppress proactive msgs, only respond to direct questions
 * - low energy + late: minimal responses, no goal nudges, offer to defer to morning
 * - high energy + positive: best time for proposals, reviews, suggestions
 * - negative + recent agent action: agent may have caused frustration — back off
 *
 * Each modifier is a set of flags that other modules check before acting.
 */

import { createLogger } from './logger.js';
import { getMood } from './mood-engine.js';
import { getState } from './state.js';
import config from './config.js';

const log = createLogger('behavior-adaptor');

/**
 * @typedef {Object} BehaviorModifiers
 * @property {boolean} suppressProactive - Don't send proactive messages
 * @property {boolean} suppressProposals - Don't send agent brain proposals
 * @property {boolean} suppressGoalNudges - Don't nudge about stale goals
 * @property {boolean} briefResponses - Keep responses extra short
 * @property {boolean} goodTimeForProposals - Agent should propose improvements
 * @property {boolean} goodTimeForReview - Agent should suggest code reviews
 * @property {string} responseTone - 'brief'|'normal'|'conversational'
 * @property {string|null} promptHint - Hint to inject into agent prompt
 */

/**
 * Compute current behavior modifiers based on mood state.
 * @returns {BehaviorModifiers}
 */
export function getBehaviorModifiers() {
  if (!config.moodEngineEnabled) {
    return {
      suppressProactive: false,
      suppressProposals: false,
      suppressGoalNudges: false,
      briefResponses: false,
      goodTimeForProposals: true,
      goodTimeForReview: true,
      responseTone: 'normal',
      promptHint: null,
    };
  }

  const mood = getMood();
  if (!mood) {
    return {
      suppressProactive: false,
      suppressProposals: false,
      suppressGoalNudges: false,
      briefResponses: false,
      goodTimeForProposals: true,
      goodTimeForReview: true,
      responseTone: 'normal',
      promptHint: null,
    };
  }

  const modifiers = {
    suppressProactive: false,
    suppressProposals: false,
    suppressGoalNudges: false,
    briefResponses: false,
    goodTimeForProposals: false,
    goodTimeForReview: false,
    responseTone: 'normal',
    promptHint: null,
  };

  // --- Stressed + Negative: back off ---
  if (mood.context === 'stressed' && mood.valence === 'negative') {
    modifiers.suppressProactive = true;
    modifiers.suppressProposals = true;
    modifiers.suppressGoalNudges = true;
    modifiers.briefResponses = true;
    modifiers.responseTone = 'brief';
    modifiers.promptHint = 'The user seems stressed — only respond to direct questions. Be concise and solution-focused. No proposals or suggestions right now.';
  }

  // --- Sleeping/Late night ---
  if (mood.context === 'sleeping') {
    modifiers.suppressProactive = true;
    modifiers.suppressProposals = true;
    modifiers.suppressGoalNudges = true;
    modifiers.briefResponses = true;
    modifiers.responseTone = 'brief';
    modifiers.promptHint = 'The user is probably sleeping or winding down. Keep it minimal.';
  }

  // --- Low energy + Negative ---
  if (mood.energy === 'low' && mood.valence === 'negative') {
    modifiers.suppressProposals = true;
    modifiers.suppressGoalNudges = true;
    modifiers.briefResponses = true;
    modifiers.responseTone = 'brief';
    modifiers.promptHint = 'The user seems tired or frustrated — keep responses short. Offer to defer non-urgent items to morning.';
  }

  // --- High energy + Positive: ideal time ---
  if (mood.energy === 'high' && mood.valence === 'positive') {
    modifiers.goodTimeForProposals = true;
    modifiers.goodTimeForReview = true;
    modifiers.responseTone = 'conversational';
    modifiers.promptHint = 'The user is engaged and in a good mood — this is a great time for suggestions, reviews, and proposals.';
  }

  // --- Working + Neutral: focused ---
  if (mood.context === 'working' && mood.valence === 'neutral') {
    modifiers.responseTone = 'normal';
    modifiers.goodTimeForProposals = mood.energy === 'high';
  }

  // --- Recent agent action + Negative: agent may have caused frustration ---
  try {
    const agentState = getState('agent-loop');
    const lastAction = agentState.lastClaudeSpawnAt || 0;
    const timeSinceAction = Date.now() - lastAction;
    if (timeSinceAction < 10 * 60_000 && mood.valence === 'negative') {
      // Agent acted recently and user is now negative — may be our fault
      modifiers.suppressProactive = true;
      modifiers.suppressProposals = true;
      modifiers.promptHint = 'The user may be frustrated with a recent agent action — back off from proactive behavior. If asked, acknowledge the issue.';
    }
  } catch {}

  return modifiers;
}

/**
 * Format behavior modifiers for logging/display.
 */
export function formatBehavior() {
  const mods = getBehaviorModifiers();
  const mood = getMood();

  if (!mood) return 'No mood data available.';

  const parts = [
    `*Mood:* ${mood.context} / ${mood.energy} energy / ${mood.valence}`,
    `*Tone:* ${mods.responseTone}`,
  ];

  if (mods.suppressProactive) parts.push('Proactive: suppressed');
  if (mods.suppressProposals) parts.push('Proposals: suppressed');
  if (mods.goodTimeForProposals) parts.push('Proposals: encouraged');
  if (mods.briefResponses) parts.push('Responses: brief mode');

  return parts.join('\n');
}
