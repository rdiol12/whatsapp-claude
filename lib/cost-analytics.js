/**
 * Cost analytics — reads costs.jsonl and produces summaries.
 * Alerts via Telegram when daily spend exceeds threshold.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { notify } from './notify.js';
import { getState, setState } from './state.js';
import { createLogger } from './logger.js';

const log = createLogger('cost-analytics');
const COSTS_FILE = join(homedir(), 'whatsapp-claude', 'data', 'costs.jsonl');
const DAILY_LIMIT_USD = parseFloat(process.env.DAILY_COST_LIMIT || '5');
const STATE_KEY = 'cost-alerts';

// --- In-memory cache for today's running total (avoids re-parsing JSONL on every message) ---
let todayCache = { date: '', total: 0, count: 0, loaded: false };

function ensureTodayCache() {
  const today = todayStr();
  if (todayCache.date === today && todayCache.loaded) return;
  // Date changed or first call — reload from file
  const entries = readCosts();
  const todayEntries = entries.filter(e => {
    const d = new Date(e.ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
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
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

/**
 * Get cost summary for a given period.
 * @param {'today'|'week'|'month'|'all'} period
 */
export function getCostSummary(period = 'today') {
  const entries = readCosts();
  if (entries.length === 0) return { period, total: 0, count: 0, entries: [] };

  const now = new Date();
  const today = todayStr();

  let filtered;
  if (period === 'today') {
    filtered = entries.filter(e => {
      const d = new Date(e.ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
      return d === today;
    });
  } else if (period === 'week') {
    const weekAgo = now.getTime() - 7 * 86400_000;
    filtered = entries.filter(e => e.ts >= weekAgo);
  } else if (period === 'month') {
    const monthAgo = now.getTime() - 30 * 86400_000;
    filtered = entries.filter(e => e.ts >= monthAgo);
  } else {
    filtered = entries;
  }

  const total = filtered.reduce((sum, e) => sum + (e.costUsd || 0), 0);
  const totalInput = filtered.reduce((sum, e) => sum + (e.inputTokens || 0), 0);
  const totalOutput = filtered.reduce((sum, e) => sum + (e.outputTokens || 0), 0);

  // Group by day
  const byDay = {};
  for (const e of filtered) {
    const day = new Date(e.ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    if (!byDay[day]) byDay[day] = { cost: 0, count: 0 };
    byDay[day].cost += e.costUsd || 0;
    byDay[day].count++;
  }

  return {
    period,
    total: parseFloat(total.toFixed(4)),
    count: filtered.length,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    byDay,
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
 * Check if daily spend exceeds limit and alert once per day.
 */
export function checkCostAlert() {
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
  }
}
