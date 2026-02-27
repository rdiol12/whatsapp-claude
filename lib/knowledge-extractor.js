/**
 * Knowledge Extractor — Weekly cron for extracting stable facts from conversations.
 *
 * Reads conversation history, extracts stable facts/preferences, ingests into Vestige.
 * Once in Vestige, facts can be removed from static MEMORY.md to reduce prompt size.
 *
 * Runs Saturday night as part of proactive maintenance.
 * Uses Haiku for cheap extraction.
 */

import { readFileSync, writeFileSync } from 'fs';
import { createLogger } from './logger.js';
import { chatOneShot } from './claude.js';
import { smartIngest } from './mcp-gateway.js';
import { getState, setState } from './state.js';
import config from './config.js';

const log = createLogger('knowledge-extractor');
const STATE_KEY = 'knowledge-extractor';
const BOT_MEMORY_PATH = config.memoryPath;

/**
 * Extract stable facts from recent conversation history.
 * Uses Haiku one-shot to identify extractable knowledge.
 *
 * @param {Array} messages - Recent conversation messages [{ role, content, ts }]
 * @returns {Array} Extracted facts [{ fact, category, confidence }]
 */
async function extractFacts(messages) {
  if (!messages || messages.length === 0) return [];

  // Build conversation excerpt (last 50 messages, truncated)
  const excerpt = messages.slice(-50).map(m =>
    `[${m.role}] ${(m.content || '').slice(0, 300)}`
  ).join('\n');

  const prompt = `You are a knowledge extractor. Analyze this conversation and extract STABLE facts about the user (the user).

Only extract facts that are:
1. Preferences ("the user prefers X over Y")
2. Personal info ("the user's timezone is X", "the user works on project X")
3. Decisions ("the user decided to use X for Y")
4. Patterns ("the user usually asks about X on Monday mornings")
5. Technical setup ("the user's machine has X", "Project Y uses Z")

Do NOT extract:
- Temporary states ("the user is tired")
- Single-occurrence events
- Facts that might change daily
- Anything already obvious from context

Return a JSON array: [{ "fact": "description", "category": "preference|personal|decision|pattern|technical", "confidence": 0.0-1.0 }]

If no stable facts found, return [].

Conversation:
${excerpt.slice(0, 8000)}`;

  try {
    const { reply } = await chatOneShot(prompt, null, 'haiku');
    const jsonMatch = reply.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const facts = JSON.parse(jsonMatch[0]);
    return Array.isArray(facts) ? facts.filter(f => f.fact && f.confidence > 0.6) : [];
  } catch (err) {
    log.error({ err: err.message }, 'Fact extraction failed');
    return [];
  }
}

/**
 * Ingest extracted facts into Vestige memory.
 * @param {Array} facts - [{ fact, category, confidence }]
 * @returns {number} Number of facts ingested
 */
async function ingestFacts(facts) {
  let ingested = 0;
  for (const f of facts) {
    try {
      await smartIngest(f.fact, {
        source: 'knowledge-extractor',
        category: f.category,
        confidence: f.confidence,
        extractedAt: new Date().toISOString(),
      });
      ingested++;
    } catch (err) {
      log.warn({ fact: f.fact.slice(0, 80), err: err.message }, 'Failed to ingest fact');
    }
  }
  return ingested;
}

/**
 * Check if a fact from MEMORY.md is now in Vestige and can be removed.
 * Returns lines that should be kept (not yet in Vestige).
 */
async function findRedundantMemoryLines(memoryLines) {
  // Simple heuristic: if a line's key terms appear in extracted facts,
  // it's likely redundant. Full semantic search would be better but costs more.
  const state = getState(STATE_KEY);
  const extractedFacts = state.allExtractedFacts || [];
  if (extractedFacts.length === 0) return memoryLines;

  const extractedLower = extractedFacts.map(f => f.toLowerCase());

  return memoryLines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-') === false) return true;

    // Check if this line's content overlaps significantly with extracted facts
    const lineWords = trimmed.toLowerCase().split(/\W+/).filter(w => w.length > 4);
    if (lineWords.length === 0) return true;

    const matchCount = lineWords.filter(w =>
      extractedFacts.some(f => f.includes(w))
    ).length;

    // If >70% of significant words match, consider redundant
    return matchCount / lineWords.length < 0.7;
  });
}

/**
 * Run the weekly knowledge extraction cycle.
 * Called from proactive.js during Saturday night maintenance.
 */
export async function runExtraction() {
  if (!config.knowledgeExtractorEnabled) {
    log.info('Knowledge extractor disabled');
    return { extracted: 0, ingested: 0, skipped: true };
  }

  const state = getState(STATE_KEY);
  const lastRun = state.lastRunAt || 0;
  const weekMs = 7 * 24 * 3600_000;

  // Don't run more than once per week
  if (Date.now() - lastRun < weekMs * 0.9) {
    log.info({ lastRun: new Date(lastRun).toISOString() }, 'Knowledge extractor: too soon since last run');
    return { extracted: 0, ingested: 0, skipped: true };
  }

  log.info('Starting weekly knowledge extraction');

  try {
    // Load recent conversation history
    const { getMessages } = await import('./history.js');
    const messages = getMessages().slice(-100);

    if (messages.length < 10) {
      log.info({ msgCount: messages.length }, 'Not enough messages for extraction');
      setState(STATE_KEY, { lastRunAt: Date.now() });
      return { extracted: 0, ingested: 0, skipped: false };
    }

    // Extract facts
    const facts = await extractFacts(messages);
    log.info({ factCount: facts.length }, 'Facts extracted');

    if (facts.length === 0) {
      setState(STATE_KEY, { lastRunAt: Date.now() });
      return { extracted: 0, ingested: 0, skipped: false };
    }

    // Ingest into Vestige
    const ingested = await ingestFacts(facts);

    // Track all extracted facts for memory dedup
    const allFacts = state.allExtractedFacts || [];
    for (const f of facts) {
      allFacts.push(f.fact);
    }
    // Keep last 200 facts
    if (allFacts.length > 200) allFacts.splice(0, allFacts.length - 200);

    setState(STATE_KEY, {
      lastRunAt: Date.now(),
      lastExtractedCount: facts.length,
      lastIngestedCount: ingested,
      allExtractedFacts: allFacts,
    });

    log.info({ extracted: facts.length, ingested }, 'Knowledge extraction complete');
    return { extracted: facts.length, ingested, skipped: false };
  } catch (err) {
    log.error({ err: err.message }, 'Knowledge extraction failed');
    setState(STATE_KEY, { lastRunAt: Date.now(), lastError: err.message });
    return { extracted: 0, ingested: 0, error: err.message };
  }
}

/**
 * Get extraction statistics.
 */
export function getExtractionStats() {
  const state = getState(STATE_KEY);
  return {
    lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
    lastExtracted: state.lastExtractedCount || 0,
    lastIngested: state.lastIngestedCount || 0,
    totalFactsTracked: (state.allExtractedFacts || []).length,
    lastError: state.lastError || null,
  };
}
