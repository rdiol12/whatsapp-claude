/**
 * Experiments — A/B testing framework for agent behavior.
 *
 * The agent can create experiments to test behavioral changes (e.g., "shorter messages
 * improve positive rate"). Experiments measure a metric, run for a duration, and
 * auto-revert if the metric drops below a threshold.
 *
 * Metrics supported: positive_rate, response_time, cost
 * Linked to reasoning-journal for hypothesis tracking.
 */

import { getDb } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('experiments');

// ─── Metric Measurement ──────────────────────────────────────────────────────

function measureMetric(metric) {
  const db = getDb();
  const sevenDaysAgo = Date.now() - 7 * 86400_000;

  switch (metric) {
    case 'positive_rate': {
      const total = db.prepare(
        'SELECT COUNT(*) as cnt FROM reply_outcomes WHERE ts >= ?'
      ).get(sevenDaysAgo)?.cnt || 0;
      if (total === 0) return null;
      const positive = db.prepare(
        "SELECT COUNT(*) as cnt FROM reply_outcomes WHERE ts >= ? AND sentiment = 'positive'"
      ).get(sevenDaysAgo)?.cnt || 0;
      return parseFloat((positive / total * 100).toFixed(1));
    }
    case 'response_time': {
      const row = db.prepare(
        'SELECT AVG(window_ms) as avg FROM reply_outcomes WHERE ts >= ? AND window_ms IS NOT NULL'
      ).get(sevenDaysAgo);
      return row?.avg ? parseFloat((row.avg / 1000).toFixed(1)) : null; // seconds
    }
    case 'cost': {
      const row = db.prepare(
        'SELECT SUM(cost_usd) as total FROM costs WHERE ts >= ?'
      ).get(sevenDaysAgo);
      return row?.total ? parseFloat(row.total.toFixed(4)) : null;
    }
    default:
      return null;
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Create a new experiment.
 * @param {object} opts
 * @returns {{ id: number }}
 */
export function createExperiment({ name, hypothesis, metric, duration_hours = 168, revert_threshold, change_description = null, revert_action = null }) {
  const db = getDb();
  const baseline = measureMetric(metric);

  // Link to reasoning journal if a matching open hypothesis exists
  let reasoningId = null;
  try {
    const row = db.prepare(
      "SELECT id FROM reasoning_journal WHERE status = 'open' AND hypothesis LIKE ? ORDER BY created_at DESC LIMIT 1"
    ).get(`%${name.slice(0, 30)}%`);
    if (row) reasoningId = row.id;
  } catch {}

  const result = db.prepare(`
    INSERT INTO experiments (name, hypothesis, metric, baseline_value, duration_hours, revert_threshold, change_description, revert_action, reasoning_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, hypothesis, metric, baseline, duration_hours, revert_threshold, change_description, revert_action, reasoningId);

  log.info({ id: result.lastInsertRowid, name, metric, baseline }, 'Experiment created');
  return { id: result.lastInsertRowid };
}

/**
 * Start an experiment (set status=running, record start time).
 */
export function startExperiment(id) {
  const db = getDb();
  db.prepare(
    "UPDATE experiments SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'"
  ).run(Date.now(), id);
  log.info({ id }, 'Experiment started');
}

/**
 * Check all running experiments — called every 30min from proactive loop.
 * Auto-reverts if metric drops below threshold. Concludes if duration expired.
 */
export function checkExperiments() {
  const db = getDb();
  const running = db.prepare(
    "SELECT * FROM experiments WHERE status = 'running'"
  ).all();

  const now = Date.now();
  const results = [];

  for (const exp of running) {
    const currentValue = measureMetric(exp.metric);
    if (currentValue === null) continue;

    // Update current value
    db.prepare('UPDATE experiments SET current_value = ? WHERE id = ?').run(currentValue, exp.id);

    const durationMs = exp.duration_hours * 3600_000;
    const elapsed = now - exp.started_at;
    const expired = elapsed >= durationMs;

    // Check if metric dropped below revert threshold
    const baselineAdjusted = exp.baseline_value * exp.revert_threshold;
    const shouldRevert = exp.baseline_value !== null && currentValue < baselineAdjusted;

    if (shouldRevert) {
      // Auto-revert
      const conclusion = `Reverted: ${exp.metric} dropped to ${currentValue} (baseline: ${exp.baseline_value}, threshold: ${baselineAdjusted.toFixed(1)})`;
      db.prepare(`
        UPDATE experiments SET status = 'reverted', conclusion = ?, concluded_at = ? WHERE id = ?
      `).run(conclusion, now, exp.id);

      // Record in reasoning journal if linked
      if (exp.reasoning_id) {
        try {
          const { addEvidence } = await_import_reasoning();
          if (addEvidence) addEvidence(exp.reasoning_id, `Experiment "${exp.name}" reverted: ${conclusion}`);
        } catch {}
      }

      // Record in learning journal
      try {
        recordLearning(exp, 'reverted', conclusion);
      } catch {}

      log.warn({ id: exp.id, name: exp.name, currentValue, baseline: exp.baseline_value }, 'Experiment auto-reverted');
      results.push({ id: exp.id, name: exp.name, action: 'reverted', conclusion });
    } else if (expired) {
      // Conclude naturally
      const delta = exp.baseline_value !== null ? currentValue - exp.baseline_value : 0;
      const pctChange = exp.baseline_value ? ((delta / exp.baseline_value) * 100).toFixed(1) : '?';
      const conclusion = `Concluded after ${exp.duration_hours}h: ${exp.metric} = ${currentValue} (baseline: ${exp.baseline_value}, change: ${pctChange}%)`;

      db.prepare(`
        UPDATE experiments SET status = 'concluded', conclusion = ?, concluded_at = ? WHERE id = ?
      `).run(conclusion, now, exp.id);

      // Record in reasoning journal if linked
      if (exp.reasoning_id) {
        try {
          const { conclude } = await_import_reasoning();
          if (conclude) conclude(exp.reasoning_id, conclusion);
        } catch {}
      }

      try {
        recordLearning(exp, 'concluded', conclusion);
      } catch {}

      log.info({ id: exp.id, name: exp.name, currentValue, baseline: exp.baseline_value, pctChange }, 'Experiment concluded');
      results.push({ id: exp.id, name: exp.name, action: 'concluded', conclusion });
    }
  }

  return results;
}

// Lazy import to avoid circular deps
let _reasoningMod = null;
function await_import_reasoning() {
  if (!_reasoningMod) {
    try {
      // Sync require won't work for ESM, but the module is likely already cached
      _reasoningMod = globalThis.__reasoningJournalCache || {};
    } catch {}
  }
  return _reasoningMod;
}

// Pre-cache
import('./reasoning-journal.js').then(mod => {
  _reasoningMod = mod;
  globalThis.__reasoningJournalCache = mod;
}).catch(() => {});

function recordLearning(exp, outcome, conclusion) {
  import('./learning-journal.js').then(mod => {
    mod.recordLesson(`Experiment "${exp.name}": ${conclusion}`, {
      action: 'experiment',
      outcome,
      metric: exp.metric,
      baselineValue: exp.baseline_value,
      currentValue: exp.current_value,
    });
  }).catch(() => {});
}

/**
 * Format a report for the /experiments command.
 */
export function formatExperimentsReport() {
  const db = getDb();
  const all = db.prepare(
    'SELECT * FROM experiments ORDER BY created_at DESC LIMIT 20'
  ).all();

  if (all.length === 0) return '_No experiments yet. The agent can create experiments to test behavioral changes._';

  const running = all.filter(e => e.status === 'running');
  const concluded = all.filter(e => e.status === 'concluded');
  const reverted = all.filter(e => e.status === 'reverted');
  const pending = all.filter(e => e.status === 'pending');

  const lines = ['*Experiments*\n'];
  lines.push(`Total: ${all.length} (${running.length} running, ${concluded.length} concluded, ${reverted.length} reverted, ${pending.length} pending)`);

  if (running.length > 0) {
    lines.push('\n*Running:*');
    for (const e of running) {
      const elapsed = Math.round((Date.now() - e.started_at) / 3600_000);
      const progress = Math.min(100, Math.round((elapsed / e.duration_hours) * 100));
      lines.push(`- *${e.name}* [${e.metric}] ${elapsed}h/${e.duration_hours}h (${progress}%) — baseline: ${e.baseline_value}, current: ${e.current_value ?? '?'}`);
    }
  }

  if (concluded.length > 0) {
    lines.push('\n*Concluded:*');
    for (const e of concluded.slice(0, 5)) {
      lines.push(`- ${e.name}: ${(e.conclusion || '').slice(0, 100)}`);
    }
  }

  if (reverted.length > 0) {
    lines.push('\n*Reverted:*');
    for (const e of reverted.slice(0, 3)) {
      lines.push(`- ${e.name}: ${(e.conclusion || '').slice(0, 100)}`);
    }
  }

  return lines.join('\n');
}
