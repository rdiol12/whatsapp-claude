/**
 * Tiered Memory System — local weight overlay on Vestige.
 * Tracks access patterns, frequency, recency, and feedback to classify
 * memories into T1 (core), T2 (active), T3 (archive) tiers.
 * Persists via state.js → data/state/memory-tiers.json
 */

import { createHash } from 'crypto';
import { getState, setState } from './state.js';
import { createLogger } from './logger.js';
import config from './config.js';

const log = createLogger('memory-tiers');
const STATE_KEY = 'memory-tiers';
const MAX_TRACKED = config.memoryTiersMaxTracked;
const PREVIEW_LEN = config.memoryTiersPreviewLen;

// --- Base weights by memory type (from config) ---
const BASE_WEIGHTS = {
  preference: config.memoryTiersBaseWeightPreference,
  explicit:   config.memoryTiersBaseWeightExplicit,
  personal:   config.memoryTiersBaseWeightPersonal,
  decision:   config.memoryTiersBaseWeightDecision,
  deadline:   config.memoryTiersBaseWeightDeadline,
  project:    config.memoryTiersBaseWeightProject,
  action:     config.memoryTiersBaseWeightAction,
  fact:       config.memoryTiersBaseWeightFact,
};

// --- Tier thresholds (from config) ---
const T1_THRESHOLD = config.memoryTiersT1Threshold;
const T2_THRESHOLD = config.memoryTiersT2Threshold;

/**
 * Content-based 8-char hex fingerprint (first 120 chars → md5 → 8 hex).
 */
export function fingerprint(text) {
  const normalized = String(text).trim().slice(0, 120).toLowerCase();
  return createHash('md5').update(normalized).digest('hex').slice(0, 8);
}

function tierFromWeight(weight) {
  if (weight >= T1_THRESHOLD) return 1;
  if (weight >= T2_THRESHOLD) return 2;
  return 3;
}

function calcWeight(entry) {
  const base = BASE_WEIGHTS[entry.type] ?? 0.5;

  // Frequency bonus: 1 + min(mentionCount * factor, max) — caps at multiplier
  const freq = Math.min(config.memoryTiersFrequencyMultiplierCap, 1 + Math.min((entry.mentionCount || 0) * config.memoryTiersFrequencyBonusFactor, config.memoryTiersFrequencyBonusMax));

  // Recency factor: max(0.3, 1.0 - weeksSince * decay) — decay/week, floor 0.3
  const weeksSince = (Date.now() - (entry.lastAccessed || entry.firstSeen || Date.now())) / (7 * 24 * 3600_000);
  const recency = Math.max(0.3, 1.0 - weeksSince * config.memoryTiersDecayPerWeek);

  // Feedback multiplier
  let feedback = 1.0;
  if (entry.userFeedback === 'confirmed') feedback = 1.3;
  else if (entry.userFeedback === 'corrected') feedback = 0.3;

  return Math.min(1.0, base * freq * recency * feedback);
}

function getEntries() {
  const state = getState(STATE_KEY);
  return state.entries || {};
}

function saveEntries(entries) {
  setState(STATE_KEY, { entries });
}

function pruneIfNeeded(entries) {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_TRACKED) return entries;

  // Sort by weight ascending, remove lowest
  const sorted = keys.sort((a, b) => (entries[a].weight || 0) - (entries[b].weight || 0));
  const toRemove = sorted.slice(0, keys.length - MAX_TRACKED);
  for (const k of toRemove) delete entries[k];
  log.info({ pruned: toRemove.length }, 'Pruned low-weight memories');
  return entries;
}

/**
 * Track when Vestige returns a result — increments accessCount, recalculates weight.
 */
export function trackAccess(text) {
  if (!text || text.length < 10) return;
  const fp = fingerprint(text);
  const entries = getEntries();
  const existing = entries[fp];

  if (existing) {
    existing.accessCount = (existing.accessCount || 0) + 1;
    existing.lastAccessed = Date.now();
    existing.weight = calcWeight(existing);
    existing.tier = tierFromWeight(existing.weight);
  } else {
    entries[fp] = {
      fingerprint: fp,
      preview: text.trim().slice(0, PREVIEW_LEN),
      type: 'fact',
      weight: calcWeight({ type: 'fact', firstSeen: Date.now(), lastAccessed: Date.now() }),
      accessCount: 1,
      mentionCount: 0,
      tier: 2,
      firstSeen: Date.now(),
      lastAccessed: Date.now(),
      userFeedback: null,
      tags: [],
    };
    entries[fp].tier = tierFromWeight(entries[fp].weight);
  }

  saveEntries(pruneIfNeeded(entries));
}

/**
 * Track when auto-save ingests a memory — assigns initial weight by type.
 */
export function trackSave(text, type = 'fact', tags = []) {
  if (!text || text.length < 10) return;
  const fp = fingerprint(text);
  const entries = getEntries();

  if (entries[fp]) {
    // Already tracked — just update type if more specific
    if (BASE_WEIGHTS[type] > BASE_WEIGHTS[entries[fp].type]) {
      entries[fp].type = type;
    }
    entries[fp].lastAccessed = Date.now();
    entries[fp].weight = calcWeight(entries[fp]);
    entries[fp].tier = tierFromWeight(entries[fp].weight);
    entries[fp].tags = [...new Set([...(entries[fp].tags || []), ...tags])];
  } else {
    const entry = {
      fingerprint: fp,
      preview: text.trim().slice(0, PREVIEW_LEN),
      type,
      weight: 0,
      accessCount: 0,
      mentionCount: 0,
      tier: 2,
      firstSeen: Date.now(),
      lastAccessed: Date.now(),
      userFeedback: null,
      tags,
    };
    entry.weight = calcWeight(entry);
    entry.tier = tierFromWeight(entry.weight);
    entries[fp] = entry;
  }

  saveEntries(pruneIfNeeded(entries));
  log.info({ fp, type, weight: entries[fp].weight, tier: entries[fp].tier }, 'Memory tracked on save');
}

/**
 * Boost when user re-mentions a memory (exposed for future NLU wiring).
 */
export function trackMention(text) {
  if (!text || text.length < 10) return;
  const fp = fingerprint(text);
  const entries = getEntries();
  if (!entries[fp]) return;

  entries[fp].mentionCount = (entries[fp].mentionCount || 0) + 1;
  entries[fp].lastAccessed = Date.now();
  entries[fp].weight = calcWeight(entries[fp]);
  entries[fp].tier = tierFromWeight(entries[fp].weight);
  saveEntries(entries);
}

/**
 * Record user feedback — 'confirmed' or 'corrected'.
 */
export function recordFeedback(text, feedback) {
  if (!text || !['confirmed', 'corrected'].includes(feedback)) return;
  const fp = fingerprint(text);
  const entries = getEntries();
  if (!entries[fp]) return;

  entries[fp].userFeedback = feedback;
  entries[fp].weight = calcWeight(entries[fp]);
  entries[fp].tier = tierFromWeight(entries[fp].weight);
  saveEntries(entries);
  log.info({ fp, feedback, weight: entries[fp].weight, tier: entries[fp].tier }, 'Feedback recorded');
}

/**
 * Rank raw Vestige results into { t1, t2, t3 } buckets sorted by weight desc.
 * Also calls trackAccess for each result line.
 */
export function rankResults(rawText) {
  if (!rawText) return { t1: [], t2: [], t3: [] };

  const lines = rawText.split('\n').filter(l => l.trim().length >= 10);
  const buckets = { t1: [], t2: [], t3: [] };

  // Load entries once — avoids N disk reads (one per line)
  const entries = getEntries();
  let dirty = false;

  for (const line of lines) {
    const fp = fingerprint(line);
    const existing = entries[fp];

    // Inline trackAccess without re-reading state
    if (existing) {
      existing.accessCount = (existing.accessCount || 0) + 1;
      existing.lastAccessed = Date.now();
      existing.weight = calcWeight(existing);
      existing.tier = tierFromWeight(existing.weight);
    } else {
      entries[fp] = {
        fingerprint: fp,
        preview: line.trim().slice(0, PREVIEW_LEN),
        type: 'fact',
        weight: calcWeight({ type: 'fact', firstSeen: Date.now(), lastAccessed: Date.now() }),
        accessCount: 1,
        mentionCount: 0,
        tier: 2,
        firstSeen: Date.now(),
        lastAccessed: Date.now(),
        userFeedback: null,
        tags: [],
      };
      entries[fp].tier = tierFromWeight(entries[fp].weight);
    }
    dirty = true;

    const entry = entries[fp];
    const item = { text: line.trim(), weight: entry.weight, tier: entry.tier };
    if (entry.tier === 1) buckets.t1.push(item);
    else if (entry.tier === 2) buckets.t2.push(item);
    else buckets.t3.push(item);
  }

  // Single write for all access updates
  if (dirty) saveEntries(pruneIfNeeded(entries));

  // Sort each bucket by weight descending
  buckets.t1.sort((a, b) => b.weight - a.weight);
  buckets.t2.sort((a, b) => b.weight - a.weight);
  buckets.t3.sort((a, b) => b.weight - a.weight);

  return buckets;
}

/**
 * Get top 10 T1 core memory previews (for injection even without Vestige search).
 */
export function getCoreMemories() {
  const entries = getEntries();
  return Object.values(entries)
    .filter(e => e.tier === 1)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)
    .map(e => e.preview);
}

/**
 * Recalculate all weights (recency naturally handles decay).
 * Returns count of entries whose tier changed.
 */
export function runDecay() {
  const entries = getEntries();
  let changed = 0;

  for (const entry of Object.values(entries)) {
    const oldTier = entry.tier;
    entry.weight = calcWeight(entry);
    entry.tier = tierFromWeight(entry.weight);
    if (entry.tier !== oldTier) changed++;
  }

  saveEntries(entries);
  log.info({ total: Object.keys(entries).length, changed }, 'Decay recalculation complete');
  return changed;
}

/**
 * Get T1 (core) memories not accessed in N+ days.
 * Used by spaced repetition to resurface important but dormant memories.
 */
export function getStaleT1Memories(staleDays = 5, limit = 5) {
  const entries = getEntries();
  const cutoff = Date.now() - staleDays * 24 * 3600_000;
  return Object.values(entries)
    .filter(e => e.tier === 1 && (e.lastAccessed || e.firstSeen) < cutoff)
    .sort((a, b) => (a.lastAccessed || a.firstSeen) - (b.lastAccessed || b.firstSeen)) // oldest first
    .slice(0, limit);
}

/**
 * Stats for debugging/dashboard.
 */
export function getTierStats() {
  const entries = getEntries();
  const all = Object.values(entries);
  return {
    total: all.length,
    t1: all.filter(e => e.tier === 1).length,
    t2: all.filter(e => e.tier === 2).length,
    t3: all.filter(e => e.tier === 3).length,
    avgWeight: all.length ? +(all.reduce((s, e) => s + e.weight, 0) / all.length).toFixed(3) : 0,
  };
}
