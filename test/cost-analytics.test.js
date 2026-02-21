/**
 * Tests for cost-analytics.js pure logic — run with: node test/cost-analytics.test.js
 *
 * Tests cost aggregation, formatting, and overview calculations.
 * Functions extracted to avoid importing the full module (which reads files).
 */

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

function expect(actual) {
  return {
    toBe(expected) { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
    toBeAbove(n) { if (!(actual > n)) throw new Error(`Expected ${actual} > ${n}`); },
    toBeBelow(n) { if (!(actual < n)) throw new Error(`Expected ${actual} < ${n}`); },
    toBeTruthy() { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toInclude(s) { if (!String(actual).includes(s)) throw new Error(`Expected "${actual}" to include "${s}"`); },
  };
}

// ---------------------------------------------------------------------------
// Extracted from cost-analytics.js — pure aggregation logic
// ---------------------------------------------------------------------------

function aggregateCostEntries(entries) {
  const total = entries.reduce((sum, e) => sum + (e.costUsd || 0), 0);
  const totalInput = entries.reduce((sum, e) => sum + (e.inputTokens || 0), 0);
  const totalOutput = entries.reduce((sum, e) => sum + (e.outputTokens || 0), 0);

  const byDay = {};
  for (const e of entries) {
    const day = new Date(e.ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    if (!byDay[day]) byDay[day] = { cost: 0, count: 0 };
    byDay[day].cost += e.costUsd || 0;
    byDay[day].count++;
  }

  return {
    total: parseFloat(total.toFixed(4)),
    count: entries.length,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    byDay,
  };
}

function buildCostReportText(summary, period, dailyLimit) {
  if (summary.count === 0) return `No costs recorded for ${period}.`;

  const lines = [`*Cost Report (${period})*`];
  lines.push(`Total: $${summary.total.toFixed(4)}`);
  lines.push(`Messages: ${summary.count}`);
  lines.push(`Tokens: ${summary.inputTokens.toLocaleString()} in / ${summary.outputTokens.toLocaleString()} out`);

  if (Object.keys(summary.byDay).length > 1) {
    lines.push('');
    lines.push('*By day:*');
    const days = Object.entries(summary.byDay).sort(([a], [b]) => b.localeCompare(a));
    for (const [day, data] of days.slice(0, 7)) {
      lines.push(`${day}: $${data.cost.toFixed(4)} (${data.count} msgs)`);
    }
  }

  lines.push(`\n_Limit: $${dailyLimit}/day_`);
  return lines.join('\n');
}

function computeOverview(entries, now) {
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const yesterday = new Date(now.getTime() - 86400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const weekAgo = now.getTime() - 7 * 86400_000;
  const monthAgo = now.getTime() - 30 * 86400_000;

  const buckets = { today: { total: 0, count: 0 }, yesterday: { total: 0, count: 0 }, week: { total: 0, count: 0 }, month: { total: 0, count: 0 } };
  const byDay = {};

  for (const e of entries) {
    const day = new Date(e.ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
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
  };
}

// ---------------------------------------------------------------------------
// Extracted from proactive.js — quiet hours logic
// ---------------------------------------------------------------------------

function isQuietHours(hour, quietStart, quietEnd) {
  return hour >= quietStart || hour < quietEnd;
}

// ---------------------------------------------------------------------------
// Extracted from plugins.js — priority sort
// ---------------------------------------------------------------------------

function comparePluginPriority(a, b) {
  return (a.priority || 100) - (b.priority || 100);
}

// ---------------------------------------------------------------------------
// aggregateCostEntries tests
// ---------------------------------------------------------------------------
console.log('\n=== aggregateCostEntries ===');

test('empty entries', () => {
  const r = aggregateCostEntries([]);
  expect(r.total).toBe(0);
  expect(r.count).toBe(0);
  expect(r.inputTokens).toBe(0);
  expect(r.outputTokens).toBe(0);
});

test('single entry', () => {
  const r = aggregateCostEntries([
    { ts: Date.now(), costUsd: 0.05, inputTokens: 1000, outputTokens: 500 },
  ]);
  expect(r.total).toBe(0.05);
  expect(r.count).toBe(1);
  expect(r.inputTokens).toBe(1000);
  expect(r.outputTokens).toBe(500);
});

test('multiple entries sum correctly', () => {
  const r = aggregateCostEntries([
    { ts: Date.now(), costUsd: 0.05, inputTokens: 1000, outputTokens: 500 },
    { ts: Date.now(), costUsd: 0.10, inputTokens: 2000, outputTokens: 800 },
    { ts: Date.now(), costUsd: 0.03, inputTokens: 500, outputTokens: 200 },
  ]);
  expect(r.total).toBe(0.18);
  expect(r.count).toBe(3);
  expect(r.inputTokens).toBe(3500);
  expect(r.outputTokens).toBe(1500);
});

test('handles missing costUsd gracefully', () => {
  const r = aggregateCostEntries([
    { ts: Date.now() },
    { ts: Date.now(), costUsd: 0.10 },
  ]);
  expect(r.total).toBe(0.1);
  expect(r.count).toBe(2);
});

test('groups entries by day', () => {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400_000);
  const r = aggregateCostEntries([
    { ts: today.getTime(), costUsd: 0.05 },
    { ts: today.getTime(), costUsd: 0.03 },
    { ts: yesterday.getTime(), costUsd: 0.10 },
  ]);
  const dayKeys = Object.keys(r.byDay);
  expect(dayKeys.length).toBe(2);
});

test('byDay costs sum per day', () => {
  const now = Date.now();
  const r = aggregateCostEntries([
    { ts: now, costUsd: 0.05 },
    { ts: now, costUsd: 0.03 },
  ]);
  const dayKeys = Object.keys(r.byDay);
  expect(dayKeys.length).toBe(1);
  const dayData = r.byDay[dayKeys[0]];
  expect(dayData.count).toBe(2);
  expect(parseFloat(dayData.cost.toFixed(2))).toBe(0.08);
});

// ---------------------------------------------------------------------------
// buildCostReportText tests
// ---------------------------------------------------------------------------
console.log('\n=== buildCostReportText ===');

test('empty summary returns "no costs" message', () => {
  const r = buildCostReportText({ count: 0, total: 0, inputTokens: 0, outputTokens: 0, byDay: {} }, 'today', 5);
  expect(r).toInclude('No costs recorded');
});

test('includes period in header', () => {
  const r = buildCostReportText({ count: 1, total: 0.05, inputTokens: 1000, outputTokens: 500, byDay: { '2026-02-21': { cost: 0.05, count: 1 } } }, 'week', 5);
  expect(r).toInclude('Cost Report (week)');
});

test('includes total cost', () => {
  const r = buildCostReportText({ count: 1, total: 0.1234, inputTokens: 0, outputTokens: 0, byDay: {} }, 'today', 5);
  expect(r).toInclude('$0.1234');
});

test('includes message count', () => {
  const r = buildCostReportText({ count: 42, total: 1, inputTokens: 0, outputTokens: 0, byDay: {} }, 'today', 5);
  expect(r).toInclude('Messages: 42');
});

test('includes daily limit', () => {
  const r = buildCostReportText({ count: 1, total: 0.05, inputTokens: 0, outputTokens: 0, byDay: {} }, 'today', 10);
  expect(r).toInclude('Limit: $10/day');
});

test('shows by-day breakdown when multiple days', () => {
  const summary = {
    count: 3, total: 0.15, inputTokens: 0, outputTokens: 0,
    byDay: {
      '2026-02-21': { cost: 0.05, count: 1 },
      '2026-02-20': { cost: 0.10, count: 2 },
    },
  };
  const r = buildCostReportText(summary, 'week', 5);
  expect(r).toInclude('By day:');
  expect(r).toInclude('2026-02-21');
  expect(r).toInclude('2026-02-20');
});

test('no by-day breakdown for single day', () => {
  const summary = {
    count: 1, total: 0.05, inputTokens: 0, outputTokens: 0,
    byDay: { '2026-02-21': { cost: 0.05, count: 1 } },
  };
  const r = buildCostReportText(summary, 'today', 5);
  expect(r.includes('By day:')).toBe(false);
});

// ---------------------------------------------------------------------------
// computeOverview tests
// ---------------------------------------------------------------------------
console.log('\n=== computeOverview ===');

test('empty entries gives zero overview', () => {
  const r = computeOverview([], new Date());
  expect(r.today.total).toBe(0);
  expect(r.today.count).toBe(0);
  expect(r.yesterday.total).toBe(0);
  expect(r.weekTotal).toBe(0);
  expect(r.monthTotal).toBe(0);
  expect(r.dailyAvg).toBe(0);
});

test('today entries counted correctly', () => {
  const now = new Date();
  const entries = [
    { ts: now.getTime(), costUsd: 0.05 },
    { ts: now.getTime(), costUsd: 0.10 },
  ];
  const r = computeOverview(entries, now);
  expect(r.today.total).toBe(0.15);
  expect(r.today.count).toBe(2);
});

test('yesterday entries counted correctly', () => {
  const now = new Date();
  const yest = now.getTime() - 86400_000;
  const entries = [
    { ts: yest, costUsd: 0.20 },
  ];
  const r = computeOverview(entries, now);
  expect(r.yesterday.total).toBe(0.2);
  expect(r.yesterday.count).toBe(1);
  expect(r.today.count).toBe(0);
});

test('week and month buckets include today', () => {
  const now = new Date();
  const entries = [{ ts: now.getTime(), costUsd: 0.05 }];
  const r = computeOverview(entries, now);
  expect(r.weekTotal).toBe(0.05);
  expect(r.monthTotal).toBe(0.05);
});

test('old entries excluded from week bucket', () => {
  const now = new Date();
  const twoWeeksAgo = now.getTime() - 14 * 86400_000;
  const entries = [{ ts: twoWeeksAgo, costUsd: 0.50 }];
  const r = computeOverview(entries, now);
  expect(r.weekTotal).toBe(0);
  expect(r.monthTotal).toBe(0.5);
});

test('topDay identifies highest spending day', () => {
  const now = new Date();
  const yest = now.getTime() - 86400_000;
  const entries = [
    { ts: now.getTime(), costUsd: 0.05 },
    { ts: yest, costUsd: 0.50 },
  ];
  const r = computeOverview(entries, now);
  expect(r.topDay.cost).toBe(0.5);
});

test('dailyAvg computed across all days', () => {
  const now = new Date();
  const yest = now.getTime() - 86400_000;
  const entries = [
    { ts: now.getTime(), costUsd: 0.10 },
    { ts: yest, costUsd: 0.30 },
  ];
  const r = computeOverview(entries, now);
  expect(r.dailyAvg).toBe(0.2); // (0.10 + 0.30) / 2 days
});

// ---------------------------------------------------------------------------
// isQuietHours tests
// ---------------------------------------------------------------------------
console.log('\n=== isQuietHours ===');

test('23:00 is quiet (start=23, end=8)', () => {
  expect(isQuietHours(23, 23, 8)).toBe(true);
});

test('0:00 is quiet', () => {
  expect(isQuietHours(0, 23, 8)).toBe(true);
});

test('7:00 is quiet', () => {
  expect(isQuietHours(7, 23, 8)).toBe(true);
});

test('8:00 is NOT quiet', () => {
  expect(isQuietHours(8, 23, 8)).toBe(false);
});

test('12:00 is NOT quiet', () => {
  expect(isQuietHours(12, 23, 8)).toBe(false);
});

test('22:00 is NOT quiet', () => {
  expect(isQuietHours(22, 23, 8)).toBe(false);
});

// ---------------------------------------------------------------------------
// comparePluginPriority tests
// ---------------------------------------------------------------------------
console.log('\n=== comparePluginPriority ===');

test('lower priority sorts first', () => {
  const plugins = [{ priority: 90 }, { priority: 10 }, { priority: 50 }];
  plugins.sort(comparePluginPriority);
  expect(plugins[0].priority).toBe(10);
  expect(plugins[2].priority).toBe(90);
});

test('missing priority defaults to 100', () => {
  const plugins = [{ priority: 50 }, {}, { priority: 150 }];
  plugins.sort(comparePluginPriority);
  expect(plugins[0].priority).toBe(50);
  expect(plugins[1].priority).toBe(undefined); // default 100, sorts middle
  expect(plugins[2].priority).toBe(150);
});

test('equal priority preserves order', () => {
  const plugins = [{ name: 'a', priority: 50 }, { name: 'b', priority: 50 }];
  plugins.sort(comparePluginPriority);
  expect(plugins[0].name).toBe('a');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
