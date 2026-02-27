/**
 * User Model — Learns the user's behavioral patterns from conversation data.
 *
 * Zero LLM cost. All analysis runs against SQLite tables (reply_outcomes, messages).
 * Provides: best send time, preferred message length, availability prediction.
 */

import { getDb } from './db.js';
import { createLogger } from './logger.js';
import config from './config.js';

const log = createLogger('user-model');

/**
 * Get the hour (Israel time) with the highest positive response rate.
 * Queries reply_outcomes grouped by hour.
 * @returns {{ hour: number, positiveRate: number, sampleSize: number } | null}
 */
export function getBestSendTime() {
  const db = getDb();
  const sevenDaysAgo = Date.now() - 7 * 86400_000;

  // Group by Israel-time hour (UTC+2)
  const rows = db.prepare(`
    SELECT
      CAST(strftime('%H', ts/1000.0, 'unixepoch', '+2 hours') AS INTEGER) as hour,
      COUNT(*) as total,
      SUM(CASE WHEN sentiment = 'positive' THEN 1 ELSE 0 END) as positive
    FROM reply_outcomes
    WHERE ts >= ?
    GROUP BY hour
    HAVING total >= 3
    ORDER BY CAST(positive AS REAL) / total DESC
    LIMIT 1
  `).all(sevenDaysAgo);

  if (rows.length === 0) return null;
  const best = rows[0];
  return {
    hour: best.hour,
    positiveRate: parseFloat((best.positive / best.total * 100).toFixed(1)),
    sampleSize: best.total,
  };
}

/**
 * Analyze which bot message lengths get positive reactions.
 * @returns {{ preferShort: boolean, avgPreferredLength: number, sampleSize: number } | null}
 */
export function getPreferredLength() {
  const db = getDb();
  const thirtyDaysAgo = Date.now() - 30 * 86400_000;

  // Join reply_outcomes with messages to get bot message length
  const rows = db.prepare(`
    SELECT
      LENGTH(m.content) as msg_len,
      ro.sentiment
    FROM reply_outcomes ro
    JOIN messages m ON m.session_id = ro.bot_msg_id
    WHERE ro.ts >= ? AND ro.sentiment IS NOT NULL
    LIMIT 200
  `).all(thirtyDaysAgo);

  if (rows.length < 5) {
    // Fallback: use all messages with sentiment
    const fallback = db.prepare(`
      SELECT sentiment, user_response
      FROM reply_outcomes
      WHERE ts >= ? AND sentiment IS NOT NULL
      LIMIT 200
    `).all(thirtyDaysAgo);

    if (fallback.length < 5) return null;

    // Rough heuristic: if positive responses are mostly short → user prefers short
    const positiveResponses = fallback.filter(r => r.sentiment === 'positive');
    const avgPosLen = positiveResponses.reduce((sum, r) => sum + (r.user_response || '').length, 0) / Math.max(1, positiveResponses.length);
    return {
      preferShort: avgPosLen < 50,
      avgPreferredLength: Math.round(avgPosLen),
      sampleSize: fallback.length,
    };
  }

  // Group by sentiment and calculate average message length
  const positive = rows.filter(r => r.sentiment === 'positive');
  const negative = rows.filter(r => r.sentiment === 'negative');
  const avgPosLen = positive.reduce((s, r) => s + r.msg_len, 0) / Math.max(1, positive.length);
  const avgNegLen = negative.reduce((s, r) => s + r.msg_len, 0) / Math.max(1, negative.length);

  return {
    preferShort: avgPosLen < avgNegLen,
    avgPreferredLength: Math.round(avgPosLen),
    sampleSize: rows.length,
  };
}

/**
 * Check if the user was active at the current hour in the last 7 days.
 * @returns {boolean}
 */
export function isLikelyAvailable() {
  const db = getDb();
  const now = new Date();
  const israelHour = parseInt(now.toLocaleTimeString('en-US', {
    timeZone: config.timezone, hour: 'numeric', hour12: false,
  }));
  const sevenDaysAgo = Date.now() - 7 * 86400_000;

  // Check if user sent messages at this hour in the last 7 days
  const row = db.prepare(`
    SELECT COUNT(DISTINCT date(ts/1000.0, 'unixepoch', '+2 hours')) as active_days
    FROM messages
    WHERE role = 'user'
      AND ts >= ?
      AND CAST(strftime('%H', ts/1000.0, 'unixepoch', '+2 hours') AS INTEGER) = ?
  `).get(sevenDaysAgo, israelHour);

  // Available if active on 2+ of the last 7 days at this hour
  return (row?.active_days || 0) >= 2;
}

/**
 * Combined user model summary.
 */
export function getUserModelSummary() {
  const bestTime = getBestSendTime();
  const prefLen = getPreferredLength();
  const available = isLikelyAvailable();

  return {
    bestSendTime: bestTime,
    preferredLength: prefLen,
    currentlyAvailable: available,
  };
}

/**
 * Compact markdown context for prompt injection (~100 tokens).
 */
export function formatUserModelContext() {
  const model = getUserModelSummary();
  const parts = [];

  if (model.bestSendTime) {
    parts.push(`Best send hour: ${model.bestSendTime.hour}:00 (${model.bestSendTime.positiveRate}% positive rate)`);
  }
  if (model.preferredLength) {
    parts.push(`Message preference: ${model.preferredLength.preferShort ? 'concise' : 'detailed'}`);
  }
  parts.push(`Currently available: ${model.currentlyAvailable ? 'likely yes' : 'probably not'}`);

  if (parts.length === 0) return '';
  return `## User Model\n${parts.join('\n')}`;
}
