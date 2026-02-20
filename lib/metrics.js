/**
 * Lightweight in-memory metrics tracking.
 * Counters reset on restart; persistent aggregates stored via state.js.
 *
 * Tracks: messages (in/out), errors by type, latency percentiles,
 * cost by tier, cron success/failure, queue analytics.
 */

import { getState, setState } from './state.js';
import { createLogger } from './logger.js';

const log = createLogger('metrics');
const STATE_KEY = 'metrics';
const MAX_LATENCY_SAMPLES = 500; // rolling window for percentile calc

// In-memory counters (reset on restart)
const counters = {
  messagesIn: 0,
  messagesOut: 0,
  errors: 0,
  claudeCalls: 0,
  tier0: 0,
  tier1: 0,
  tier2: 0,
  tier3: 0,
  totalLatencyMs: 0,
  totalCostUsd: 0,
  startedAt: Date.now(),
  lastMessageAt: null,
};

// Latency samples for percentile calculation (rolling window)
const latencySamples = [];

// Error breakdown by type
const errorsByType = { timeout: 0, auth: 0, network: 0, claude: 0, whatsapp: 0, other: 0 };

// Cost by tier
const costByTier = { t0: 0, t1: 0, t2: 0, t3: 0 };

// Cron stats
const cronStats = { runs: 0, successes: 0, failures: 0 };

// Queue analytics
const queueMetrics = { totalEnqueued: 0, totalRejected: 0, peakRunning: 0, peakWaiting: 0 };

// Recent errors (last 20)
const recentErrors = [];
const MAX_RECENT_ERRORS = 20;

export function recordMessage(direction = 'in', { tier, latencyMs, costUsd } = {}) {
  if (direction === 'in') {
    counters.messagesIn++;
    counters.lastMessageAt = Date.now();
    if (tier === 0) counters.tier0++;
    else if (tier === 1) counters.tier1++;
    else if (tier === 2) counters.tier2++;
    else if (tier === 3) counters.tier3++;
  } else {
    counters.messagesOut++;
    counters.claudeCalls++;
    if (latencyMs) {
      counters.totalLatencyMs += latencyMs;
      latencySamples.push(latencyMs);
      if (latencySamples.length > MAX_LATENCY_SAMPLES) latencySamples.shift();
    }
    if (costUsd) {
      counters.totalCostUsd += costUsd;
      if (tier != null) {
        const key = `t${tier}`;
        if (key in costByTier) costByTier[key] += costUsd;
      }
    }
  }
}

/**
 * Record an error with optional type classification.
 * @param {string} [errorType] - 'timeout'|'auth'|'network'|'claude'|'whatsapp'|'other'
 */
export function recordError(errorType) {
  counters.errors++;

  // Classify error type
  const type = errorType && errorType in errorsByType ? errorType : 'other';
  errorsByType[type]++;

  // Track recent errors
  recentErrors.push({ type, ts: Date.now() });
  if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
}

/**
 * Record cron execution result.
 */
export function recordCron(success) {
  cronStats.runs++;
  if (success) cronStats.successes++;
  else cronStats.failures++;
}

/**
 * Record queue event for analytics.
 */
export function recordQueueEvent(event, { running, waiting } = {}) {
  if (event === 'enqueue') queueMetrics.totalEnqueued++;
  else if (event === 'reject') queueMetrics.totalRejected++;

  if (running != null && running > queueMetrics.peakRunning) queueMetrics.peakRunning = running;
  if (waiting != null && waiting > queueMetrics.peakWaiting) queueMetrics.peakWaiting = waiting;
}

/**
 * Calculate percentile from sorted samples.
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Get latency percentiles from samples.
 */
function getLatencyPercentiles() {
  if (latencySamples.length === 0) return { p50: 0, p90: 0, p95: 0, p99: 0, min: 0, max: 0 };
  const sorted = [...latencySamples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

export function getMetrics() {
  const avgLatency = counters.claudeCalls > 0
    ? Math.round(counters.totalLatencyMs / counters.claudeCalls)
    : 0;

  return {
    ...counters,
    avgLatencyMs: avgLatency,
    uptimeMs: Date.now() - counters.startedAt,
  };
}

/**
 * Get full health snapshot (for /status and IPC).
 */
export function getHealthSnapshot(extras = {}) {
  const m = getMetrics();
  const mem = process.memoryUsage();
  const upSec = process.uptime();

  return {
    uptime: upSec < 3600 ? `${(upSec / 60).toFixed(0)}m` : `${(upSec / 3600).toFixed(1)}h`,
    uptime_seconds: Math.round(upSec),
    memory_mb: Math.round(mem.rss / 1048576),
    heap_mb: Math.round(mem.heapUsed / 1048576),
    messages_in: m.messagesIn,
    messages_out: m.messagesOut,
    claude_calls: m.claudeCalls,
    errors: m.errors,
    avg_latency_ms: m.avgLatencyMs,
    cost_usd_session: parseFloat(m.totalCostUsd.toFixed(4)),
    tier_breakdown: { t0: m.tier0, t1: m.tier1, t2: m.tier2, t3: m.tier3 },
    last_message: m.lastMessageAt ? new Date(m.lastMessageAt).toISOString() : null,
    started_at: new Date(m.startedAt).toISOString(),
    ...extras,
  };
}

/**
 * Get detailed metrics for dashboard (latency percentiles, error breakdown, etc.)
 */
export function getDetailedMetrics() {
  const basic = getHealthSnapshot();
  return {
    ...basic,
    latency: getLatencyPercentiles(),
    latency_samples: latencySamples.length,
    errors_by_type: { ...errorsByType },
    recent_errors: recentErrors.slice(-10).map(e => ({
      type: e.type,
      ts: new Date(e.ts).toISOString(),
      ago_s: Math.round((Date.now() - e.ts) / 1000),
    })),
    cost_by_tier: { ...costByTier },
    cost_per_message: counters.claudeCalls > 0
      ? parseFloat((counters.totalCostUsd / counters.claudeCalls).toFixed(6))
      : 0,
    cron: { ...cronStats, success_rate: cronStats.runs > 0 ? parseFloat((cronStats.successes / cronStats.runs * 100).toFixed(1)) : 100 },
    queue: { ...queueMetrics },
  };
}

/**
 * Persist today's metrics to state (called periodically or on shutdown).
 */
export function persistMetrics() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const existing = getState(STATE_KEY);
  const dayKey = `day_${today}`;
  const dayData = existing[dayKey] || { messagesIn: 0, messagesOut: 0, errors: 0, claudeCalls: 0, costUsd: 0 };

  dayData.messagesIn += counters.messagesIn;
  dayData.messagesOut += counters.messagesOut;
  dayData.errors += counters.errors;
  dayData.claudeCalls += counters.claudeCalls;
  dayData.costUsd += counters.totalCostUsd;

  setState(STATE_KEY, { [dayKey]: dayData, lastPersist: Date.now() });

  // Reset session counters after persisting
  counters.messagesIn = 0;
  counters.messagesOut = 0;
  counters.errors = 0;
  counters.claudeCalls = 0;
  counters.totalCostUsd = 0;
  counters.totalLatencyMs = 0;

  log.debug({ today, dayData }, 'Metrics persisted');
}

// Auto-persist every 30 minutes
const persistInterval = setInterval(persistMetrics, 30 * 60_000);
persistInterval.unref();
