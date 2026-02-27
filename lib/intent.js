/**
 * Message tier classification.
 * Determines processing depth for each message.
 */

import config from './config.js';

const ACK_RE = /^(ok|okay|k|sure|thanks|thx|thank you|cool|nice|got it|yep|yea|nah|lol|haha|np|ty|gg|bet|word|aight|אוקיי?|תודה|סבבה|יפה|טוב|בסדר|לול|חחח|נייס|אחלה|מעולה|תותח|קול)[\s!.]*$/i;

/**
 * Classify message into processing tiers.
 *
 * Persistent mode (PERSISTENT_MODE=true):
 *   Tier 0: Acknowledgments (react only, no LLM)
 *   Tier 2: Everything else → persistent session
 *
 * Non-persistent mode (legacy):
 *   Tier 0: Acknowledgments
 *   Tier 1: Short simple messages (one-shot)
 *   Tier 2: Standard messages (full context)
 *   Tier 3: Complex tasks (full context + extras)
 */
export function classifyTier(text, { persistentMode = config.persistentMode } = {}) {
  const trimmed = text.trim();

  // Tier 0: Pure acknowledgments — no LLM needed (both modes)
  if (ACK_RE.test(trimmed)) {
    return { tier: 0, reason: 'acknowledgment' };
  }

  // Persistent mode: skip tier system, everything goes through the session
  if (persistentMode) {
    return { tier: 2, reason: 'persistent_session' };
  }

  // --- Non-persistent mode: legacy tier classification ---
  const len = trimmed.length;
  const words = trimmed.split(/\s+/).length;

  // Tier 3: Complex tasks
  const TIER3_EN = /```|code|build|create|fix|debug|refactor|deploy|analyze|review|audit|migrate|implement|configure|setup|install|write\s+(?:a\s+)?(?:script|function|code|test|module)/i;
  const TIER3_HE = /קוד|תקן|בנה|דיבאג|רפקטור|דיפלוי|תכנת|תיקון|באג|שגיאה|סקריפט|פונקציה|מודול|תבדוק|תנתח|תסביר.*(?:קוד|שגיאה|בעיה)/;
  const TIER3_SIGNALS = /\?\s*\?|!\s*!|help me (?:write|build|create|fix|set ?up|configure)/i;
  if (TIER3_EN.test(trimmed) || TIER3_HE.test(trimmed) || TIER3_SIGNALS.test(trimmed)
      || trimmed.includes('http') || len > 500) {
    return { tier: 3, reason: 'complex_task' };
  }

  // Tier 1: Short simple messages
  const COMPLEXITY_SIGNALS = /\bhow\b|why\b|explain|can you|could you|please\b.*\?|set ?up|automated?|איך|למה|תסביר|אפשר ל/i;
  if (words <= 6 && len < 80 && !COMPLEXITY_SIGNALS.test(trimmed)) {
    return { tier: 1, reason: 'short_message' };
  }

  // Tier 2: Standard
  return { tier: 2, reason: 'standard' };
}
