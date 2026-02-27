/**
 * Capability Gaps — Tracks "I can't do X" patterns and proposes skill creation.
 *
 * When the agent repeatedly encounters the same limitation, this module records it.
 * At 3+ occurrences, proposes a new skill. At trust L3, can auto-build via skill-generator.
 */

import { getDb } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('capability-gaps');

/**
 * Record or increment a capability gap.
 * Upserts: if same description+topic exists, increments occurrences.
 */
export function recordGap(description, topic) {
  const db = getDb();
  const existing = db.prepare(
    "SELECT id, occurrences FROM capability_gaps WHERE description = ? AND topic = ? AND status IN ('detected', 'proposed')"
  ).get(description, topic);

  if (existing) {
    db.prepare(
      'UPDATE capability_gaps SET occurrences = occurrences + 1, last_seen = ? WHERE id = ?'
    ).run(Date.now(), existing.id);
    log.info({ id: existing.id, occurrences: existing.occurrences + 1, topic }, 'Capability gap incremented');
    return { id: existing.id, occurrences: existing.occurrences + 1, isNew: false };
  }

  const result = db.prepare(
    'INSERT INTO capability_gaps (description, topic) VALUES (?, ?)'
  ).run(description, topic);
  log.info({ id: result.lastInsertRowid, topic }, 'New capability gap recorded');
  return { id: result.lastInsertRowid, occurrences: 1, isNew: true };
}

/**
 * Get gaps with 3+ occurrences that haven't been proposed or resolved yet.
 */
export function getProposableGaps(threshold = 3) {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM capability_gaps WHERE occurrences >= ? AND status = 'detected' ORDER BY occurrences DESC LIMIT 10"
  ).all(threshold);
}

/**
 * Mark a gap as proposed (skill creation suggested to user).
 */
export function markProposed(id) {
  getDb().prepare("UPDATE capability_gaps SET status = 'proposed' WHERE id = ?").run(id);
}

/**
 * Mark a gap as resolved (skill was created).
 */
export function markResolved(id, skillSlug = null) {
  getDb().prepare(
    "UPDATE capability_gaps SET status = 'resolved', skill_slug = ? WHERE id = ?"
  ).run(skillSlug, id);
}

/**
 * Mark a gap as dismissed (user doesn't want this skill).
 */
export function markDismissed(id) {
  getDb().prepare("UPDATE capability_gaps SET status = 'dismissed' WHERE id = ?").run(id);
}

/**
 * Auto-build a skill for a gap. Only at trust L3.
 * @param {object} gap - The gap record
 * @returns {Promise<string|null>} The created skill slug, or null
 */
export async function autoBuildSkill(gap) {
  try {
    const { getAutonomyLevel } = await import('./trust-engine.js');
    const trust = getAutonomyLevel('create_skill');
    if (trust.level < 3) {
      log.info({ gapId: gap.id, trustLevel: trust.level }, 'Auto-build skipped — trust too low');
      return null;
    }

    const { quickGenerateSkill } = await import('./skill-generator.js');
    const slug = await quickGenerateSkill(gap.description, gap.topic);
    if (slug) {
      markResolved(gap.id, slug);
      log.info({ gapId: gap.id, slug }, 'Auto-built skill for capability gap');
    }
    return slug;
  } catch (err) {
    log.warn({ err: err.message, gapId: gap.id }, 'Auto-build skill failed');
    return null;
  }
}

/**
 * Format a report for the /gaps command.
 */
export function formatGapsReport() {
  const db = getDb();
  const all = db.prepare(
    'SELECT * FROM capability_gaps ORDER BY occurrences DESC LIMIT 20'
  ).all();

  if (all.length === 0) return '_No capability gaps recorded yet._';

  const detected = all.filter(g => g.status === 'detected');
  const proposed = all.filter(g => g.status === 'proposed');
  const resolved = all.filter(g => g.status === 'resolved');

  const lines = ['*Capability Gaps*\n'];
  lines.push(`Total: ${all.length} (${detected.length} detected, ${proposed.length} proposed, ${resolved.length} resolved)`);

  if (detected.length > 0) {
    lines.push('\n*Detected:*');
    for (const g of detected.slice(0, 10)) {
      lines.push(`- [${g.topic}] ${g.description.slice(0, 80)} (${g.occurrences}x)`);
    }
  }
  if (proposed.length > 0) {
    lines.push('\n*Proposed (skill creation suggested):*');
    for (const g of proposed.slice(0, 5)) {
      lines.push(`- [${g.topic}] ${g.description.slice(0, 80)} (${g.occurrences}x)`);
    }
  }
  if (resolved.length > 0) {
    lines.push('\n*Resolved:*');
    for (const g of resolved.slice(0, 5)) {
      lines.push(`- [${g.topic}] → skill: ${g.skill_slug || 'unknown'}`);
    }
  }

  return lines.join('\n');
}
