/**
 * Cost analytics — reads costs.jsonl and produces summaries.
 * Alerts via Telegram when daily spend exceeds threshold.
 */

import { readFileSync, writeFileSync } from 'fs';
import { notify } from './notify.js';
import { getState, setState } from './state.js';
import { createLogger } from './logger.js';
import { emit as wsEmit } from './ws-events.js';
import { getCostsByDay, getCostsSince, bulkInsertCosts, getEarliestCostTs, kvGet, kvSet } from './db.js';
import config from './config.js';

const log = createLogger('cost-analytics');
const COSTS_FILE = config.costsFile;
const DAILY_LIMIT_USD = parseFloat(process.env.DAILY_COST_LIMIT || '5');
const STATE_KEY = 'cost-alerts';

// --- In-memory cache for today's running total (avoids re-parsing JSONL on every message) ---
let todayCache = { date: '', total: 0, count: 0, loaded: false };

// --- One-time JSONL → SQLite historical import ────────────────────────────────
// Runs at most once per installation (guarded by kv_state flag).
// Imports JSONL entries older than 1 hour (avoids duplicating today's dual-write entries).
let _importDone = false;

function ensureHistoricalImport() {
  if (_importDone) return;
  _importDone = true; // Prevent concurrent calls

  try {
    const flag = kvGet('costs.jsonl.imported');
    if (flag) return; // Already imported previously

    // Read JSONL entries
    const entries = readCosts();
    if (entries.length === 0) {
      kvSet('costs.jsonl.imported', { importedAt: Date.now(), count: 0 });
      return;
    }

    // Determine cutoff: only import entries strictly BEFORE the earliest SQLite entry
    // (avoids double-counting dual-write entries that are already in SQLite)
    const sqliteEarliestTs = getEarliestCostTs();
    const cutoff = sqliteEarliestTs
      ? sqliteEarliestTs         // Import everything before the dual-write started
      : Date.now() - 3600_000;  // No SQLite data yet — import older than 1hr

    const toImport = entries.filter(e => e.ts < cutoff);

    if (toImport.length === 0) {
      log.info({ cutoff, sqliteEarliestTs }, 'Historical cost import: no JSONL entries before SQLite start — nothing to import');
      kvSet('costs.jsonl.imported', { importedAt: Date.now(), count: 0, skipped: true });
      return;
    }

    const inserted = bulkInsertCosts(toImport);
    kvSet('costs.jsonl.imported', { importedAt: Date.now(), count: inserted, cutoffTs: cutoff });
    log.info({ imported: inserted, total: entries.length, cutoff: new Date(cutoff).toISOString() }, 'Historical JSONL costs imported to SQLite');
  } catch (err) {
    log.warn({ err: err.message }, 'Historical cost import failed — continuing with JSONL reads');
    _importDone = false; // Allow retry next call
  }
}

function ensureTodayCache() {
  const today = todayStr();
  if (todayCache.date === today && todayCache.loaded) return;

  // Trigger one-time JSONL → SQLite import on first cache load
  ensureHistoricalImport();

  // Load today's total from SQLite (faster than JSONL scan)
  try {
    const todayStart = new Date(today + 'T00:00:00+02:00').getTime();
    const row = getCostsSince(todayStart);
    todayCache = {
      date: today,
      total: row.total || 0,
      count: row.count || 0,
      loaded: true,
    };
    return;
  } catch (err) {
    log.warn({ err: err.message }, 'SQLite today cache failed — falling back to JSONL');
  }

  // Fallback: read from JSONL
  const entries = readCosts();
  const todayEntries = entries.filter(e => {
    const d = new Date(e.ts).toLocaleDateString('en-CA', { timeZone: config.timezone });
    return d === today;
  });
  todayCache = {
    date: today,
    total: todayEntries.reduce((sum, e) => sum + (e.costUsd || 0), 0),
    count: todayEntries.length,
    loaded: true,
  };
}

/**
 * Call this after logging a cost entry to update the in-memory cache
 * without re-reading the file.
 */
export function recordCostEntry(costUsd) {
  ensureTodayCache();
  todayCache.total += costUsd || 0;
  todayCache.count++;
}

function readCosts() {
  try {
    const raw = readFileSync(COSTS_FILE, 'utf-8');
    return raw.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
}

/**
 * Get cost summary for a given period — reads from SQLite (primary) with JSONL fallback.
 * @param {'today'|'yesterday'|'week'|'month'|'all'} period
 */
export function getCostSummary(period = 'today') {
  ensureHistoricalImport();

  const now = new Date();
  const today = todayStr();

  // Determine time range for SQLite query
  let sinceMs;
  if (period === 'today') {
    sinceMs = new Date(today + 'T00:00:00+02:00').getTime();
  } else if (period === 'yesterday') {
    const yest = new Date(now.getTime() - 86400_000).toLocaleDateString('en-CA', { timeZone: config.timezone });
    sinceMs = new Date(yest + 'T00:00:00+02:00').getTime();
  } else if (period === 'week') {
    sinceMs = now.getTime() - 7 * 86400_000;
  } else if (period === 'month') {
    sinceMs = now.getTime() - 30 * 86400_000;
  } else {
    sinceMs = 0; // all
  }

  // Determine end range for 'yesterday' to avoid including today
  const untilMs = period === 'yesterday'
    ? new Date(today + 'T00:00:00+02:00').getTime() - 1
    : null;

  try {
    const rows = getCostsByDay(sinceMs, untilMs);
    if (rows.length > 0 || sinceMs > 0) {
      // SQLite has data — build summary from it
      const total = rows.reduce((s, r) => s + r.costUsd, 0);
      const totalInput = rows.reduce((s, r) => s + r.inputTokens, 0);
      const totalOutput = rows.reduce((s, r) => s + r.outputTokens, 0);
      const count = rows.reduce((s, r) => s + r.count, 0);

      const byDay = {};
      for (const r of rows) {
        byDay[r.day] = { cost: r.costUsd, count: r.count };
      }

      return {
        period,
        total: parseFloat(total.toFixed(4)),
        count,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        byDay,
        source: 'sqlite',
      };
    }
  } catch (err) {
    log.warn({ err: err.message, period }, 'getCostSummary: SQLite query failed — falling back to JSONL');
  }

  // Fallback: JSONL read (used when SQLite has no data yet)
  const entries = readCosts();
  if (entries.length === 0) return { period, total: 0, count: 0, byDay: {}, source: 'jsonl' };

  let filtered;
  if (period === 'today') {
    filtered = entries.filter(e => {
      const d = new Date(e.ts).toLocaleDateString('en-CA', { timeZone: config.timezone });
      return d === today;
    });
  } else if (period === 'yesterday') {
    const yest = new Date(now.getTime() - 86400_000).toLocaleDateString('en-CA', { timeZone: config.timezone });
    filtered = entries.filter(e => {
      const d = new Date(e.ts).toLocaleDateString('en-CA', { timeZone: config.timezone });
      return d === yest;
    });
  } else if (period === 'week') {
    filtered = entries.filter(e => e.ts >= now.getTime() - 7 * 86400_000);
  } else if (period === 'month') {
    filtered = entries.filter(e => e.ts >= now.getTime() - 30 * 86400_000);
  } else {
    filtered = entries;
  }

  const total = filtered.reduce((sum, e) => sum + (e.costUsd || 0), 0);
  const byDay = {};
  for (const e of filtered) {
    const day = new Date(e.ts).toLocaleDateString('en-CA', { timeZone: config.timezone });
    if (!byDay[day]) byDay[day] = { cost: 0, count: 0 };
    byDay[day].cost += e.costUsd || 0;
    byDay[day].count++;
  }

  return {
    period,
    total: parseFloat(total.toFixed(4)),
    count: filtered.length,
    inputTokens: filtered.reduce((sum, e) => sum + (e.inputTokens || 0), 0),
    outputTokens: filtered.reduce((sum, e) => sum + (e.outputTokens || 0), 0),
    byDay,
    source: 'jsonl',
  };
}

/**
 * Format cost summary for WhatsApp display.
 */
export function formatCostReport(period = 'today') {
  const s = getCostSummary(period);
  if (s.count === 0) return `No costs recorded for ${period}.`;

  const lines = [`*Cost Report (${period})*`];
  lines.push(`Total: $${s.total.toFixed(4)}`);
  lines.push(`Messages: ${s.count}`);
  lines.push(`Tokens: ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out`);

  if (Object.keys(s.byDay).length > 1) {
    lines.push('');
    lines.push('*By day:*');
    const days = Object.entries(s.byDay).sort(([a], [b]) => b.localeCompare(a));
    for (const [day, data] of days.slice(0, 7)) {
      lines.push(`${day}: $${data.cost.toFixed(4)} (${data.count} msgs)`);
    }
  }

  lines.push(`\n_Limit: $${DAILY_LIMIT_USD}/day_`);
  return lines.join('\n');
}

/**
 * Get a compact cost overview for the dashboard Cost Summary card.
 * Reads from SQLite (primary), falls back to JSONL if SQLite has no data.
 */
export function getCostOverview() {
  ensureHistoricalImport();

  const now = new Date();
  const today = todayStr();
  const yesterday = new Date(now.getTime() - 86400_000).toLocaleDateString('en-CA', { timeZone: config.timezone });
  const weekAgo = now.getTime() - 7 * 86400_000;
  const monthAgo = now.getTime() - 30 * 86400_000;
  const todayStart = new Date(today + 'T00:00:00+02:00').getTime();
  const yesterdayStart = new Date(yesterday + 'T00:00:00+02:00').getTime();

  try {
    // Query SQLite for all periods
    const [todayRow, yesterdayRow, weekRow, monthRow, allRows] = [
      getCostsSince(todayStart),
      getCostsByDay(yesterdayStart, todayStart - 1),
      getCostsSince(weekAgo),
      getCostsSince(monthAgo),
      getCostsByDay(0),
    ];

    const yesterdayData = yesterdayRow[0] || { costUsd: 0, count: 0 };
    const days = allRows.length;
    const dailyAvg = days > 0 ? allRows.reduce((s, r) => s + r.costUsd, 0) / days : 0;
    let topDay = { date: today, cost: 0 };
    for (const r of allRows) {
      if (r.costUsd > topDay.cost) topDay = { date: r.day, cost: r.costUsd };
    }

    return {
      today: { total: parseFloat((todayRow.total || 0).toFixed(4)), count: todayRow.count || 0 },
      yesterday: { total: parseFloat((yesterdayData.costUsd || 0).toFixed(4)), count: yesterdayData.count || 0 },
      weekTotal: parseFloat((weekRow.total || 0).toFixed(4)),
      weekCount: weekRow.count || 0,
      monthTotal: parseFloat((monthRow.total || 0).toFixed(4)),
      monthCount: monthRow.count || 0,
      dailyAvg: parseFloat(dailyAvg.toFixed(4)),
      topDay,
      source: 'sqlite',
    };
  } catch (err) {
    log.warn({ err: err.message }, 'getCostOverview: SQLite failed — falling back to JSONL');
  }

  // Fallback: JSONL
  const entries = readCosts();
  const buckets = { today: { total: 0, count: 0 }, yesterday: { total: 0, count: 0 }, week: { total: 0, count: 0 }, month: { total: 0, count: 0 } };
  const byDay = {};

  for (const e of entries) {
    const day = new Date(e.ts).toLocaleDateString('en-CA', { timeZone: config.timezone });
    const cost = e.costUsd || 0;
    if (!byDay[day]) byDay[day] = { cost: 0, count: 0 };
    byDay[day].cost += cost;
    byDay[day].count++;
    if (day === today) { buckets.today.total += cost; buckets.today.count++; }
    if (day === yesterday) { buckets.yesterday.total += cost; buckets.yesterday.count++; }
    if (e.ts >= weekAgo) { buckets.week.total += cost; buckets.week.count++; }
    if (e.ts >= monthAgo) { buckets.month.total += cost; buckets.month.count++; }
  }

  const days = Object.keys(byDay);
  const dailyAvg = days.length > 0 ? days.reduce((s, d) => s + byDay[d].cost, 0) / days.length : 0;
  let topDay = { date: today, cost: 0 };
  for (const [date, data] of Object.entries(byDay)) {
    if (data.cost > topDay.cost) topDay = { date, cost: data.cost };
  }

  return {
    today: { total: parseFloat(buckets.today.total.toFixed(4)), count: buckets.today.count },
    yesterday: { total: parseFloat(buckets.yesterday.total.toFixed(4)), count: buckets.yesterday.count },
    weekTotal: parseFloat(buckets.week.total.toFixed(4)),
    weekCount: buckets.week.count,
    monthTotal: parseFloat(buckets.month.total.toFixed(4)),
    monthCount: buckets.month.count,
    dailyAvg: parseFloat(dailyAvg.toFixed(4)),
    topDay,
    source: 'jsonl',
  };
}

/**
 * Check if daily spend exceeds limit and alert once per day.
 */
export function checkCostAlert() {
  if (config.costTrackingDisabled) return;
  const today = todayStr();
  const state = getState(STATE_KEY);

  // Already alerted today
  if (state.lastAlertDate === today) return;

  // Use in-memory cache instead of re-parsing JSONL
  ensureTodayCache();
  if (todayCache.total >= DAILY_LIMIT_USD) {
    notify(`COST ALERT: Today's spend is $${todayCache.total.toFixed(2)} (limit: $${DAILY_LIMIT_USD}). ${todayCache.count} messages processed.`);
    setState(STATE_KEY, { lastAlertDate: today, lastAlertAmount: todayCache.total });
    log.warn({ total: todayCache.total, limit: DAILY_LIMIT_USD }, 'Daily cost limit exceeded');
    wsEmit('cost:alert', { total: todayCache.total, limit: DAILY_LIMIT_USD, count: todayCache.count, ts: Date.now() });
  }
}

/**
 * Roll up costs.jsonl entries older than retainDays into daily summaries.
 * Reduces file size while preserving aggregate stats per day/model/type.
 * Safe to call repeatedly — entries already tagged as daily_rollup are skipped.
 *
 * @param {number} retainDays  Keep individual entries for this many days (default: 7)
 * @returns {{ compressed: number, kept: number, summaries: number }}
 */
export function rollupOldCosts(retainDays = 7) {
  const entries = readCosts();
  if (entries.length === 0) return { compressed: 0, kept: 0, summaries: 0 };

  const cutoff = Date.now() - retainDays * 86400_000;

  // Separate: keep recent entries and already-rolled-up summaries as-is
  const keep = entries.filter(e => e.ts >= cutoff || e.type === 'daily_rollup');
  const old  = entries.filter(e => e.ts < cutoff && e.type !== 'daily_rollup');

  if (old.length === 0) {
    log.debug({ total: entries.length }, 'No old entries to roll up');
    return { compressed: 0, kept: entries.length, summaries: 0 };
  }

  // Group old entries by date + model + original type
  const groups = {};
  for (const e of old) {
    const day = new Date(e.ts).toLocaleDateString('en-CA', { timeZone: config.timezone });
    const key = `${day}|${e.model || 'unknown'}|${e.type || 'one-shot'}`;
    if (!groups[key]) {
      groups[key] = { day, model: e.model || 'unknown', origType: e.type || 'one-shot', entries: [] };
    }
    groups[key].entries.push(e);
  }

  // Build one summary entry per group
  const summaries = Object.values(groups).map(g => {
    const total = (k) => g.entries.reduce((s, e) => s + (e[k] || 0), 0);
    return {
      type: 'daily_rollup',
      origType: g.origType,
      model: g.model,
      date: g.day,
      count: g.entries.length,
      inputTokens: total('inputTokens'),
      outputTokens: total('outputTokens'),
      cacheRead: total('cacheRead'),
      costUsd: parseFloat(total('costUsd').toFixed(6)),
      durationMs: total('durationMs'),
      ts: new Date(g.day + 'T00:00:00+02:00').getTime(), // Start of that day (Israel time)
    };
  });

  // Write back: summaries (sorted by ts) + recent entries
  const merged = [...summaries, ...keep].sort((a, b) => a.ts - b.ts);
  writeFileSync(COSTS_FILE, merged.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

  // Invalidate today's cache so next call re-reads
  todayCache.loaded = false;

  log.info({ compressed: old.length, summaries: summaries.length, kept: keep.length }, 'Costs rolled up');
  return { compressed: old.length, kept: keep.length, summaries: summaries.length };
}
