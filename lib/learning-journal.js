/**
 * Learning Journal — Structured log of action outcomes and learned rules.
 *
 * Entries: { action, context, outcome, lesson, timestamp, trustDelta }
 *
 * Weekly Haiku synthesis into actionable rules:
 * - "When the user asks about costs on Monday mornings, include weekend breakdown"
 * - "Tool X times out after 4h idle — pre-warm with a ping"
 * - "Chain pattern Y has 90% success — promote to auto-execute"
 *
 * Synthesized rules stored in Vestige with high-weight tier.
 * Injected into agent-loop prompt as "lessons from past cycles."
 */

import { createLogger } from './logger.js';
import { getState, setState } from './state.js';
import config from './config.js';

const log = createLogger('learning-journal');
const STATE_KEY = 'learning-journal';

// --- Journal Entry Management ---

/**
 * Add a learning entry to the journal.
 * @param {object} entry - { action, context, outcome, lesson, trustDelta }
 */
export function addEntry(entry) {
  const state = getState(STATE_KEY);
  const entries = state.entries || [];

  entries.push({
    action: entry.action || '',
    context: (entry.context || '').slice(0, 500),
    outcome: entry.outcome || '',
    lesson: entry.lesson || '',
    trustDelta: entry.trustDelta || 0,
    ts: Date.now(),
  });

  // Keep last 200 entries
  if (entries.length > 200) entries.splice(0, entries.length - 200);

  setState(STATE_KEY, { entries });
  log.debug({ action: entry.action, lesson: (entry.lesson || '').slice(0, 80) }, 'Learning entry added');
}

/**
 * Record a lesson from an agent cycle.
 * Convenience function for agent-loop integration.
 */
export function recordLesson(lesson, context = {}) {
  addEntry({
    action: context.action || 'agent_cycle',
    context: context.description || '',
    outcome: context.outcome || 'observed',
    lesson,
    trustDelta: context.trustDelta || 0,
  });
}

/**
 * Get recent journal entries.
 * @param {number} limit - Max entries to return
 * @param {number} days - Window in days
 */
export function getRecentEntries(limit = 20, days = 7) {
  const state = getState(STATE_KEY);
  const cutoff = Date.now() - days * 24 * 3600_000;
  return (state.entries || [])
    .filter(e => e.ts > cutoff)
    .slice(-limit);
}

// --- Synthesized Rules ---

/**
 * Get all synthesized rules (from weekly synthesis).
 */
export function getRules() {
  const state = getState(STATE_KEY);
  return state.rules || [];
}

/**
 * Add a synthesized rule.
 */
export function addRule(rule) {
  const state = getState(STATE_KEY);
  const rules = state.rules || [];

  rules.push({
    rule: rule.rule || rule,
    source: rule.source || 'synthesis',
    confidence: rule.confidence || 0.7,
    createdAt: Date.now(),
    applied: 0,
  });

  // Keep max 50 rules
  if (rules.length > 50) {
    // Evict least-applied rules
    rules.sort((a, b) => b.applied - a.applied);
    rules.length = 50;
  }

  setState(STATE_KEY, { rules });
  log.info({ rule: (typeof rule === 'string' ? rule : rule.rule).slice(0, 80) }, 'Learning rule added');
}

/**
 * Run weekly synthesis — analyze entries and extract actionable rules.
 * Uses Haiku one-shot for cheap synthesis.
 * Called from proactive.js during weekly self-review.
 */
export async function runWeeklySynthesis() {
  const entries = getRecentEntries(50, 7);
  if (entries.length < 5) {
    log.info({ entryCount: entries.length }, 'Not enough entries for synthesis');
    return { synthesized: 0, skipped: true };
  }

  log.info({ entryCount: entries.length }, 'Starting weekly learning synthesis');

  try {
    const { chatOneShot } = await import('./claude.js');

    const entrySummary = entries.map(e =>
      `- Action: ${e.action} | Outcome: ${e.outcome} | Lesson: ${e.lesson}`
    ).join('\n');

    const prompt = `You are analyzing a learning journal from an AI agent. Extract 3-5 actionable rules from these entries.

Entries:
${entrySummary.slice(0, 6000)}

Return a JSON array of rules. Each rule: { "rule": "When X happens, do Y", "confidence": 0.0-1.0 }

Only include rules that:
1. Have clear trigger conditions ("When X happens...")
2. Have specific actions ("...do Y")
3. Are based on multiple entries (patterns, not one-offs)
4. Are actionable by an autonomous agent

Return [] if no clear rules emerge.`;

    const { reply } = await chatOneShot(prompt, null, 'haiku');
    const jsonMatch = reply.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return { synthesized: 0, skipped: false };

    const rules = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(rules)) return { synthesized: 0, skipped: false };

    // Add valid rules
    let added = 0;
    for (const r of rules) {
      if (r.rule && r.confidence > 0.5) {
        addRule(r);
        added++;

        // Also ingest into Vestige for long-term memory
        try {
          const { smartIngest } = await import('./mcp-gateway.js');
          await smartIngest(`Learning rule: ${r.rule}`, {
            source: 'learning-journal',
            confidence: r.confidence,
            type: 'agent_rule',
          });
        } catch {}
      }
    }

    setState(STATE_KEY, { lastSynthesisAt: Date.now(), lastSynthesisCount: added });
    log.info({ synthesized: added, total: rules.length }, 'Weekly synthesis complete');
    return { synthesized: added, skipped: false };
  } catch (err) {
    log.error({ err: err.message }, 'Weekly synthesis failed');
    return { synthesized: 0, error: err.message };
  }
}

/**
 * Format learning context for agent-loop prompt injection.
 * Returns recent rules + top lessons as a compact string.
 */
export function formatLearningContext(maxRules = 5) {
  const rules = getRules().slice(-maxRules);
  if (rules.length === 0) return '';

  const lines = rules.map(r =>
    `- ${r.rule} (confidence: ${Math.round((r.confidence || 0.7) * 100)}%)`
  );

  return `## Lessons from past cycles:\n${lines.join('\n')}`;
}

/**
 * Get learning journal statistics.
 */
export function getJournalStats() {
  const state = getState(STATE_KEY);
  return {
    totalEntries: (state.entries || []).length,
    totalRules: (state.rules || []).length,
    lastSynthesisAt: state.lastSynthesisAt ? new Date(state.lastSynthesisAt).toISOString() : null,
    lastSynthesisCount: state.lastSynthesisCount || 0,
    recentEntries: getRecentEntries(5, 7),
  };
}
