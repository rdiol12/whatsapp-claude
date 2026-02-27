/**
 * Memory Guardian — proactive memory management for the Sela agent.
 *
 * Problem: Node.js heap runs at 86-98% capacity 89% of the time.
 * The watchdog suppresses these as non-failures → zero visibility, crash risk.
 *
 * Architecture:
 *   - 5 tiers: NORMAL → WARN → SHED → CRITICAL → RESTART
 *   - Collects heap snapshots each cycle, persists to SQLite kv_state
 *   - Detects chronic pressure (sustained degraded state over time window)
 *   - Sheds cache at SHED tier (clear stale kv_state, force GC if available)
 *   - Alerts via notify.js at CRITICAL tier (with cooldown)
 *   - Recommends graceful restart at RESTART tier (PM2 will auto-restart)
 *
 * Integration points:
 *   - agent-loop.js: calls checkMemory() at cycle start; replaces inline signal #7
 *   - agent-signals.js: getMemorySignal() replaces the old 420MB/470MB check
 *   - bot-ipc.js: getMemoryDashboard() exposes rich stats via /memory endpoint
 *   - notify.js: alertCrash() for chronic/critical pressure notifications
 *
 * @module memory-guardian
 */

import v8 from 'node:v8';
import { createLogger } from './logger.js';
import { kvGet, kvSet, getDb } from './db.js';

const log = createLogger('memory-guardian');

// ─── Tier Definitions ────────────────────────────────────────────────────────
// Thresholds are RSS percentage (RSS / PM2 memory limit * 100).
// PM2 kills at max_memory_restart (512MB default), so RSS% is the real metric.

export const TIERS = Object.freeze({
  NORMAL:   { name: 'normal',   maxPct: 70,  action: 'none',    urgency: null },
  WARN:     { name: 'warn',     maxPct: 80,  action: 'log',     urgency: 'low' },
  SHED:     { name: 'shed',     maxPct: 90,  action: 'evict',   urgency: 'medium' },
  CRITICAL: { name: 'critical', maxPct: 96,  action: 'alert',   urgency: 'high' },
  RESTART:  { name: 'restart',  maxPct: 100, action: 'restart', urgency: 'high' },
});

// ─── Configuration ───────────────────────────────────────────────────────────

const STATE_KEY           = 'memory-guardian';
const SNAPSHOT_RETENTION  = 100;            // keep last N snapshots in state
const CHRONIC_WINDOW_MS   = 15 * 60_000;   // 15 minutes sustained = chronic
const CHRONIC_THRESHOLD   = 0.80;           // 80%+ of snapshots in window must be ≥SHED
const ALERT_COOLDOWN_MS   = 30 * 60_000;   // 30 min between critical alerts
const SHED_COOLDOWN_MS    = 10 * 60_000;   // 10 min between cache shed attempts

// PM2 memory limit in MB — matches ecosystem.config.cjs max_memory_restart.
// Override via env: PM2_MAX_MEMORY_MB=512
const PM2_LIMIT_MB = parseInt(process.env.PM2_MAX_MEMORY_MB || '512', 10);

// ─── Internal State (in-memory, fast) ────────────────────────────────────────

let lastAlertAt = 0;
let lastShedAt  = 0;
let shedCount   = 0;

// ─── Core: Collect Heap Snapshot ─────────────────────────────────────────────

/**
 * Get current memory statistics.
 *
 * IMPORTANT: heapPct is RSS / PM2 memory limit — the metric that determines
 * whether PM2 will restart the process. The old metric (heapUsed / heapTotal)
 * was misleading because heapTotal is V8's *current* dynamic allocation, not
 * the max limit. It produced 85-98% readings even when real usage was ~12%.
 *
 * @returns {{ heapUsedMB: number, heapTotalMB: number, heapLimitMB: number,
 *             heapPct: number, rssMB: number, pm2LimitMB: number, externalMB: number }}
 */
export function getHeapStats() {
  const mem = process.memoryUsage();
  const rssMB = Math.round(mem.rss / 1048576);
  const heapLimitMB = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);
  return {
    heapUsedMB:  Math.round(mem.heapUsed / 1048576),
    heapTotalMB: Math.round(mem.heapTotal / 1048576),
    heapLimitMB,
    heapPct:     Math.min(100, Math.round(rssMB / PM2_LIMIT_MB * 100)),
    rssMB,
    pm2LimitMB:  PM2_LIMIT_MB,
    externalMB:  Math.round((mem.external || 0) / 1048576),
  };
}

/**
 * Determine the current memory tier based on heap percentage.
 * @param {number} heapPct - Heap usage percentage (0-100)
 * @returns {object} The matching tier from TIERS
 */
export function getTier(heapPct) {
  if (heapPct <= TIERS.NORMAL.maxPct)   return TIERS.NORMAL;
  if (heapPct <= TIERS.WARN.maxPct)     return TIERS.WARN;
  if (heapPct <= TIERS.SHED.maxPct)     return TIERS.SHED;
  if (heapPct <= TIERS.CRITICAL.maxPct) return TIERS.CRITICAL;
  return TIERS.RESTART;
}

// ─── State Persistence ───────────────────────────────────────────────────────

/**
 * Load persisted guardian state from SQLite kv_state.
 * @returns {{ snapshots: Array, lastChronic: number|null, shedHistory: Array }}
 */
function loadState() {
  try {
    const raw = kvGet(STATE_KEY);
    if (raw && Array.isArray(raw.snapshots)) return raw;
  } catch (e) {
    log.debug({ err: e.message }, 'loadState: fresh start');
  }
  return { snapshots: [], lastChronic: null, shedHistory: [] };
}

/**
 * Save guardian state to SQLite kv_state.
 * Trims snapshots to SNAPSHOT_RETENTION.
 */
function saveState(state) {
  try {
    // Trim to retention limit
    if (state.snapshots.length > SNAPSHOT_RETENTION) {
      state.snapshots = state.snapshots.slice(-SNAPSHOT_RETENTION);
    }
    if (state.shedHistory?.length > 20) {
      state.shedHistory = state.shedHistory.slice(-20);
    }
    kvSet(STATE_KEY, state);
  } catch (e) {
    log.warn({ err: e.message }, 'saveState: failed to persist');
  }
}

// ─── Chronic Pressure Detection ──────────────────────────────────────────────

/**
 * Detect chronic memory pressure: sustained SHED+ tier over CHRONIC_WINDOW_MS.
 * @param {Array} snapshots - Array of { ts, heapPct, tier } objects
 * @returns {{ chronic: boolean, sustainedMinutes: number, avgPct: number }}
 */
export function detectChronic(snapshots) {
  const windowStart = Date.now() - CHRONIC_WINDOW_MS;
  const recent = snapshots.filter(s => s.ts >= windowStart);

  if (recent.length < 2) {
    return { chronic: false, sustainedMinutes: 0, avgPct: 0 };
  }

  const elevated = recent.filter(s => s.heapPct > TIERS.WARN.maxPct);
  const ratio = elevated.length / recent.length;
  const avgPct = recent.length > 0
    ? Math.round(recent.reduce((sum, s) => sum + s.heapPct, 0) / recent.length)
    : 0;

  const sustainedMinutes = recent.length > 1
    ? Math.round((recent[recent.length - 1].ts - recent[0].ts) / 60_000)
    : 0;

  return {
    chronic: ratio >= CHRONIC_THRESHOLD,
    sustainedMinutes,
    avgPct,
    snapshotCount: recent.length,
    elevatedRatio: Math.round(ratio * 100),
  };
}

// ─── Cache Shedding ──────────────────────────────────────────────────────────

// Keys that should never be evicted during cache shedding
const PROTECTED_KEYS = new Set([
  'memory-guardian', 'agent-loop', 'metrics', 'guardian', 'startup-notify-ts',
  'error-recovery', 'trust-engine', 'mood-engine', 'agent-rate-limits',
]);

/**
 * Shed non-essential cached data to free memory.
 * Actions (ordered by aggressiveness):
 *   1. Force V8 garbage collection (if --expose-gc flag present)
 *   2. Clear stale _test_state_* entries (dead test artifacts)
 *   3. Clear old recap:* entries (keep last 3 days)
 *   4. Trim oversized kv_state entries (>100KB, non-protected)
 *
 * @returns {{ freed: boolean, actions: string[], bytesFreed: number }}
 */
export function shedCache() {
  const now = Date.now();
  if ((now - lastShedAt) < SHED_COOLDOWN_MS) {
    return { freed: false, actions: ['cooldown_active'], bytesFreed: 0 };
  }
  lastShedAt = now;
  shedCount++;

  const actions = [];
  let bytesFreed = 0;

  // 1. Force V8 GC if available (Node must be started with --expose-gc)
  if (typeof globalThis.gc === 'function') {
    try {
      globalThis.gc();
      actions.push('forced_gc');
    } catch (e) {
      actions.push(`gc_failed: ${e.message}`);
    }
  }

  // 2. Clear stale _test_state_* entries (accumulated from test runs)
  try {
    const db = getDb();

    // Count and delete _test_state_* artifacts
    const testRows = db.prepare("SELECT key, length(value) as size FROM kv_state WHERE key LIKE '_test_state_%'").all();
    if (testRows.length > 0) {
      const totalSize = testRows.reduce((s, r) => s + r.size, 0);
      db.prepare("DELETE FROM kv_state WHERE key LIKE '_test_state_%'").run();
      bytesFreed += totalSize;
      actions.push(`cleared_test_artifacts: ${testRows.length} entries (${totalSize} bytes)`);
    }

    // 3. Clear old recap:* entries (keep last 3)
    const recapRows = db.prepare("SELECT key FROM kv_state WHERE key LIKE 'recap:%' ORDER BY key DESC").all();
    if (recapRows.length > 3) {
      const toDelete = recapRows.slice(3).map(r => r.key);
      const delStmt = db.prepare('DELETE FROM kv_state WHERE key = ?');
      for (const key of toDelete) {
        delStmt.run(key);
        bytesFreed += 1500; // ~1.5KB avg per recap
      }
      actions.push(`cleared_old_recaps: ${toDelete.length} entries`);
    }

    // 4. Trim oversized entries (>100KB, non-protected)
    // For memory-tiers specifically: prune to MAX_TRACKED (config-driven) by removing lowest-weight entries
    const oversized = db.prepare("SELECT key, length(value) as size FROM kv_state WHERE length(value) > 100000").all();
    for (const row of oversized) {
      if (PROTECTED_KEYS.has(row.key)) continue;
      if (row.key === 'memory-tiers') {
        try {
          const raw = db.prepare("SELECT value FROM kv_state WHERE key = 'memory-tiers'").get();
          if (raw) {
            const data = JSON.parse(raw.value);
            const entries = data.entries || {};
            const keys = Object.keys(entries);
            const maxTracked = 250; // aligned with config default
            if (keys.length > maxTracked) {
              const sorted = keys.sort((a, b) => (entries[a].weight || 0) - (entries[b].weight || 0));
              const toRemove = sorted.slice(0, keys.length - maxTracked);
              for (const k of toRemove) delete entries[k];
              db.prepare("UPDATE kv_state SET value = ? WHERE key = 'memory-tiers'").run(JSON.stringify({ entries, updatedAt: Date.now() }));
              const newSize = JSON.stringify({ entries }).length;
              bytesFreed += row.size - newSize;
              actions.push(`trimmed_memory_tiers: ${toRemove.length} entries removed (${Math.round(row.size / 1024)}KB → ${Math.round(newSize / 1024)}KB)`);
            } else {
              actions.push(`oversized_noted: ${row.key} (${Math.round(row.size / 1024)}KB, ${keys.length} entries — within limit)`);
            }
          }
        } catch (trimErr) {
          actions.push(`memory_tiers_trim_error: ${trimErr.message}`);
        }
      } else {
        actions.push(`oversized_noted: ${row.key} (${Math.round(row.size / 1024)}KB)`);
      }
    }
  } catch (e) {
    actions.push(`db_shed_error: ${e.message}`);
  }

  if (actions.length === 0) {
    actions.push('nothing_to_shed');
  }

  log.info({ shedCount, actions, bytesFreed }, 'Cache shed attempt');
  return { freed: bytesFreed > 0 || actions.includes('forced_gc'), actions, bytesFreed };
}

// ─── Signal Generation ───────────────────────────────────────────────────────

/**
 * Generate memory pressure signal(s) for agent-signals.js collectSignals().
 * Replaces the inline signal #7 (420MB/470MB threshold) with tiered detection.
 *
 * @param {Array} snapshots - Recent snapshots from guardian state
 * @param {object} currentStats - Current getHeapStats() result
 * @param {object} tier - Current getTier() result
 * @param {object} chronic - detectChronic() result
 * @returns {Array} Array of signal objects for collectSignals
 */
export function generateSignals(currentStats, tier, chronic) {
  const signals = [];

  // No signal for NORMAL tier
  if (tier === TIERS.NORMAL) return signals;

  const { heapPct, heapUsedMB } = currentStats;
  const chronicSuffix = chronic.chronic
    ? ` [CHRONIC: ${chronic.sustainedMinutes}min at avg ${chronic.avgPct}%]`
    : '';

  if (tier === TIERS.RESTART) {
    signals.push({
      type: 'memory_pressure',
      urgency: 'high',
      summary: `CRITICAL RSS ${heapPct}% of ${PM2_LIMIT_MB}MB (${heapUsedMB}MB used) — graceful restart recommended${chronicSuffix}`,
      data: { heapPct, heapMB: heapUsedMB, tier: tier.name, chronic: chronic.chronic, action: 'restart' },
    });
  } else if (tier === TIERS.CRITICAL) {
    signals.push({
      type: 'memory_pressure',
      urgency: 'high',
      summary: `RSS critical at ${heapPct}% of ${PM2_LIMIT_MB}MB (${heapUsedMB}MB used) — cache shed active${chronicSuffix}`,
      data: { heapPct, heapMB: heapUsedMB, tier: tier.name, chronic: chronic.chronic, action: 'alert' },
    });
  } else if (tier === TIERS.SHED) {
    signals.push({
      type: 'memory_pressure',
      urgency: 'medium',
      summary: `RSS elevated at ${heapPct}% of ${PM2_LIMIT_MB}MB (${heapUsedMB}MB used) — shedding cache${chronicSuffix}`,
      data: { heapPct, heapMB: heapUsedMB, tier: tier.name, chronic: chronic.chronic, action: 'evict' },
    });
  } else if (tier === TIERS.WARN) {
    signals.push({
      type: 'memory_pressure',
      urgency: 'low',
      summary: `RSS at ${heapPct}% of ${PM2_LIMIT_MB}MB (${heapUsedMB}MB used) — monitoring`,
      data: { heapPct, heapMB: heapUsedMB, tier: tier.name, chronic: false, action: 'none' },
    });
  }

  return signals;
}

// ─── Trend Computation ───────────────────────────────────────────────────────

/**
 * Compute 10-snapshot heap trend: rising, stable, or falling.
 * Compares average heap% of first half vs second half of last 10 snapshots.
 *
 * @param {Array} snapshots - Array of { heapPct } objects
 * @returns {'rising'|'stable'|'falling'}
 */
export function computeTrend(snapshots) {
  const recent10 = snapshots.slice(-10);
  if (recent10.length < 3) return 'stable';
  const mid = Math.floor(recent10.length / 2);
  const firstHalf = recent10.slice(0, mid);
  const secondHalf = recent10.slice(mid);
  const avgFirst = firstHalf.reduce((s, x) => s + x.heapPct, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((s, x) => s + x.heapPct, 0) / secondHalf.length;
  if (avgSecond > avgFirst + 3) return 'rising';
  if (avgSecond < avgFirst - 3) return 'falling';
  return 'stable';
}

// ─── Dashboard Data ──────────────────────────────────────────────────────────

/**
 * Get rich memory dashboard data for the /memory IPC endpoint.
 * Includes current stats, tier, chronic detection, and trend.
 *
 * @returns {object} Dashboard-ready memory report
 */
export function getMemoryDashboard() {
  const stats = getHeapStats();
  const tier = getTier(stats.heapPct);
  const state = loadState();
  const chronic = detectChronic(state.snapshots);
  const trend = computeTrend(state.snapshots);

  return {
    current: stats,
    tier: tier.name,
    tierAction: tier.action,
    chronic,
    trend,
    shedCount,
    snapshotCount: state.snapshots.length,
    lastShedAt: lastShedAt || null,
    lastAlertAt: lastAlertAt || null,
    uptimeMinutes: Math.round(process.uptime() / 60),
  };
}

// ─── Brief Builder ───────────────────────────────────────────────────────────

/**
 * Build a context brief for memory pressure signals.
 * Consumed by agent-brain.js when building the cycle prompt.
 *
 * @param {object} signal - The memory_pressure signal object
 * @returns {string} Brief text for the LLM prompt
 */
export function buildMemoryBrief(signal) {
  const { heapPct, heapMB, tier, chronic, action } = signal.data || {};
  const lines = [`## Memory Pressure Alert (${tier?.toUpperCase() || 'UNKNOWN'})`];
  lines.push(`- RSS: ${heapPct}% of PM2 limit (${heapMB}MB used)`);
  lines.push(`- Tier: ${tier} → action: ${action}`);
  if (chronic) lines.push('- **CHRONIC**: sustained elevated pressure — consider restart');
  lines.push('');
  if (action === 'restart') {
    lines.push('Recommendation: Graceful restart — save state and exit(0) for PM2 auto-restart.');
  } else if (action === 'evict' || action === 'alert') {
    lines.push('Recommendation: Cache shedding is active. Avoid launching expensive operations this cycle.');
  }
  return lines.join('\n');
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Main check — called at the start of each agent cycle.
 *
 * Flow:
 *   1. Collect heap snapshot
 *   2. Determine tier
 *   3. Persist snapshot to state
 *   4. Detect chronic pressure
 *   5. Execute tier-appropriate action (shed, alert, or restart recommendation)
 *   6. Return signals for collectSignals()
 *
 * @returns {{ tier: string, signals: Array, dashboard: object, shouldRestart: boolean }}
 */
export function checkMemory() {
  const stats = getHeapStats();
  const tier = getTier(stats.heapPct);
  const state = loadState();

  // 1. Record snapshot
  const snapshot = {
    ts: Date.now(),
    heapPct: stats.heapPct,
    heapUsedMB: stats.heapUsedMB,
    heapTotalMB: stats.heapTotalMB,
    rssMB: stats.rssMB,
    tier: tier.name,
  };
  state.snapshots.push(snapshot);

  // 2. Detect chronic pressure
  const chronic = detectChronic(state.snapshots);
  if (chronic.chronic && !state.lastChronic) {
    state.lastChronic = Date.now();
    log.warn({ chronic }, 'Chronic memory pressure detected');
  } else if (!chronic.chronic && state.lastChronic) {
    log.info('Memory pressure resolved — chronic flag cleared');
    state.lastChronic = null;
  }

  // 3. Execute tier actions
  let shedResult = null;
  if (tier === TIERS.SHED || tier === TIERS.CRITICAL || tier === TIERS.RESTART) {
    shedResult = shedCache();
    state.shedHistory.push({ ts: Date.now(), tier: tier.name, ...shedResult });
  }

  // 4. Alert on CRITICAL (with cooldown)
  const now = Date.now();
  let alerted = false;
  if ((tier === TIERS.CRITICAL || tier === TIERS.RESTART) && (now - lastAlertAt) > ALERT_COOLDOWN_MS) {
    lastAlertAt = now;
    alerted = true;
    // Alert will be sent by the caller (agent-loop) using notify.js
    // We just flag it here to avoid importing notify.js (circular dep risk)
    log.warn({ tier: tier.name, heapPct: stats.heapPct, chronic: chronic.chronic }, 'Memory CRITICAL — alert triggered');
  }

  // 5. Persist state
  saveState(state);

  // 6. Generate signals
  const signals = generateSignals(stats, tier, chronic);

  // 7. Determine restart recommendation
  const shouldRestart = tier === TIERS.RESTART && chronic.chronic;

  // Log summary
  if (tier !== TIERS.NORMAL) {
    log.info({
      tier: tier.name,
      heapPct: stats.heapPct,
      heapMB: stats.heapUsedMB,
      chronic: chronic.chronic,
      shed: shedResult?.freed || false,
    }, 'Memory check');
  }

  return {
    tier: tier.name,
    heapPct: stats.heapPct,
    signals,
    chronic,
    shouldRestart,
    alerted,
    dashboard: {
      ...stats,
      tier: tier.name,
      chronic: chronic.chronic,
      trend: computeTrend(state.snapshots),
    },
  };
}
