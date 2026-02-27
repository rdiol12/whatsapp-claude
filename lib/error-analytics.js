/**
 * Error Analytics — Pattern analysis and spike correlation for the error logging system.
 *
 * Implements be92cd28 ms_5: "Agent loop: analyze error patterns and alert on spikes"
 *
 * analyzePatterns(windowMs)     — Group errors by module+message, identify cascades and root causes.
 * detectSpike(windowMs)         — Compare current window vs rolling baseline; return spike factor.
 * getRootCauseReport()          — Top error patterns with cascade detection (1 root → N errors).
 * summarizeForAgent()           — Short text block injected into Sonnet prompt during error_spike signal.
 */

import { createLogger } from './logger.js';
import { getDb } from './db.js';

const log = createLogger('error-analytics');

// ---------------------------------------------------------------------------
// analyzePatterns
// ---------------------------------------------------------------------------

/**
 * Group errors in a time window by module+message pattern.
 * Detects cascades: when one root cause generates many child errors.
 *
 * @param {number} windowMs  Time window in ms (default: 1 hour)
 * @returns {{ patterns: PatternEntry[], cascades: CascadeEntry[], total: number }}
 */
export function analyzePatterns(windowMs = 60 * 60 * 1000) {
  const db = getDb();
  const since = Date.now() - windowMs;

  // Raw pattern counts
  const rows = db.prepare(`
    SELECT severity, module, message, context, COUNT(*) as cnt
    FROM errors
    WHERE ts > ?
    GROUP BY severity, module, message
    ORDER BY cnt DESC
    LIMIT 50
  `).all(since);

  const total = rows.reduce((sum, r) => sum + r.cnt, 0);

  // Build pattern entries
  const patterns = rows.map(r => ({
    module: r.module,
    message: r.message.slice(0, 80),
    severity: r.severity,
    count: r.cnt,
    pct: total > 0 ? Math.round((r.cnt / total) * 100) : 0,
  }));

  // Cascade detection: identify groups where one module error amplifies another.
  // Heuristic: resilience "retrying" + error-recovery "retry failed" both spike
  // simultaneously → they share a root cause in a different module.
  const cascades = _detectCascades(rows, total);

  return { patterns, cascades, total };
}

/**
 * Internal: find cascade groups (resilience/error-recovery entries that are
 * downstream of a primary tool-bridge or other failure).
 */
function _detectCascades(rows, total) {
  const primaryErrors = rows.filter(r =>
    !['resilience', 'error-recovery'].includes(r.module) && r.cnt >= 3
  );
  const amplifiers = rows.filter(r =>
    ['resilience', 'error-recovery'].includes(r.module) && r.cnt >= 3
  );

  if (!primaryErrors.length || !amplifiers.length) return [];

  return primaryErrors.map(primary => {
    const amplifiedCount = amplifiers.reduce((s, a) => s + a.cnt, 0);
    const amplificationFactor = primary.cnt > 0
      ? Math.round(amplifiedCount / primary.cnt)
      : 0;
    return {
      rootCause: `[${primary.module}] ${primary.message.slice(0, 60)}`,
      rootCount: primary.cnt,
      amplifiedCount,
      amplificationFactor,
      totalCascade: primary.cnt + amplifiedCount,
    };
  }).filter(c => c.amplificationFactor >= 2); // Only report real amplification
}

// ---------------------------------------------------------------------------
// detectSpike
// ---------------------------------------------------------------------------

/**
 * Compare current window error count vs rolling baseline (same window × 6 previous periods).
 *
 * @param {number} windowMs   Current window size in ms (default: 1 hour)
 * @returns {{ current: number, baseline: number, factor: number, isSpike: boolean }}
 */
export function detectSpike(windowMs = 60 * 60 * 1000) {
  const db = getDb();
  const now = Date.now();

  const current = db.prepare(
    'SELECT COUNT(*) as cnt FROM errors WHERE ts > ?'
  ).get(now - windowMs).cnt;

  // Baseline: average across 6 prior windows (excluding current)
  let baselineTotal = 0;
  let baselineWindows = 0;
  for (let i = 1; i <= 6; i++) {
    const windowStart = now - windowMs * (i + 1);
    const windowEnd   = now - windowMs * i;
    const row = db.prepare(
      'SELECT COUNT(*) as cnt FROM errors WHERE ts > ? AND ts <= ?'
    ).get(windowStart, windowEnd);
    baselineTotal += row.cnt;
    baselineWindows++;
  }

  const baseline = baselineWindows > 0
    ? Math.max(1, Math.round(baselineTotal / baselineWindows))
    : 1;

  const factor = parseFloat((current / baseline).toFixed(1));
  const isSpike = factor >= 3 && current >= 10;

  return { current, baseline, factor, isSpike };
}

// ---------------------------------------------------------------------------
// getRootCauseReport
// ---------------------------------------------------------------------------

/**
 * High-level summary of error root causes in the last hour.
 * Returns up to 5 most impactful entries.
 *
 * @returns {RootCauseEntry[]}
 */
export function getRootCauseReport() {
  const { patterns, cascades, total } = analyzePatterns();

  if (total === 0) return [];

  // Top 5 non-amplifier patterns as root causes
  const topPatterns = patterns
    .filter(p => !['resilience', 'error-recovery'].includes(p.module))
    .slice(0, 5)
    .map(p => ({
      ...p,
      cascade: cascades.find(c => c.rootCause.includes(p.module)) || null,
    }));

  return topPatterns;
}

// ---------------------------------------------------------------------------
// summarizeForAgent
// ---------------------------------------------------------------------------

/**
 * Build a compact error-spike summary for injection into the Sonnet agent prompt.
 * Called during error_spike signal handling in agent-loop.
 *
 * @param {number} [windowMs]
 * @returns {string}
 */
export function summarizeForAgent(windowMs = 60 * 60 * 1000) {
  try {
    const spike = detectSpike(windowMs);
    const report = getRootCauseReport();

    const lines = [
      `## Error Pattern Analysis (last hour)`,
      `**Total errors**: ${spike.current} (baseline: ${spike.baseline}/hr, factor: ${spike.factor}×)`,
    ];

    if (report.length > 0) {
      lines.push('**Top root causes:**');
      for (const rc of report.slice(0, 3)) {
        let line = `- [${rc.module}] "${rc.message}" × ${rc.count} (${rc.pct}%)`;
        if (rc.cascade && rc.cascade.amplificationFactor >= 2) {
          line += ` → amplified ${rc.cascade.amplificationFactor}× by retry cascade`;
        }
        lines.push(line);
      }
    } else {
      lines.push('No clear root cause pattern detected — errors spread across modules.');
    }

    lines.push('');
    lines.push('_Tip: Validation errors ("is required") are permanent — fix is to ensure tool params are non-empty before calling._');

    log.info({ errorCount: spike.current, factor: spike.factor, rootCauses: report.length }, 'error-analytics: summary generated');
    return lines.join('\n');
  } catch (err) {
    log.warn({ err: err.message }, 'error-analytics: summarizeForAgent failed');
    return '## Error Pattern Analysis\nUnavailable — analytics error.';
  }
}
