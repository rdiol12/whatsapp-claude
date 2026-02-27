/**
 * Pain Point Analyzer — detects recurring inefficiencies across system cycles.
 *
 * Analyzes:
 *   - Chronic errors: modules with errors on 3+ distinct days in the past week
 *   - WhatsApp instability: error bursts in the last 24h
 *   - Transfer deadline proximity: watchlist items expiring within 60 minutes
 *
 * Runs every 6 hours via runIfDue(). Results stored in kv_state.
 * Consumed by agent-loop.js to surface actionable context in each cycle prompt.
 */

import { getDb } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('pain-point-analyzer');
const STATE_KEY = 'pain-point-analysis';
const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Detect modules with errors on 3+ distinct calendar days in the past 7 days.
 * Uses SQLite date() on Unix-ms timestamps.
 */
function analyzeChronicErrors(db) {
  const rows = db.prepare(`
    SELECT date(ts / 1000, 'unixepoch') AS day,
           module                       AS category,
           COUNT(*)                     AS cnt
    FROM   errors
    WHERE  ts > (unixepoch('now') - 7 * 86400) * 1000
    GROUP  BY day, module
  `).all();

  const byCat = {};
  for (const r of rows) {
    if (!byCat[r.category]) byCat[r.category] = { days: new Set(), total: 0 };
    byCat[r.category].days.add(r.day);
    byCat[r.category].total += r.cnt;
  }

  return Object.entries(byCat)
    .filter(([, v]) => v.days.size >= 3)
    .map(([cat, v]) => ({
      type:        'chronic_error',
      category:    cat,
      distinctDays: v.days.size,
      totalErrors: v.total,
      severity:    v.days.size >= 5 ? 'critical' : 'high',
    }))
    .sort((a, b) => b.distinctDays - a.distinctDays);
}

/**
 * Detect elevated WhatsApp error rates in the past 24 hours.
 * Returns a single finding if total WA errors >= 5.
 */
function analyzeWhatsAppHealth(db) {
  const rows = db.prepare(`
    SELECT message, COUNT(*) AS cnt
    FROM   errors
    WHERE  module = 'whatsapp'
      AND  ts > (unixepoch('now') - 86400) * 1000
    GROUP  BY message
    ORDER  BY cnt DESC
    LIMIT  5
  `).all();

  const total = rows.reduce((s, r) => s + r.cnt, 0);
  if (total < 5) return [];

  return [{
    type:         'wa_instability',
    topError:     (rows[0]?.message || 'unknown').slice(0, 100),
    errorCount:   total,
    distinctTypes: rows.length,
    severity:     total >= 15 ? 'critical' : 'high',
  }];
}

/**
 * Detect transfer watchlist items with deadline within the next 60 minutes.
 * Reads kv_state key 'hattrick-transfer-watchlist'.
 */
function analyzeTransferDeadlines(db) {
  try {
    const row = db.prepare(
      "SELECT value FROM kv_state WHERE key = 'hattrick-transfer-watchlist'"
    ).get();
    if (!row) return [];

    const state = JSON.parse(row.value);
    const items = Array.isArray(state.items) ? state.items : [];
    const now = Date.now();
    const WINDOW_MS = 60 * 60 * 1000; // 60 minutes

    return items
      .filter(it => {
        if (!it.deadline) return false;
        const deadlineMs = new Date(it.deadline).getTime();
        return deadlineMs > now && deadlineMs - now < WINDOW_MS;
      })
      .map(it => ({
        type:        'auction_deadline_imminent',
        playerName:  it.name || String(it.playerId || 'unknown'),
        minutesLeft: Math.round((new Date(it.deadline).getTime() - now) / 60000),
        severity:    'high',
      }));
  } catch (e) {
    log.debug({ err: e.message }, 'analyzeTransferDeadlines: parse error');
    return [];
  }
}

/**
 * Run all analyzers and aggregate results into a single report object.
 */
export function analyzePainPoints() {
  const db = getDb();

  const findings = [
    ...analyzeChronicErrors(db),
    ...analyzeWhatsAppHealth(db),
    ...analyzeTransferDeadlines(db),
  ];

  // Prefer critical findings; within each tier sort by error volume descending
  const criticals = findings
    .filter(f => f.severity === 'critical')
    .sort((a, b) => (b.totalErrors || b.errorCount || 0) - (a.totalErrors || a.errorCount || 0));

  const topProblem = criticals[0]
    ?? findings.sort((a, b) => (b.totalErrors || b.errorCount || 0) - (a.totalErrors || a.errorCount || 0))[0]
    ?? null;

  const summary = findings.length > 0
    ? `Found ${findings.length} recurring pain point(s). Top: ${topProblem ? (topProblem.category || topProblem.type) : 'none'}`
    : 'No critical recurring patterns detected';

  const result = {
    timestamp:  Date.now(),
    findings,
    topProblem,
    summary,
  };

  log.info({ summary, findingsCount: findings.length }, 'Pain point analysis complete');
  return result;
}

/** Persist analysis result in kv_state. */
export function saveAnalysis(result) {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)'
  ).run(STATE_KEY, JSON.stringify(result), Date.now());
}

/** Load the most recent analysis from kv_state, or null if not found. */
export function getLastAnalysis() {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM kv_state WHERE key = ?').get(STATE_KEY);
    return row ? JSON.parse(row.value) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Run analysis only if the last run is older than INTERVAL_MS.
 * Returns the (possibly cached) analysis result.
 */
export function runIfDue() {
  const last = getLastAnalysis();
  if (last && (Date.now() - last.timestamp) < INTERVAL_MS) {
    return last;
  }
  const result = analyzePainPoints();
  saveAnalysis(result);
  return result;
}
