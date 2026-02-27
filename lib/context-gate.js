/**
 * Context Gate — middleware between every Claude call and the CLI.
 *
 * Measures the context payload and compresses it before it reaches Claude.
 * Combines three concepts:
 *   - Guardian (watchdog): reset_needed when session pressure >80%
 *   - Memory Shepherd (baseline): dedup tracker skips re-injecting identical sections
 *   - Token Spy (economy): sliding budget tightens as session fills
 */

import config from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('context-gate');

// --- FNV-1a hash (fast, non-crypto, good for dedup) ---

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(str) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * FNV_PRIME) >>> 0;
  }
  return hash;
}

// --- Token estimation (Hebrew-aware, mirrors memory-index.js) ---

function estimateTokens(text) {
  if (!text) return 0;
  const hebrewChars = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const ratio = hebrewChars > text.length * 0.3 ? 3.3 : 4;
  return Math.ceil(text.length / ratio);
}

// --- Dedup tracker state ---

/** @type {number[][]} Ring buffer of section hashes per turn */
let recentTurnHashes = [];

/**
 * Register section hashes for the current turn (called after gate runs).
 * @param {number[]} hashes - FNV-1a hashes of each section
 */
export function registerTurnContext(hashes) {
  recentTurnHashes.push(hashes);
  if (recentTurnHashes.length > config.contextGateDedupWindow) {
    recentTurnHashes.shift();
  }
}

/** Clear dedup state (called on session reset). */
export function resetGateState() {
  recentTurnHashes = [];
  log.info('Gate state reset (dedup cleared)');
}

/**
 * Check if a section hash was injected in a recent turn.
 * @param {number} hash
 * @returns {boolean}
 */
function wasRecentlyInjected(hash) {
  for (const turnHashes of recentTurnHashes) {
    if (turnHashes.includes(hash)) return true;
  }
  return false;
}

// --- Pressure & budget ---

/**
 * Compute session pressure level and context budget.
 * @param {{ sessionTokens: number, sessionMsgCount: number, tokenLimit: number }} opts
 * @returns {{ pressure: number, level: string, memoryBudget: number }}
 */
export function computeBudget({ sessionTokens, sessionMsgCount, tokenLimit, promptTier = null }) {
  const pressure = tokenLimit > 0 ? sessionTokens / tokenLimit : 0;

  // Discrete level for logging/action decisions (unchanged thresholds)
  let level;
  if (pressure <= config.contextGatePressureLow) level = 'low';
  else if (pressure <= config.contextGatePressureMedium) level = 'medium';
  else if (pressure <= config.contextGatePressureHigh) level = 'high';
  else level = 'critical';

  // Phase 4: Tier-aware budget scaling
  // Minimal tier → aggressively lower budget to save tokens
  // Full tier → use full budget
  let tierMultiplier = 1.0;
  if (promptTier === 'minimal') tierMultiplier = 0.3;
  else if (promptTier === 'standard') tierMultiplier = 0.7;

  // Smooth budget: linear interpolation instead of 4 hard cliffs
  // budget = budgetFull * (1 - pressure), clamped between critical and full
  const budgetFull = config.contextGateBudgetFull;
  const budgetCritical = config.contextGateBudgetCritical;
  const rawBudget = Math.max(budgetCritical, Math.min(budgetFull, budgetFull * (1 - pressure)));
  const memoryBudget = Math.round(rawBudget * tierMultiplier);

  // Phase 4: Suggest a lower prompt tier when pressure is high
  let suggestedTier = null;
  if (level === 'critical') suggestedTier = 'minimal';
  else if (level === 'high') suggestedTier = 'standard';

  return { pressure, level, memoryBudget, suggestedTier };
}

// --- Section priority (lower number = dropped first) ---
// Skills are never dropped per user request.

const SECTION_PRIORITY = {
  "today's activity notes":     1,
  'response style insights':    2,  // agent cycle: pattern data (drop first)
  'goal-linked memories':       2,
  'learning from past cycles':  3,  // agent cycle: learning context
  // skills: NOT in this list — never dropped
  'relevant memories':          4,
  'active intentions':          5,
  'user notes':                 6,
  'relevant goal':              7,
  'triggered intentions':       8,
  'session summary':            9,
  'previous session summary':   9,
  'conversation gap':          10,
  'follow-up detected':        11,
  'tone':                      11,
  'group chat mode':           12,
  'core memories':             13,
  'plugin context':            14,
  'active goals':              15,  // agent cycle: goals (keep)
  'detected signals':          16,  // agent cycle: signals (almost never drop)
  'current context':           99,  // time — never dropped
};

/**
 * Get drop priority for a section header. Lower = dropped first.
 * Returns Infinity for sections that should never be dropped (skills, time).
 */
function getSectionPriority(header) {
  const lower = header.toLowerCase();
  // Skills are never dropped
  if (lower.includes('skill')) return Infinity;
  // Time context is never dropped
  if (lower === 'current context') return 99;

  for (const [key, priority] of Object.entries(SECTION_PRIORITY)) {
    if (lower.includes(key)) return priority;
  }
  // Unknown sections get medium priority
  return 7;
}

// --- Intent-to-keyword mapping for dynamic priority ---

const INTENT_KEYWORDS = {
  goals:   ['goal', 'milestone', 'progress', 'objective'],
  cost:    ['cost', 'spending', 'budget', 'token', 'usage'],
  status:  ['status', 'health', 'uptime', 'queue'],
  cron:    ['cron', 'schedule', 'timer', 'recurring'],
  memory:  ['memor', 'vestige', 'intention', 'remind'],
  notes:   ['note', 'today', 'activity'],
};

/**
 * Compute dynamic priority for a section based on enrichment context.
 * Higher = harder to drop. Returns the boosted priority.
 * @param {{ header: string, body: string, priority: number }} section
 * @param {{ intent?: string|null, activeGoalTitles?: string[], profile?: string }|null} enrichment
 * @returns {number}
 */
function dynamicPriority(section, enrichment) {
  let priority = section.priority;
  if (!enrichment) return priority;

  const headerLower = section.header.toLowerCase();
  const bodyLower = (section.body || '').toLowerCase();

  // Intent boost: if section matches the current NLU intent, +5
  if (enrichment.intent) {
    const keywords = INTENT_KEYWORDS[enrichment.intent];
    if (keywords && keywords.some(kw => headerLower.includes(kw) || bodyLower.slice(0, 200).includes(kw))) {
      priority += 5;
    }
  }

  // Active goal boost: if section body mentions an active goal title, +3
  if (enrichment.activeGoalTitles?.length > 0) {
    for (const title of enrichment.activeGoalTitles) {
      if (title.length >= 4 && bodyLower.includes(title.toLowerCase())) {
        priority += 3;
        break; // one boost is enough
      }
    }
  }

  // Profile boost: coding → protect coding-related; status → protect activity notes
  if (enrichment.profile === 'coding' && (headerLower.includes('memor') || headerLower.includes('skill'))) {
    priority += 2;
  }
  if (enrichment.profile === 'status' && (headerLower.includes('activity') || headerLower.includes('note'))) {
    priority += 4;
  }

  return priority;
}

/**
 * Check if a section matches the current intent (for dedup exception).
 * @param {{ header: string }} section
 * @param {string|null|undefined} intent
 * @returns {boolean}
 */
function sectionMatchesIntent(section, intent) {
  if (!intent) return false;
  const keywords = INTENT_KEYWORDS[intent];
  if (!keywords) return false;
  const headerLower = section.header.toLowerCase();
  return keywords.some(kw => headerLower.includes(kw));
}

// --- Section parsing ---

/**
 * Parse a <context> block into individual sections by ## headers.
 * @param {string} contextBlock - The full <context>...</context> string
 * @returns {{ header: string, body: string, priority: number, hash: number, tokens: number }[]}
 */
function parseSections(contextBlock) {
  // Extract content between <context> tags
  const match = contextBlock.match(/<context>\n?([\s\S]*?)\n?<\/context>/);
  if (!match) return [];

  const content = match[1];
  const sections = [];
  const parts = content.split(/^(## .+)$/m);

  // parts: ['', '## Header1', 'body1', '## Header2', 'body2', ...]
  for (let i = 1; i < parts.length; i += 2) {
    const header = parts[i].replace(/^## /, '').trim().replace(/:$/, '');
    const body = (parts[i + 1] || '').trim();
    const fullText = parts[i] + '\n' + body;
    sections.push({
      header,
      body,
      full: fullText,
      priority: getSectionPriority(header),
      hash: fnv1a(body),
      tokens: estimateTokens(fullText),
    });
  }

  return sections;
}

/**
 * Rebuild a <context> block from sections.
 * @param {{ full: string }[]} sections
 * @returns {string}
 */
function rebuildContext(sections) {
  if (sections.length === 0) return '';
  return '<context>\n' + sections.map(s => s.full).join('\n\n') + '\n</context>\n\n';
}

/**
 * Extract just the time section and user text for critical-pressure minimal payload.
 * @param {string} payload - Full stdin content
 * @returns {string}
 */
function extractMinimalPayload(payload) {
  const sections = parseSections(payload);
  const timeSection = sections.find(s => s.header.toLowerCase().includes('current context'));
  const userText = extractUserText(payload);

  if (timeSection) {
    return '<context>\n' + timeSection.full + '\n</context>\n\n' + userText;
  }
  return userText;
}

/**
 * Extract user text (everything after the </context> block).
 * @param {string} payload
 * @returns {string}
 */
function extractUserText(payload) {
  const contextEnd = payload.indexOf('</context>');
  if (contextEnd === -1) return payload;
  return payload.slice(contextEnd + '</context>'.length).trim();
}

// --- Main gate function ---

/**
 * Context Gate middleware. Measures and compresses the payload before it reaches Claude.
 *
 * @param {string} payload - Full stdin content (context + plugin ctx + user text)
 * @param {{ sessionTokens: number, sessionMsgCount: number, tokenLimit: number }} opts
 * @returns {{ payload: string, action: string, stats: object }}
 */
export function gate(payload, { sessionTokens, sessionMsgCount, tokenLimit, enrichment }) {
  // Predictive: account for expected response tokens so gate acts before we overshoot
  const avgResponseTokens = 2000;
  const effectiveTokens = sessionTokens + avgResponseTokens;
  const { pressure, level, memoryBudget } = computeBudget({ sessionTokens: effectiveTokens, sessionMsgCount, tokenLimit });
  const totalTokens = estimateTokens(payload);
  const budgetTokens = memoryBudget;

  const stats = {
    pressure: Math.round(pressure * 100),
    level,
    totalTokensBefore: totalTokens,
    totalTokensAfter: totalTokens,
    sectionsDropped: 0,
    sectionsTruncated: 0,
    sectionsDeduped: 0,
    action: 'pass',
  };

  // Critical pressure: minimal payload + signal reset
  if (level === 'critical') {
    const minimal = extractMinimalPayload(payload);
    stats.totalTokensAfter = estimateTokens(minimal);
    stats.action = 'reset_needed';
    const hashes = parseSections(minimal).map(s => s.hash);
    registerTurnContext(hashes);
    log.warn({ ...stats }, 'GATE: Critical pressure — minimal payload, reset needed');
    return { payload: minimal, action: 'reset_needed', stats };
  }

  // Parse sections from <context> block
  const hasContext = payload.includes('<context>');
  if (!hasContext) {
    // No context block — pass through
    registerTurnContext([]);
    log.debug({ ...stats }, 'GATE: No context block — pass through');
    return { payload, action: 'pass', stats };
  }

  let sections = parseSections(payload);
  const userText = extractUserText(payload);
  const pluginCtxMatch = payload.match(/## Plugin context:\n[\s\S]*?(?=\n##|\n<\/context>|$)/);
  const pluginCtx = pluginCtxMatch ? pluginCtxMatch[0] : '';

  // Apply dynamic priorities based on enrichment (topic-aware boosting)
  for (const s of sections) {
    s.priority = dynamicPriority(s, enrichment || null);
  }

  // --- Step 1: Dedup (medium+ pressure) ---
  if (level !== 'low' && recentTurnHashes.length > 0) {
    const before = sections.length;
    sections = sections.filter(s => {
      // Never dedup time context or skills
      if (s.priority >= 99 || s.priority === Infinity) return true;
      // Never dedup sections matching current intent (user may be asking about same topic again)
      if (sectionMatchesIntent(s, enrichment?.intent)) return true;
      if (wasRecentlyInjected(s.hash)) {
        stats.sectionsDeduped++;
        return false;
      }
      return true;
    });
    if (stats.sectionsDeduped > 0) {
      log.info({ deduped: stats.sectionsDeduped, before, after: sections.length }, 'GATE: Deduped sections');
    }
  }

  // --- Step 2: Drop sections by priority if over budget ---
  let contextTokens = sections.reduce((sum, s) => sum + s.tokens, 0);

  if (contextTokens > budgetTokens) {
    // Sort by priority ascending (lowest = drop first), stable
    const sortable = sections.map((s, i) => ({ s, i }));
    sortable.sort((a, b) => a.s.priority - b.s.priority || a.i - b.i);

    const toDrop = [];
    let excess = contextTokens - budgetTokens;

    for (const { s, i } of sortable) {
      if (excess <= 0) break;
      // Never drop time (99) or skills (Infinity)
      if (s.priority >= 99) continue;
      toDrop.push(i);
      excess -= s.tokens;
      stats.sectionsDropped++;
    }

    if (toDrop.length > 0) {
      const dropSet = new Set(toDrop);
      sections = sections.filter((_, i) => !dropSet.has(i));
      contextTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
    }
  }

  // --- Step 3: Truncate largest remaining section if still over ---
  if (contextTokens > budgetTokens) {
    // Find largest non-protected section
    let largestIdx = -1;
    let largestTokens = 0;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].priority >= 99) continue; // skip time
      if (sections[i].priority === Infinity) continue; // skip skills
      if (sections[i].tokens > largestTokens) {
        largestTokens = sections[i].tokens;
        largestIdx = i;
      }
    }

    if (largestIdx >= 0) {
      const excess = contextTokens - budgetTokens;
      const charsToRemove = excess * 4; // rough token→char
      const s = sections[largestIdx];
      const truncatedBody = s.body.slice(0, Math.max(s.body.length - charsToRemove, 50));
      s.full = `## ${s.header}\n${truncatedBody}\n[...truncated for context efficiency]`;
      s.body = truncatedBody;
      s.tokens = estimateTokens(s.full);
      stats.sectionsTruncated++;
    }
  }

  // --- Step 4: Rebuild payload ---
  const newContext = rebuildContext(sections);
  // Reconstruct: context + plugin context (if outside <context>) + user text
  let newPayload;

  // Plugin context lives between </context> and user text in the original
  const pluginCtxOutside = payload.includes('## Plugin context:') && !payload.match(/<context>[\s\S]*## Plugin context:[\s\S]*<\/context>/);
  if (pluginCtxOutside && pluginCtx) {
    newPayload = newContext + pluginCtx.trim() + '\n\n' + userText;
  } else {
    newPayload = newContext + userText;
  }

  stats.totalTokensAfter = estimateTokens(newPayload);

  // Determine action
  if (stats.sectionsDropped > 0 || stats.sectionsDeduped > 0) {
    stats.action = 'trimmed';
  }
  if (stats.sectionsTruncated > 0) {
    stats.action = 'compressed';
  }

  // Register hashes for dedup on next turn
  const currentHashes = sections.map(s => s.hash);
  registerTurnContext(currentHashes);

  log.info({
    pressure: stats.pressure,
    level: stats.level,
    tokensBefore: stats.totalTokensBefore,
    tokensAfter: stats.totalTokensAfter,
    dropped: stats.sectionsDropped,
    deduped: stats.sectionsDeduped,
    truncated: stats.sectionsTruncated,
    action: stats.action,
  }, 'GATE: Processed');

  return { payload: newPayload, action: stats.action, stats };
}
