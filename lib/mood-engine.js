/**
 * Mood Engine — Rule-based emotional/contextual awareness.
 *
 * All rule-based, zero LLM cost. Estimates mood from:
 * - Message timing (2am = stressed/working late, long gaps = busy)
 * - Message length shifts (long → terse = frustration)
 * - Sentiment from feedback-signals
 * - Conversation velocity (rapid = engaged, slow = casual)
 * - Language switching (Hebrew mid-convo may = frustration/emphasis)
 *
 * Output: { energy: high|low, valence: positive|neutral|negative,
 *           context: working|casual|stressed|sleeping }
 * Stored in state.js, updated every message.
 */

import { createLogger } from './logger.js';
import { getState, setState } from './state.js';
import config from './config.js';

const log = createLogger('mood-engine');
const STATE_KEY = 'mood-engine';

// --- Signal patterns ---

const FRUSTRATION_WORDS = /\b(ugh|wtf|seriously|again|broken|useless|annoying|stuck|hate|terrible)\b|(?:^|[\s])(?:לא עובד|מה הבעיה|שוב|נמאס|עצבני|שבור)/i;
const POSITIVE_WORDS = /\b(great|awesome|perfect|love|excellent|nice|cool|thanks|cheers)\b|(?:^|[\s])(?:מעולה|אחלה|תותח|מושלם|תודה|יפה)/i;
const TERSE_THRESHOLD = 15; // chars — very short messages

/**
 * Detect if text contains Hebrew characters.
 */
function hasHebrew(text) {
  return /[\u0590-\u05FF]/.test(text);
}

/**
 * Get Israel time hour.
 */
function israelHour() {
  return parseInt(new Date().toLocaleTimeString('en-IL', { timeZone: config.timezone, hour: '2-digit', hour12: false }), 10);
}

/**
 * Update mood state from an incoming message.
 * Called from whatsapp.js on every user message.
 *
 * @param {object} signal - { text, timestamp, isHebrew, length }
 */
export function updateMood(signal) {
  if (!config.moodEngineEnabled) return;

  const { text = '', timestamp = Date.now() } = signal;
  const state = getState(STATE_KEY);
  const window = (config.moodWindowMinutes || 60) * 60_000;
  const history = (state.messageHistory || []).filter(m => timestamp - m.ts < window);

  // Add current message to history
  history.push({
    ts: timestamp,
    len: text.length,
    hebrew: hasHebrew(text),
    frustration: FRUSTRATION_WORDS.test(text),
    positive: POSITIVE_WORDS.test(text),
    terse: text.trim().length < TERSE_THRESHOLD && text.trim().length > 0,
  });

  // Keep only recent messages in window
  if (history.length > 50) history.splice(0, history.length - 50);

  // --- Compute mood signals ---
  const hour = israelHour();
  const recentMsgs = history.slice(-10);
  const msgCount = history.length;

  // Energy: based on time of day + message velocity
  let energy = 'neutral';
  if (hour >= 0 && hour < 6) energy = 'low'; // late night
  else if (hour >= 8 && hour < 20) energy = 'high'; // working hours
  else energy = 'low'; // evening wind-down

  // Velocity adjustment
  if (recentMsgs.length >= 3) {
    const gaps = [];
    for (let i = 1; i < recentMsgs.length; i++) {
      gaps.push(recentMsgs[i].ts - recentMsgs[i - 1].ts);
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (avgGap < 30_000) energy = 'high'; // rapid-fire (engaged or frustrated)
    else if (avgGap > 600_000) energy = 'low'; // slow (casual or busy)
  }

  // Valence: positive/negative/neutral
  let valence = 'neutral';
  const recentFrustrations = recentMsgs.filter(m => m.frustration).length;
  const recentPositive = recentMsgs.filter(m => m.positive).length;
  const recentTerse = recentMsgs.filter(m => m.terse).length;

  if (recentFrustrations >= 2) valence = 'negative';
  else if (recentPositive >= 2) valence = 'positive';
  else if (recentTerse >= 3 && recentPositive === 0) valence = 'negative'; // terse without positivity = frustrated

  // Length shift detection: if messages got dramatically shorter
  if (recentMsgs.length >= 5) {
    const olderAvgLen = recentMsgs.slice(0, 3).reduce((a, m) => a + m.len, 0) / 3;
    const newerAvgLen = recentMsgs.slice(-3).reduce((a, m) => a + m.len, 0) / 3;
    if (olderAvgLen > 50 && newerAvgLen < 20) {
      valence = 'negative'; // dramatic shortening = frustration
    }
  }

  // Language switch detection
  if (recentMsgs.length >= 3) {
    const lastThree = recentMsgs.slice(-3);
    const hebrewSwitch = lastThree[0].hebrew !== lastThree[2].hebrew;
    if (hebrewSwitch && lastThree[2].hebrew) {
      // Switched TO Hebrew — could be emphasis or frustration
      if (valence === 'neutral') valence = 'neutral'; // don't assume negative just from language switch
    }
  }

  // Context: working/casual/stressed/sleeping
  let context = 'casual';
  if (hour >= 0 && hour < 7) context = 'sleeping';
  else if (hour >= 8 && hour < 18) context = 'working';
  else if (hour >= 18 && hour < 23) context = 'casual';
  else context = 'sleeping';

  if (valence === 'negative' && energy === 'high') context = 'stressed';
  if (hour >= 0 && hour < 5 && msgCount > 0) context = 'stressed'; // working at 2am

  const mood = { energy, valence, context, updatedAt: timestamp };

  setState(STATE_KEY, {
    mood,
    messageHistory: history,
    lastMessageAt: timestamp,
  });

  log.debug({ mood, msgCount }, 'Mood updated');
  return mood;
}

/**
 * Get current mood state.
 * @returns {{ energy: string, valence: string, context: string, updatedAt: number }|null}
 */
export function getMood() {
  const state = getState(STATE_KEY);
  return state.mood || null;
}

/**
 * Get mood summary for prompt injection.
 */
export function getMoodSummary() {
  const mood = getMood();
  if (!mood) return '';

  const labels = {
    stressed: 'the user seems stressed — only share genuinely urgent info. Be brief.',
    sleeping: 'the user may be sleeping or winding down — minimal messages.',
    working: 'the user is likely working — be focused and efficient.',
    casual: 'the user is in casual mode — you can be more conversational.',
  };

  const valenceTips = {
    negative: ' He may be frustrated — acknowledge once, then focus on solutions.',
    positive: ' Good energy — this is a great time for suggestions and proposals.',
    neutral: '',
  };

  return `[Mood: ${mood.context}/${mood.energy}/${mood.valence}] ${labels[mood.context] || ''}${valenceTips[mood.valence] || ''}`;
}

/**
 * Check if proactive messages should be suppressed based on mood.
 * @returns {boolean} true if proactive should be suppressed
 */
export function shouldSuppressProactive() {
  if (!config.moodStressedSuppressProactive) return false;

  const mood = getMood();
  if (!mood) return false;

  // Suppress if stressed and negative
  if (mood.context === 'stressed' && mood.valence === 'negative') return true;

  // Suppress if sleeping
  if (mood.context === 'sleeping') return true;

  // Suppress if low energy and negative valence (not good time for proposals)
  if (mood.energy === 'low' && mood.valence === 'negative') return true;

  return false;
}

/**
 * Check if this is a good time for proposals.
 * @returns {boolean}
 */
export function isGoodTimeForProposals() {
  const mood = getMood();
  if (!mood) return true; // no data — don't block

  return mood.energy === 'high' && mood.valence !== 'negative' && mood.context === 'working';
}
