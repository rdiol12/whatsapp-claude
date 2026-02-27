/**
 * Error Recovery — Intercepts failed actions and attempts intelligent recovery.
 *
 * Strategies:
 * - Transient: contextual retry (timeout → longer timeout, rate limit → wait Retry-After,
 *   MCP disconnect → wait reconnect signal)
 * - Permanent: Haiku one-shot diagnosis with error + last 5 actions as context.
 *   If fixable → creates followup for next agent cycle.
 *   Same root cause 3x → escalate to the user via WhatsApp (bypasses quiet hours if critical).
 *
 * Integrates with:
 * - workflow-engine.js (step failures)
 * - tool-bridge.js (tool execution failures)
 * - agent-loop.js (cycle errors)
 * - trust-engine.js (successful recovery boosts trust, failures decrease it)
 */

import { createLogger } from './logger.js';
import { classifyError, retry } from './resilience.js';
import { getState, setState } from './state.js';
import { notify } from './notify.js';
import config from './config.js';

const log = createLogger('error-recovery');
const STATE_KEY = 'error-recovery';

// --- Circuit Breaker ---
const CIRCUIT_WINDOW_MS = 5 * 60_000;   // 5-minute sliding window
const CIRCUIT_THRESHOLD = 3;             // 3 failures opens circuit
const CIRCUIT_COOLDOWN_MS = 10 * 60_000; // circuit stays open for 10 min

function isCircuitOpen(rootCause) {
  const state = getState(STATE_KEY);
  const circuit = (state.circuits || {})[rootCause];
  if (!circuit?.openedAt) return false;
  if (Date.now() - circuit.openedAt > CIRCUIT_COOLDOWN_MS) {
    // Cooldown elapsed — close circuit
    const circuits = state.circuits || {};
    delete circuits[rootCause];
    setState(STATE_KEY, { circuits });
    return false;
  }
  return true;
}

function recordCircuitFailure(rootCause) {
  const state = getState(STATE_KEY);
  const circuits = state.circuits || {};
  if (!circuits[rootCause]) circuits[rootCause] = { timestamps: [], openedAt: null };

  const now = Date.now();
  circuits[rootCause].timestamps.push(now);
  // Prune outside window
  circuits[rootCause].timestamps = circuits[rootCause].timestamps.filter(
    t => now - t < CIRCUIT_WINDOW_MS
  );

  const recentCount = circuits[rootCause].timestamps.length;
  let justOpened = false;
  if (recentCount >= CIRCUIT_THRESHOLD && !circuits[rootCause].openedAt) {
    circuits[rootCause].openedAt = now;
    justOpened = true;
  }

  setState(STATE_KEY, { circuits });
  return { recentCount, justOpened };
}

// --- Error Pattern Tracking ---

/**
 * Track an error for pattern detection.
 * Returns the current count for this root cause.
 */
function trackError(rootCause, context = {}) {
  const state = getState(STATE_KEY);
  const patterns = state.errorPatterns || {};

  if (!patterns[rootCause]) {
    patterns[rootCause] = { count: 0, firstSeen: Date.now(), contexts: [] };
  }

  patterns[rootCause].count++;
  patterns[rootCause].lastSeen = Date.now();
  patterns[rootCause].contexts.push({
    ts: Date.now(),
    context: JSON.stringify(context).slice(0, 300),
  });

  // Keep last 10 contexts per pattern
  if (patterns[rootCause].contexts.length > 10) {
    patterns[rootCause].contexts = patterns[rootCause].contexts.slice(-10);
  }

  // Prune old patterns (>7 days)
  const weekAgo = Date.now() - 7 * 24 * 3600_000;
  for (const key of Object.keys(patterns)) {
    if (patterns[key].lastSeen < weekAgo) delete patterns[key];
  }

  setState(STATE_KEY, { errorPatterns: patterns });
  return patterns[rootCause].count;
}

/**
 * Extract a root cause key from an error.
 */
function getRootCause(err) {
  const msg = (err.message || String(err)).toLowerCase();

  if (msg.includes('timeout')) return 'timeout';
  if (msg.includes('rate limit') || msg.includes('429')) return 'rate_limit';
  if (msg.includes('econnrefused') || msg.includes('econnreset')) return 'connection_refused';
  if (msg.includes('auth') || msg.includes('unauthorized') || msg.includes('401')) return 'auth_expired';
  if (msg.includes('not found') || msg.includes('404') || msg.includes('enoent')) return 'not_found';
  if (msg.includes('quota') || msg.includes('limit exceeded')) return 'quota_exceeded';
  if (msg.includes('mcp') || msg.includes('vestige')) return 'mcp_error';
  if (msg.includes('memory') || msg.includes('heap')) return 'memory_pressure';

  // Generic: use first 50 chars as key
  return msg.slice(0, 50).replace(/[^a-z0-9_]/g, '_');
}

/**
 * Determine recovery strategy for an error.
 * @param {Error} err - The error
 * @param {object} context - { source, action, lastActions }
 * @returns {{ strategy: string, params: object, shouldRetry: boolean }}
 */
function determineStrategy(err, context = {}) {
  const kind = classifyError(err);
  const rootCause = getRootCause(err);
  const msg = (err.message || '').toLowerCase();

  if (kind === 'transient') {
    // Timeout → retry with longer timeout
    if (rootCause === 'timeout') {
      return {
        strategy: 'retry_longer_timeout',
        params: { multiplier: 1.5, maxAttempts: 2 },
        shouldRetry: true,
      };
    }

    // Rate limit → wait and retry
    if (rootCause === 'rate_limit') {
      const retryAfter = parseInt(err.headers?.['retry-after'] || '30', 10);
      return {
        strategy: 'wait_and_retry',
        params: { waitMs: retryAfter * 1000, maxAttempts: 2 },
        shouldRetry: true,
      };
    }

    // Connection refused → wait for reconnect
    if (rootCause === 'connection_refused') {
      return {
        strategy: 'wait_reconnect',
        params: { waitMs: 10_000, maxAttempts: 3 },
        shouldRetry: true,
      };
    }

    // MCP disconnect → wait for reconnect signal
    if (rootCause === 'mcp_error') {
      return {
        strategy: 'wait_mcp_reconnect',
        params: { waitMs: config.mcpReconnectDelay || 60_000 },
        shouldRetry: true,
      };
    }

    // Generic transient → standard retry
    return {
      strategy: 'standard_retry',
      params: { baseMs: 2000, maxAttempts: 3 },
      shouldRetry: true,
    };
  }

  // Permanent errors
  if (rootCause === 'auth_expired') {
    return {
      strategy: 'reauth_needed',
      params: {},
      shouldRetry: false,
      followup: 'Authentication expired — re-run auth flow or refresh tokens.',
    };
  }

  if (rootCause === 'not_found') {
    return {
      strategy: 'check_alternatives',
      params: {},
      shouldRetry: false,
      followup: `Resource not found: ${msg.slice(0, 100)}. Check if path/ID changed.`,
    };
  }

  if (rootCause === 'quota_exceeded') {
    return {
      strategy: 'budget_exceeded',
      params: {},
      shouldRetry: false,
      followup: 'API quota/budget exceeded — wait for reset or increase limit.',
    };
  }

  return {
    strategy: 'unknown_permanent',
    params: {},
    shouldRetry: false,
  };
}

/**
 * Attempt to recover from a failed action.
 * @param {Error} err - The error
 * @param {Function} retryFn - Function to retry (async)
 * @param {object} context - { source: string, action: string, actionType: string }
 * @returns {{ recovered: boolean, result?: any, strategy: string, escalated: boolean }}
 */
export async function attemptRecovery(err, retryFn, context = {}) {
  const rootCause = getRootCause(err);
  const errorCount = trackError(rootCause, context);
  const { strategy, params, shouldRetry, followup } = determineStrategy(err, context);

  log.info({
    rootCause,
    strategy,
    errorCount,
    source: context.source,
    action: context.action,
  }, 'Attempting error recovery');

  // Circuit breaker: track failures and skip retries if circuit is open
  if (rootCause === 'timeout' || rootCause === 'connection_refused') {
    if (isCircuitOpen(rootCause)) {
      log.warn({ rootCause, source: context.source }, 'Circuit breaker OPEN — skipping retry');
      return { recovered: false, strategy: 'circuit_breaker_open', escalated: false };
    }
    const { recentCount, justOpened } = recordCircuitFailure(rootCause);
    if (justOpened) {
      const alertMsg = `⚡ Circuit breaker opened: ${recentCount} "${rootCause}" errors in 5min. Retries paused for 10min. Source: ${context.source || 'unknown'}`;
      try { notify(alertMsg); } catch {}
      log.warn({ rootCause, recentCount, source: context.source }, 'Circuit breaker opened');
    }
  }

  // Try retry if applicable
  if (shouldRetry && retryFn) {
    try {
      let result;
      if (strategy === 'retry_longer_timeout') {
        // Retry with extended timeout
        result = await retryFn({ timeoutMultiplier: params.multiplier });
      } else if (strategy === 'wait_and_retry' || strategy === 'wait_reconnect' || strategy === 'wait_mcp_reconnect') {
        // Wait then retry
        await new Promise(r => setTimeout(r, params.waitMs));
        result = await retryFn({});
      } else {
        // Standard retry with backoff
        result = await retry(() => retryFn({}), { retries: params.maxAttempts, baseMs: params.baseMs || 2000 });
      }

      // Recovery succeeded!
      log.info({ rootCause, strategy, source: context.source }, 'Error recovery successful');

      // Boost trust for this action type
      try {
        const { recordOutcome } = await import('./trust-engine.js');
        recordOutcome(context.actionType || context.source, true, { reason: 'self_recovery' });
      } catch {}

      return { recovered: true, result, strategy, escalated: false };
    } catch (retryErr) {
      log.warn({ rootCause, strategy, err: retryErr.message }, 'Retry failed during recovery');
    }
  }

  // Recovery failed — check if we should escalate
  let escalated = false;
  const ESCALATION_THRESHOLD = 3;

  if (errorCount >= ESCALATION_THRESHOLD) {
    // Same root cause 3+ times → escalate to the user
    const alertMsg = `*Error escalation:* "${rootCause}" has occurred ${errorCount} times.\n${err.message.slice(0, 200)}\nSource: ${context.source || 'unknown'}`;

    try {
      // Use Telegram to bypass quiet hours for critical errors
      notify(alertMsg);
      escalated = true;
      log.warn({ rootCause, errorCount }, 'Error escalated to the user via Telegram');
    } catch {}

    // Also send via WhatsApp if critical
    if (context.sendFn && errorCount >= 5) {
      try {
        await context.sendFn(alertMsg);
      } catch {}
    }
  }

  // Create followup for next agent cycle if there's a fix suggestion
  if (followup) {
    try {
      const state = getState(STATE_KEY);
      const followups = state.pendingFollowups || [];
      followups.push({
        rootCause,
        followup,
        createdAt: Date.now(),
        source: context.source,
      });
      if (followups.length > 20) followups.splice(0, followups.length - 20);
      setState(STATE_KEY, { pendingFollowups: followups });
    } catch {}
  }

  // Decrease trust for this action type
  try {
    const { recordOutcome } = await import('./trust-engine.js');
    recordOutcome(context.actionType || context.source, false, { reason: rootCause });
  } catch {}

  return { recovered: false, strategy, escalated, followup };
}

/**
 * Get pending recovery followups for agent-loop injection.
 * @returns {Array} [{ rootCause, followup, createdAt }]
 */
export function getPendingRecoveryFollowups() {
  const state = getState(STATE_KEY);
  return (state.pendingFollowups || []).filter(f =>
    Date.now() - f.createdAt < 24 * 3600_000 // 24h TTL
  );
}

/**
 * Clear a pending followup after it's been handled.
 */
export function clearRecoveryFollowup(rootCause) {
  const state = getState(STATE_KEY);
  const followups = (state.pendingFollowups || []).filter(f => f.rootCause !== rootCause);
  setState(STATE_KEY, { pendingFollowups: followups });
}

/**
 * Get error recovery statistics.
 */
export function getRecoveryStats() {
  const state = getState(STATE_KEY);
  const patterns = state.errorPatterns || {};
  return {
    activePatterns: Object.keys(patterns).length,
    patterns: Object.entries(patterns).map(([cause, data]) => ({
      rootCause: cause,
      count: data.count,
      firstSeen: new Date(data.firstSeen).toISOString(),
      lastSeen: new Date(data.lastSeen).toISOString(),
    })).sort((a, b) => b.count - a.count),
    pendingFollowups: (state.pendingFollowups || []).length,
  };
}
