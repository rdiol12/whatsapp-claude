/**
 * Unified Memory Index — single entry point for all memory searches.
 * Replaces scattered Vestige + intentions + goals + notes + daily-notes
 * calls in claude.js with a single search() that deduplicates, scores,
 * and assembles results within a token budget.
 */

import { searchMemories, checkIntentions, listIntentions } from './mcp-gateway.js';
import { rankResults, getCoreMemories, fingerprint, trackMention, recordFeedback } from './memory-tiers.js';
import { matchGoalByTopic, listGoals } from './goals.js';
import { getNotesContext as getUserNotesContext } from './user-notes.js';
import { getTodayNotes } from './daily-notes.js';
import { createLogger } from './logger.js';

const log = createLogger('memory-index');

// --- Vestige result truncation (same as claude.js) ---
const MAX_RESULT_CHARS = 150;

function truncateResult(line) {
  if (line.length > MAX_RESULT_CHARS) return line.slice(0, MAX_RESULT_CHARS) + '\u2026';
  return line;
}

// --- Token estimation ---
function estimateTokens(text) {
  if (!text) return 0;
  const hebrewChars = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const ratio = hebrewChars > text.length * 0.3 ? 3.3 : 4;
  return Math.ceil(text.length / ratio);
}

// --- Mention tracking (boost memories user re-references) ---
let _lastInjectedMemories = [];

/** Extract significant words (4+ chars, no stopwords) from text */
function extractKeywords(text) {
  const stopwords = new Set(['about', 'after', 'again', 'also', 'been', 'before', 'being', 'between', 'both', 'could', 'does', 'doing', 'done', 'each', 'even', 'every', 'from', 'have', 'here', 'into', 'just', 'like', 'made', 'make', 'many', 'more', 'most', 'much', 'must', 'need', 'only', 'other', 'over', 'please', 'same', 'should', 'some', 'still', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'very', 'want', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'your']);
  return text.toLowerCase().split(/\W+/).filter(w => w.length >= 4 && !stopwords.has(w));
}

/**
 * Check if user message re-references any previously injected memories.
 * If so, boost them via trackMention().
 */
function checkMentions(userQuery, currentInjected) {
  if (_lastInjectedMemories.length === 0) return;

  const queryWords = new Set(extractKeywords(userQuery));
  if (queryWords.size === 0) return;

  let mentioned = 0;
  for (const memText of _lastInjectedMemories) {
    const memWords = extractKeywords(memText);
    // If 2+ significant words from the memory appear in user's message → mention
    const overlap = memWords.filter(w => queryWords.has(w)).length;
    if (overlap >= 2) {
      trackMention(memText);
      mentioned++;
    }
  }

  if (mentioned > 0) {
    log.info({ mentioned, lastInjected: _lastInjectedMemories.length }, 'Mention tracking: boosted re-referenced memories');
  }
}

/** Re-export recordFeedback for use by whatsapp.js */
export { recordFeedback } from './memory-tiers.js';

/** Get the last injected memory texts (for feedback detection) */
export function getLastInjectedMemories() {
  return _lastInjectedMemories;
}

// --- Intention cache (moved from claude.js) ---
let _intentionCache = { data: null, ts: 0, msgCount: 0 };
const INTENTION_CACHE_TTL = 5 * 60_000; // 5 minutes
const INTENTION_CACHE_MSG_LIMIT = 3;

async function getCachedIntentions() {
  if (_intentionCache.data &&
      _intentionCache.msgCount < INTENTION_CACHE_MSG_LIMIT &&
      Date.now() - _intentionCache.ts < INTENTION_CACHE_TTL) {
    _intentionCache.msgCount++;
    return _intentionCache.data;
  }
  const data = await listIntentions('active', 10);
  _intentionCache = { data, ts: Date.now(), msgCount: 0 };
  return data;
}

// --- Goal-memory cache (pre-fetched Vestige results for active goals) ---
// Cache keyed by goal ID → { memories: string[], ts: number }
const goalMemoryCache = new Map();
const GOAL_CACHE_TTL = 30 * 60_000; // 30 min

// Prune stale goal cache entries every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of goalMemoryCache) {
    if (now - entry.ts > GOAL_CACHE_TTL) goalMemoryCache.delete(key);
  }
}, 10 * 60_000).unref();

/**
 * Pre-fetch and cache Vestige memories related to a goal's topics.
 * Returns cached results if available and fresh.
 */
async function getGoalMemories(goal) {
  const cached = goalMemoryCache.get(goal.id);
  if (cached && Date.now() - cached.ts < GOAL_CACHE_TTL) return cached.memories;

  // Build a search query from goal title + linkedTopics
  const queryParts = [goal.title, ...(goal.linkedTopics || [])];
  const query = queryParts.join(' ').slice(0, 200);

  try {
    const raw = await searchMemories(query, { limit: 5, min_similarity: 0.6 });
    const memories = raw
      ? raw.split('\n').filter(l => l.trim().length >= 10).map(l => truncateResult(l.trim()))
      : [];
    goalMemoryCache.set(goal.id, { memories, ts: Date.now() });
    log.debug({ goalId: goal.id, count: memories.length }, 'Goal memories cached');
    return memories;
  } catch {
    return [];
  }
}

/**
 * Warm the goal-memory cache for all active goals.
 * Called once at startup or periodically (non-blocking).
 */
export async function warmGoalCache() {
  const active = listGoals({ status: ['active', 'in_progress'] });
  for (const goal of active.slice(0, 5)) { // max 5 goals to avoid flooding
    if (!goalMemoryCache.has(goal.id)) {
      await getGoalMemories(goal).catch(() => {});
    }
  }
  log.info({ cached: goalMemoryCache.size, active: active.length }, 'Goal memory cache warmed');
}

// --- Source bonus scores ---
const SOURCE_BONUS = {
  goal: 0.15,
  note: 0.10,
  t1:   0.20,
};

// --- Helper: collect Vestige scored items ---
function collectVestigeItems(vestigeResults, seenFps, stats) {
  const items = [];
  if (vestigeResults) {
    const ranked = rankResults(vestigeResults);
    stats.vestigeCount = ranked.t1.length + ranked.t2.length + ranked.t3.length;

    for (const item of ranked.t1) {
      const fp = fingerprint(item.text);
      if (seenFps.has(fp)) { stats.dedupRemoved++; continue; }
      seenFps.add(fp);
      items.push({ text: truncateResult(item.text), score: item.weight + SOURCE_BONUS.t1, section: 'Core memories' });
    }
    for (const item of ranked.t2) {
      const fp = fingerprint(item.text);
      if (seenFps.has(fp)) { stats.dedupRemoved++; continue; }
      seenFps.add(fp);
      items.push({ text: truncateResult(item.text), score: item.weight, section: 'Relevant memories' });
    }
    // T3 archive — omitted
    stats.sources.push('vestige');
  } else {
    // Offline fallback: inject core memories from local tier data
    for (const preview of getCoreMemories()) {
      const fp = fingerprint(preview);
      if (seenFps.has(fp)) { stats.dedupRemoved++; continue; }
      seenFps.add(fp);
      items.push({ text: preview, score: 0.7 + SOURCE_BONUS.t1, section: 'Core memories' });
    }
    if (items.length) stats.sources.push('core-fallback');
  }
  return items;
}

// --- Helper: collect goal + linked-memory items ---
async function collectGoalItems(query, tier, profile, isFollowup, seenFps, stats) {
  if (tier < 2 || profile === 'status' || isFollowup) return [];
  const items = [];
  try {
    const relevantGoal = matchGoalByTopic(query);
    if (!relevantGoal) return items;

    const dl = relevantGoal.deadline ? `, deadline: ${new Date(relevantGoal.deadline).toLocaleDateString('en-CA')}` : '';
    const nextMs = relevantGoal.milestones?.find(m => m.status === 'pending');
    const goalText = `*${relevantGoal.title}* (${relevantGoal.progress}%${dl})${nextMs ? `\nNext milestone: "${nextMs.title}"` : ''}`;
    const fp = fingerprint(goalText);
    if (!seenFps.has(fp)) {
      seenFps.add(fp);
      items.push({ text: goalText, score: 0.6 + SOURCE_BONUS.goal, section: 'Relevant goal' });
      stats.sources.push('goal');
    }

    const goalMems = await getGoalMemories(relevantGoal);
    for (const mem of goalMems) {
      const memFp = fingerprint(mem);
      if (seenFps.has(memFp)) { stats.dedupRemoved++; continue; }
      seenFps.add(memFp);
      items.push({ text: mem, score: 0.55 + SOURCE_BONUS.goal, section: 'Goal-linked memories' });
    }
    if (goalMems.length) stats.sources.push('goal-linked');
  } catch {}
  return items;
}

// --- Helper: collect notes blocks (user notes + today's notes) ---
function collectNotesBlocks(maxTokens, includeUserNotes, includeTodayNotes, stats) {
  let userNotesBlock = '';
  let todayNotesBlock = '';

  if (includeUserNotes) {
    try {
      const userNotes = getUserNotesContext();
      if (userNotes) {
        const budget = Math.floor(maxTokens * 0.3);
        userNotesBlock = estimateTokens(userNotes) <= budget
          ? userNotes
          : userNotes.slice(0, budget * 4);
        stats.sources.push('user-notes');
      }
    } catch {}
  }

  if (includeTodayNotes) {
    const todayNotes = getTodayNotes();
    if (todayNotes && todayNotes.length > 100) {
      const budget = Math.floor(maxTokens * 0.2);
      todayNotesBlock = estimateTokens(todayNotes) <= budget
        ? todayNotes
        : todayNotes.slice(-(budget * 4));
      stats.sources.push('today-notes');
    }
  }

  return { userNotesBlock, todayNotesBlock };
}

// --- Helper: fit scored items into token budget, build context block ---
function buildContextBlock(scoredItems, triggeredIntentions, activeIntentions, userNotesBlock, todayNotesBlock, maxTokens, stats) {
  scoredItems.sort((a, b) => b.score - a.score);

  const fixedBudget =
    estimateTokens(userNotesBlock) +
    estimateTokens(todayNotesBlock) +
    estimateTokens(triggeredIntentions || '') +
    estimateTokens(activeIntentions || '');
  let remainingBudget = maxTokens - fixedBudget;

  const sectionItems = {};
  for (const item of scoredItems) {
    const tokens = estimateTokens(item.text);
    if (tokens > remainingBudget) continue;
    remainingBudget -= tokens;
    (sectionItems[item.section] ??= []).push(item.text);
  }

  const parts = [];
  if (sectionItems['Core memories']?.length)
    parts.push(`## Core memories:\n${sectionItems['Core memories'].join('\n')}`);
  if (sectionItems['Relevant memories']?.length)
    parts.push(`## Relevant memories:\n${sectionItems['Relevant memories'].join('\n')}`);
  if (triggeredIntentions)
    parts.push(`## Triggered intentions (act on these):\n${triggeredIntentions}`);
  if (activeIntentions)
    parts.push(`## Active intentions:\n${activeIntentions}`);
  if (sectionItems['Relevant goal']?.length) {
    let goalBlock = `## Relevant goal: ${sectionItems['Relevant goal'][0]}`;
    if (sectionItems['Goal-linked memories']?.length)
      goalBlock += `\nRelated context:\n${sectionItems['Goal-linked memories'].join('\n')}`;
    parts.push(goalBlock);
  }
  if (userNotesBlock)
    parts.push(`## the user's notes:\n${userNotesBlock}`);
  if (todayNotesBlock)
    parts.push(`## Today's activity (recent):\n${todayNotesBlock}`);

  stats.totalTokens = maxTokens - remainingBudget;
  return { contextBlock: parts.join('\n\n'), sectionItems };
}

/**
 * Unified memory search. Returns a context block string ready for injection.
 *
 * @param {string} query - User message text
 * @param {object} opts
 * @param {number} opts.tier - Message tier (1-3)
 * @param {number} opts.maxTokens - Token budget for memory context (default 3000)
 * @param {string} opts.profile - Message profile (coding, status, casual, etc.)
 * @param {boolean} opts.includeIntentions - Whether to fetch intentions
 * @param {boolean} opts.includeTodayNotes - Whether to include today's notes
 * @param {boolean} opts.includeUserNotes - Whether to include user notes
 * @param {boolean} opts.isFollowup - Whether this is a follow-up message
 * @returns {{ contextBlock: string, vestigeMs: number, stats: object }}
 */
export async function search(query, {
  tier = 2,
  maxTokens = 3000,
  profile = 'general',
  includeIntentions = true,
  includeTodayNotes = false,
  includeUserNotes = true,
  isFollowup = false,
} = {}) {
  const start = Date.now();
  const seenFingerprints = new Set();
  const stats = { vestigeCount: 0, dedupRemoved: 0, totalTokens: 0, sources: [] };

  // 1. Parallel fetch: Vestige + intentions
  const skipVestige = profile === 'status' || query.length < 5;
  const searchLimit = tier >= 3 ? 10 : tier >= 2 ? 8 : 5;

  const [vestigeResults, triggeredIntentions, activeIntentions] = await Promise.all([
    skipVestige ? Promise.resolve('') : searchMemories(query, { limit: searchLimit }),
    includeIntentions ? checkIntentions({ topics: [query.slice(0, 200)], current_time: new Date().toISOString() }) : Promise.resolve(''),
    includeIntentions ? getCachedIntentions() : Promise.resolve(''),
  ]);

  const vestigeMs = Date.now() - start;

  // 2. Collect scored items from each source
  const [vestigeItems, goalItems] = await Promise.all([
    Promise.resolve(collectVestigeItems(vestigeResults, seenFingerprints, stats)),
    collectGoalItems(query, tier, profile, isFollowup, seenFingerprints, stats),
  ]);
  const scoredItems = [...vestigeItems, ...goalItems];

  // 3. Notes blocks
  const { userNotesBlock, todayNotesBlock } = collectNotesBlocks(maxTokens, includeUserNotes, includeTodayNotes, stats);

  // 4. Token-budget assembly + context block
  const { contextBlock, sectionItems } = buildContextBlock(
    scoredItems, triggeredIntentions, activeIntentions,
    userNotesBlock, todayNotesBlock, maxTokens, stats
  );

  // 5. Mention tracking (O(1) Set lookup)
  const injectedSet = new Set(Object.values(sectionItems).flat());
  const injectedTexts = scoredItems.filter(i => injectedSet.has(i.text)).map(i => i.text);
  try { checkMentions(query, injectedTexts); } catch {}
  _lastInjectedMemories = injectedTexts;

  log.info({
    vestigeMs, tier, profile,
    vestigeCount: stats.vestigeCount,
    dedupRemoved: stats.dedupRemoved,
    totalTokens: stats.totalTokens,
    sections: Object.keys(sectionItems).length,
    sources: stats.sources.join(','),
  }, 'Memory search complete');

  return { contextBlock, vestigeMs, stats };
}
