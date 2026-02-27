/**
 * Clarification Dialog System
 *
 * Manages pending clarification state per JID.
 * When Claude asks for clarification via [CLARIFY: ...] marker,
 * we store the original request and re-send it with the user's
 * answer on the next message. One round-trip max.
 */

import { createLogger } from './logger.js';
import config from './config.js';

const log = createLogger('clarification');

// In-memory store: jid → pending clarification
// { originalText, question, ts, tier }
const pendingClarifications = new Map();

const CLARIFICATION_TTL = config.clarificationTtlMs; // configurable TTL — after that, treat as new message

/**
 * Extract [CLARIFY: ...] marker from Claude's response.
 * Returns { question, cleanedResponse } or null if no marker.
 * Uses /si flags: case-insensitive + dotAll for multiline markers.
 */
export function extractClarification(response) {
  const match = response.match(/\[CLARIFY:\s*(.+?)\]/si);
  if (!match) return null;

  const question = match[1].trim();
  // Remove the marker from the response (don't show raw marker to user)
  const cleanedResponse = response.replace(/\[CLARIFY:\s*.+?\]/si, '').trim();

  return { question, cleanedResponse };
}

/**
 * Store a pending clarification for a JID.
 */
export function storePendingClarification(jid, { originalText, question, tier }) {
  pendingClarifications.set(jid, {
    originalText,
    question,
    tier,
    ts: Date.now(),
  });
  log.info({ jid: jid.slice(0, 12), question: question.slice(0, 60) }, 'Clarification pending');
}

/**
 * Check if a JID has a pending clarification that hasn't expired.
 */
export function getPendingClarification(jid) {
  const pending = pendingClarifications.get(jid);
  if (!pending) return null;

  // Expired?
  if (Date.now() - pending.ts > CLARIFICATION_TTL) {
    pendingClarifications.delete(jid);
    log.info({ jid: jid.slice(0, 12) }, 'Clarification expired');
    return null;
  }

  return pending;
}

/**
 * Clear pending clarification for a JID (after it's been used).
 */
export function clearPendingClarification(jid) {
  pendingClarifications.delete(jid);
}

/**
 * Build the re-sent message after clarification answer received.
 * Combines original request + clarification answer into one clear prompt.
 */
export function buildClarifiedMessage(originalText, answer) {
  return `${originalText}\n\n[Clarification provided: ${answer}]`;
}

/**
 * Prune expired clarifications.
 */
export function pruneExpiredClarifications() {
  const now = Date.now();
  for (const [jid, pending] of pendingClarifications.entries()) {
    if (now - pending.ts > CLARIFICATION_TTL) {
      pendingClarifications.delete(jid);
    }
  }
}

// Prune every 10 minutes
setInterval(pruneExpiredClarifications, 10 * 60_000).unref();
