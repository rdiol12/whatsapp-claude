/**
 * Memory Guardian — self-test module.
 * Exercises all functions and validates behavior.
 * Designed to be run standalone: node lib/memory-guardian-test.js
 * Also exported for integration: selfTest() returns { passed, failed, results }
 *
 * @module memory-guardian-test
 */

import {
  getHeapStats,
  getTier,
  TIERS,
  detectChronic,
  generateSignals,
  shedCache,
  buildMemoryBrief,
  checkMemory,
  getMemoryDashboard,
  computeTrend,
} from './memory-guardian.js';

const results = [];
let passed = 0;
let failed = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    results.push({ name, status: 'PASS', detail });
    passed++;
  } else {
    results.push({ name, status: 'FAIL', detail });
    failed++;
  }
}

// ─── Test 1: getHeapStats returns correct structure ───────────────────────

function testHeapStats() {
  const stats = getHeapStats();
  assert('getHeapStats: returns object', typeof stats === 'object');
  assert('getHeapStats: has heapUsedMB', typeof stats.heapUsedMB === 'number' && stats.heapUsedMB > 0);
  assert('getHeapStats: has heapTotalMB', typeof stats.heapTotalMB === 'number' && stats.heapTotalMB > 0);
  assert('getHeapStats: has heapPct', typeof stats.heapPct === 'number' && stats.heapPct >= 0 && stats.heapPct <= 100);
  assert('getHeapStats: has rssMB', typeof stats.rssMB === 'number' && stats.rssMB > 0);
  assert('getHeapStats: has heapLimitMB', typeof stats.heapLimitMB === 'number' && stats.heapLimitMB > 0);
  assert('getHeapStats: has pm2LimitMB', typeof stats.pm2LimitMB === 'number' && stats.pm2LimitMB > 0);
  assert('getHeapStats: has externalMB', typeof stats.externalMB === 'number');
  // heapPct is now RSS-based: rssMB / pm2LimitMB * 100 (capped at 100)
  const expectedPct = Math.min(100, Math.round(stats.rssMB / stats.pm2LimitMB * 100));
  assert('getHeapStats: heapPct is RSS-based', Math.abs(stats.heapPct - expectedPct) <= 1,
    `heapPct=${stats.heapPct}, expected=${expectedPct} (rssMB=${stats.rssMB}, pm2LimitMB=${stats.pm2LimitMB})`);
}

// ─── Test 2: getTier returns correct tier for each range ──────────────────

function testGetTier() {
  assert('getTier: 0% → NORMAL', getTier(0) === TIERS.NORMAL);
  assert('getTier: 50% → NORMAL', getTier(50) === TIERS.NORMAL);
  assert('getTier: 70% → NORMAL', getTier(70) === TIERS.NORMAL);
  assert('getTier: 71% → WARN', getTier(71) === TIERS.WARN);
  assert('getTier: 80% → WARN', getTier(80) === TIERS.WARN);
  assert('getTier: 81% → SHED', getTier(81) === TIERS.SHED);
  assert('getTier: 90% → SHED', getTier(90) === TIERS.SHED);
  assert('getTier: 91% → CRITICAL', getTier(91) === TIERS.CRITICAL);
  assert('getTier: 96% → CRITICAL', getTier(96) === TIERS.CRITICAL);
  assert('getTier: 97% → RESTART', getTier(97) === TIERS.RESTART);
  assert('getTier: 100% → RESTART', getTier(100) === TIERS.RESTART);
}

// ─── Test 3: detectChronic with various snapshot patterns ─────────────────

function testDetectChronic() {
  const now = Date.now();

  // Empty snapshots
  const empty = detectChronic([]);
  assert('detectChronic: empty → not chronic', empty.chronic === false);

  // Single snapshot (needs ≥2)
  const single = detectChronic([{ ts: now, heapPct: 95 }]);
  assert('detectChronic: single snapshot → not chronic', single.chronic === false);

  // All snapshots normal (below WARN 80%)
  const allNormal = Array.from({ length: 10 }, (_, i) => ({
    ts: now - (10 - i) * 60_000,
    heapPct: 60,
  }));
  const normalResult = detectChronic(allNormal);
  assert('detectChronic: all normal → not chronic', normalResult.chronic === false);

  // All snapshots elevated (above 80%), within 15-min window → chronic
  const allElevated = Array.from({ length: 10 }, (_, i) => ({
    ts: now - (10 - i) * 60_000,
    heapPct: 92,
  }));
  const elevResult = detectChronic(allElevated);
  assert('detectChronic: all elevated → chronic', elevResult.chronic === true,
    `ratio=${elevResult.elevatedRatio}%, avgPct=${elevResult.avgPct}`);

  // Mixed: 70% elevated (below 80% threshold)
  const mixed = Array.from({ length: 10 }, (_, i) => ({
    ts: now - (10 - i) * 60_000,
    heapPct: i < 3 ? 60 : 92,  // 3 normal + 7 elevated = 70% elevated < 80% threshold
  }));
  const mixedResult = detectChronic(mixed);
  assert('detectChronic: 70% elevated → not chronic (threshold 80%)', mixedResult.chronic === false,
    `ratio=${mixedResult.elevatedRatio}%`);

  // Old snapshots outside window → ignored
  const oldSnapshots = Array.from({ length: 10 }, (_, i) => ({
    ts: now - 30 * 60_000 - (10 - i) * 60_000,  // 30-40 minutes ago
    heapPct: 95,
  }));
  const oldResult = detectChronic(oldSnapshots);
  assert('detectChronic: old snapshots → not chronic', oldResult.chronic === false);
}

// ─── Test 4: generateSignals for each tier ────────────────────────────────

function testGenerateSignals() {
  const stats = { heapPct: 50, heapUsedMB: 25 };
  const chronicFalse = { chronic: false, sustainedMinutes: 0, avgPct: 0 };
  const chronicTrue = { chronic: true, sustainedMinutes: 10, avgPct: 92 };

  // NORMAL → no signals
  const normalSigs = generateSignals(stats, TIERS.NORMAL, chronicFalse);
  assert('generateSignals: NORMAL → 0 signals', normalSigs.length === 0);

  // WARN → 1 low signal
  const warnSigs = generateSignals({ heapPct: 75, heapUsedMB: 37 }, TIERS.WARN, chronicFalse);
  assert('generateSignals: WARN → 1 signal', warnSigs.length === 1);
  assert('generateSignals: WARN urgency=low', warnSigs[0]?.urgency === 'low');

  // SHED → 1 medium signal
  const shedSigs = generateSignals({ heapPct: 85, heapUsedMB: 42 }, TIERS.SHED, chronicFalse);
  assert('generateSignals: SHED → 1 signal', shedSigs.length === 1);
  assert('generateSignals: SHED urgency=medium', shedSigs[0]?.urgency === 'medium');

  // CRITICAL → 1 high signal
  const critSigs = generateSignals({ heapPct: 94, heapUsedMB: 47 }, TIERS.CRITICAL, chronicFalse);
  assert('generateSignals: CRITICAL → 1 signal', critSigs.length === 1);
  assert('generateSignals: CRITICAL urgency=high', critSigs[0]?.urgency === 'high');

  // RESTART → 1 high signal
  const restartSigs = generateSignals({ heapPct: 98, heapUsedMB: 49 }, TIERS.RESTART, chronicFalse);
  assert('generateSignals: RESTART → 1 signal', restartSigs.length === 1);
  assert('generateSignals: RESTART urgency=high', restartSigs[0]?.urgency === 'high');
  assert('generateSignals: RESTART mentions restart', restartSigs[0]?.summary?.includes('restart'));

  // Chronic flag appears in summary
  const chronicSigs = generateSignals({ heapPct: 94, heapUsedMB: 47 }, TIERS.CRITICAL, chronicTrue);
  assert('generateSignals: chronic tag in summary', chronicSigs[0]?.summary?.includes('CHRONIC'));
}

// ─── Test 4.5: computeTrend ───────────────────────────────────────────────

function testComputeTrend() {
  // Too few snapshots → stable
  assert('computeTrend: empty → stable', computeTrend([]) === 'stable');
  assert('computeTrend: 2 snapshots → stable', computeTrend([
    { heapPct: 50 }, { heapPct: 90 },
  ]) === 'stable');

  // Steady snapshots → stable
  const steady = Array.from({ length: 10 }, () => ({ heapPct: 70 }));
  assert('computeTrend: steady → stable', computeTrend(steady) === 'stable');

  // Rising snapshots
  const rising = Array.from({ length: 10 }, (_, i) => ({ heapPct: 60 + i * 3 }));
  assert('computeTrend: rising → rising', computeTrend(rising) === 'rising');

  // Falling snapshots
  const falling = Array.from({ length: 10 }, (_, i) => ({ heapPct: 90 - i * 3 }));
  assert('computeTrend: falling → falling', computeTrend(falling) === 'falling');
}

// ─── Test 5: shedCache respects cooldown and has enhanced fields ──────────

function testShedCache() {
  // First call — should work (or be on cooldown from checkMemory above)
  const first = shedCache();
  assert('shedCache: returns object', typeof first === 'object');
  assert('shedCache: has freed field', typeof first.freed === 'boolean');
  assert('shedCache: has actions array', Array.isArray(first.actions));
  assert('shedCache: has bytesFreed field', typeof first.bytesFreed === 'number');

  // Second call immediately — should be on cooldown
  const second = shedCache();
  assert('shedCache: cooldown active on immediate retry', second.actions.includes('cooldown_active'));
}

// ─── Test 6: buildMemoryBrief produces readable output ────────────────────

function testBuildMemoryBrief() {
  const signal = {
    type: 'memory_pressure',
    urgency: 'high',
    summary: 'test',
    data: { heapPct: 92, heapMB: 46, tier: 'shed', chronic: false, action: 'evict' },
  };

  const brief = buildMemoryBrief(signal);
  assert('buildMemoryBrief: returns string', typeof brief === 'string');
  assert('buildMemoryBrief: contains heap pct', brief.includes('92%'));
  assert('buildMemoryBrief: contains tier', brief.includes('SHED'));
  assert('buildMemoryBrief: contains action', brief.includes('evict'));

  // CHRONIC signal
  const chronicSignal = {
    ...signal,
    data: { ...signal.data, chronic: true, action: 'restart' },
  };
  const chronicBrief = buildMemoryBrief(chronicSignal);
  assert('buildMemoryBrief: chronic marker present', chronicBrief.includes('CHRONIC'));
  assert('buildMemoryBrief: restart recommendation', chronicBrief.includes('restart'));
}

// ─── Test 7: checkMemory integration ──────────────────────────────────────

function testCheckMemory() {
  const result = checkMemory();
  assert('checkMemory: returns object', typeof result === 'object');
  assert('checkMemory: has tier string', typeof result.tier === 'string');
  assert('checkMemory: has heapPct number', typeof result.heapPct === 'number');
  assert('checkMemory: has signals array', Array.isArray(result.signals));
  assert('checkMemory: has chronic object', typeof result.chronic === 'object');
  assert('checkMemory: has shouldRestart boolean', typeof result.shouldRestart === 'boolean');
  assert('checkMemory: has alerted boolean', typeof result.alerted === 'boolean');
  assert('checkMemory: has dashboard object', typeof result.dashboard === 'object');
  assert('checkMemory: dashboard has tier', typeof result.dashboard.tier === 'string');
}

// ─── Test 8: getMemoryDashboard ───────────────────────────────────────────

function testDashboard() {
  const dash = getMemoryDashboard();
  assert('dashboard: returns object', typeof dash === 'object');
  assert('dashboard: has current stats', typeof dash.current === 'object');
  assert('dashboard: has tier', typeof dash.tier === 'string');
  assert('dashboard: has chronic info', typeof dash.chronic === 'object');
  assert('dashboard: has trend', ['stable', 'rising', 'falling'].includes(dash.trend));
  assert('dashboard: has snapshotCount', typeof dash.snapshotCount === 'number');
  assert('dashboard: has uptimeMinutes', typeof dash.uptimeMinutes === 'number');
}

// ─── Run All Tests ────────────────────────────────────────────────────────

export function selfTest() {
  testHeapStats();
  testGetTier();
  testDetectChronic();
  testComputeTrend();
  testGenerateSignals();
  testShedCache();
  testBuildMemoryBrief();
  testCheckMemory();
  testDashboard();

  return { passed, failed, total: passed + failed, results };
}

// If run directly: execute and print results
const isMain = process.argv[1]?.endsWith('memory-guardian-test.js');
if (isMain) {
  const { passed: p, failed: f, total, results: r } = selfTest();
  console.log(`\n=== Memory Guardian Self-Test ===`);
  for (const t of r) {
    const icon = t.status === 'PASS' ? '✓' : '✗';
    const detail = t.detail ? ` (${t.detail})` : '';
    console.log(`  ${icon} ${t.name}${detail}`);
  }
  console.log(`\nResult: ${p}/${total} passed, ${f} failed`);
  if (f > 0) process.exit(1);
}
