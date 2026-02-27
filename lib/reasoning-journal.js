/**
 * Reasoning Journal — Persistent hypothesis → evidence → conclusion tracking.
 *
 * Phase 1 of the autonomous agent upgrade. Gives the agent a "thinking scratchpad"
 * that persists across cycles. The agent can form hypotheses, collect evidence,
 * and draw conclusions over time — building institutional knowledge.
 *
 * Data stored in SQLite (reasoning_journal table). Zero LLM cost at read time.
 */

import { getDb } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('reasoning-journal');

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Create a new hypothesis entry.
 * @returns {{ id: number }}
 */
export function addHypothesis(cycleNum, hypothesis, signalType = null, confidence = 0.5) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO reasoning_journal (cycle_num, hypothesis, signal_type, confidence)
    VALUES (?, ?, ?, ?)
  `).run(cycleNum, hypothesis, signalType, Math.max(0, Math.min(1, confidence)));
  log.info({ id: result.lastInsertRowid, hypothesis: hypothesis.slice(0, 80) }, 'Hypothesis added');
  return { id: result.lastInsertRowid };
}

/**
 * Append evidence to an existing hypothesis.
 */
export function addEvidence(id, evidenceText) {
  const db = getDb();
  const row = db.prepare('SELECT evidence FROM reasoning_journal WHERE id = ?').get(id);
  if (!row) {
    log.warn({ id }, 'addEvidence: hypothesis not found');
    return null;
  }
  let arr;
  try { arr = JSON.parse(row.evidence); } catch { arr = []; }
  arr.push({ text: evidenceText, ts: Date.now() });
  db.prepare('UPDATE reasoning_journal SET evidence = ? WHERE id = ?').run(JSON.stringify(arr), id);
  log.info({ id, evidenceCount: arr.length }, 'Evidence added');
  return { id, evidenceCount: arr.length };
}

/**
 * Conclude a hypothesis with a final assessment.
 */
export function conclude(id, conclusion, finalConfidence = null) {
  const db = getDb();
  const row = db.prepare('SELECT status FROM reasoning_journal WHERE id = ?').get(id);
  if (!row || row.status !== 'open') {
    log.warn({ id, status: row?.status }, 'conclude: hypothesis not open');
    return null;
  }
  const conf = finalConfidence !== null ? Math.max(0, Math.min(1, finalConfidence)) : null;
  db.prepare(`
    UPDATE reasoning_journal
    SET conclusion = ?, status = 'concluded', concluded_at = ?, confidence = COALESCE(?, confidence)
    WHERE id = ?
  `).run(conclusion, Date.now(), conf, id);
  log.info({ id, conclusion: conclusion.slice(0, 80) }, 'Hypothesis concluded');
  return { id, status: 'concluded' };
}

/**
 * Invalidate a hypothesis (evidence disproved it).
 */
export function invalidate(id, reason) {
  const db = getDb();
  db.prepare(`
    UPDATE reasoning_journal
    SET conclusion = ?, status = 'invalidated', concluded_at = ?
    WHERE id = ? AND status = 'open'
  `).run(reason, Date.now(), id);
  log.info({ id, reason: reason.slice(0, 80) }, 'Hypothesis invalidated');
  return { id, status: 'invalidated' };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * Get the most recent concluded entries.
 */
export function getRecentConclusions(limit = 5) {
  const db = getDb();
  return db.prepare(`
    SELECT id, cycle_num, hypothesis, evidence, conclusion, confidence, concluded_at
    FROM reasoning_journal
    WHERE status = 'concluded'
    ORDER BY concluded_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Get open hypotheses still being investigated.
 */
export function getOpenHypotheses(limit = 3) {
  const db = getDb();
  return db.prepare(`
    SELECT id, cycle_num, hypothesis, evidence, signal_type, confidence, created_at
    FROM reasoning_journal
    WHERE status = 'open'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Build a compact markdown context block for prompt injection.
 * Keeps it under ~200 tokens.
 */
export function formatReasoningContext() {
  const open = getOpenHypotheses(3);
  const concluded = getRecentConclusions(3);

  if (open.length === 0 && concluded.length === 0) return '';

  const parts = ['## Reasoning Journal'];

  if (open.length > 0) {
    parts.push('**Open hypotheses:**');
    for (const h of open) {
      let evidenceCount = 0;
      try { evidenceCount = JSON.parse(h.evidence).length; } catch {}
      parts.push(`- [#${h.id}] ${h.hypothesis.slice(0, 100)} (conf: ${(h.confidence * 100).toFixed(0)}%, ${evidenceCount} evidence)`);
    }
  }

  if (concluded.length > 0) {
    parts.push('**Recent conclusions:**');
    for (const c of concluded) {
      parts.push(`- ${c.hypothesis.slice(0, 60)} → ${(c.conclusion || '').slice(0, 80)} (conf: ${(c.confidence * 100).toFixed(0)}%)`);
    }
  }

  return parts.join('\n');
}

/**
 * Stats for the /reasoning command.
 */
export function getReasoningStats() {
  const db = getDb();
  const counts = db.prepare(`
    SELECT status, COUNT(*) as cnt FROM reasoning_journal GROUP BY status
  `).all();
  const total = db.prepare('SELECT COUNT(*) as cnt FROM reasoning_journal').get()?.cnt || 0;
  const avgConf = db.prepare(`
    SELECT AVG(confidence) as avg FROM reasoning_journal WHERE status = 'concluded'
  `).get()?.avg;

  return {
    total,
    byStatus: Object.fromEntries(counts.map(r => [r.status, r.cnt])),
    avgConcludedConfidence: avgConf ? parseFloat(avgConf.toFixed(2)) : null,
  };
}

/**
 * Prune old entries, keeping the most recent N.
 */
export function pruneOld(keepCount = 200) {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as cnt FROM reasoning_journal').get()?.cnt || 0;
  if (total <= keepCount) return 0;

  const result = db.prepare(`
    DELETE FROM reasoning_journal WHERE id NOT IN (
      SELECT id FROM reasoning_journal ORDER BY created_at DESC LIMIT ?
    )
  `).run(keepCount);
  if (result.changes > 0) {
    log.info({ pruned: result.changes, kept: keepCount }, 'Pruned old reasoning entries');
  }
  return result.changes;
}
