/**
 * Self-Review — weekly agent self-modification loop.
 *
 * Two modes:
 * 1. runReview() — sync analysis for dashboard/IPC (returns stats + suggestions)
 * 2. runSelfReview(sendFn) — async weekly loop that rewrites SOUL.md proactive section
 *
 * Safety: rollback via state, diff logging, length/refusal guards.
 */

import { readFileSync, writeFileSync } from 'fs';
import { chatOneShot } from './claude.js';
import { getState, setState } from './state.js';
import { smartIngest } from './mcp-gateway.js';
import { createLogger } from './logger.js';
import config from './config.js';

const log = createLogger('self-review');
const SOUL_PATH = config.soulPath;
const SECTION_START = '## Proactive Behavior';
const SECTION_END_RE = /^## /m;
const STATE_KEY = 'review-history';
const MIN_DATA_POINTS = 5;

// ---------------------------------------------------------------------------
// SOUL.md section parsing
// ---------------------------------------------------------------------------

function readProactiveSection() {
  try {
    const soul = readFileSync(SOUL_PATH, 'utf-8');
    const startIdx = soul.indexOf(SECTION_START);
    if (startIdx === -1) return { section: '', before: soul, after: '' };

    const afterStart = soul.slice(startIdx + SECTION_START.length);
    const endMatch = afterStart.match(SECTION_END_RE);
    const endIdx = endMatch ? afterStart.indexOf(endMatch[0]) : afterStart.length;

    return {
      section: afterStart.slice(0, endIdx).trim(),
      before: soul.slice(0, startIdx + SECTION_START.length),
      after: endMatch ? '\n\n' + afterStart.slice(endIdx) : '',
    };
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to read SOUL.md');
    return null;
  }
}

function writeProactiveSection(before, newSection, after, oldSection) {
  try {
    // --- ROLLBACK: save previous section before overwriting ---
    try {
      const reviewState = getState('self-review') || {};
      reviewState.previousSection = oldSection;
      setState('self-review', reviewState);
    } catch {}

    // --- DIFF LOG: show what changed ---
    log.info({
      oldLen: oldSection?.length || 0,
      newLen: newSection.length,
      oldPreview: oldSection?.slice(0, 120) || '(empty)',
      newPreview: newSection.slice(0, 120),
    }, 'Self-review diff');

    const updated = `${before}\n\n${newSection}${after}`;
    writeFileSync(SOUL_PATH, updated, 'utf-8');
    log.info({ sectionLen: newSection.length }, 'SOUL.md proactive section updated');
    return true;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to write SOUL.md');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rollback (for /rollback command)
// ---------------------------------------------------------------------------

export function rollbackProactiveSection() {
  const reviewState = getState('self-review') || {};
  const previous = reviewState.previousSection;

  if (!previous) {
    log.warn('No previous section saved — cannot rollback');
    return false;
  }

  const parsed = readProactiveSection();
  if (!parsed) return false;

  try {
    const updated = `${parsed.before}\n\n${previous}${parsed.after}`;
    writeFileSync(SOUL_PATH, updated, 'utf-8');

    // Clear rollback slot so we don't double-rollback
    reviewState.previousSection = null;
    reviewState.rolledBackAt = Date.now();
    setState('self-review', reviewState);

    log.info({ len: previous.length }, 'Rolled back proactive section');
    return true;
  } catch (err) {
    log.error({ err: err.message }, 'Rollback write failed');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

function gatherReviewData() {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 3600_000;
  const sevenDaysAgo = now - 7 * 24 * 3600_000;

  let cronData = [];
  try {
    const engagement = getState('outcome-cron-engagement') || {};
    cronData = Object.values(engagement).map(e => ({
      name: e.cronName,
      deliveries: e.deliveries,
      engagementRate: e.engagementRate,
      negatives: e.negatives || 0,
    })).sort((a, b) => b.deliveries - a.deliveries);
  } catch {}

  let proposalData = [];
  try {
    const proposals = getState('outcome-proposals') || {};
    proposalData = Object.values(proposals)
      .filter(p => p.proposedAt > thirtyDaysAgo)
      .map(p => ({
        topic: p.topic,
        outcome: p.outcome,
        followThrough: p.followThrough,
        confidence: p.confidence,
      }));
  } catch {}

  let sentimentSummary = { positive: 0, negative: 0, total: 0 };
  try {
    const sentiment = getState('outcome-sentiment-history') || {};
    const recent = (sentiment.entries || []).filter(e => e.ts > sevenDaysAgo);
    sentimentSummary = {
      positive: recent.filter(e => e.sentiment === 'positive').length,
      negative: recent.filter(e => e.sentiment === 'negative').length,
      total: recent.length,
    };
  } catch {}

  let previousNotes = '';
  try {
    const reviewState = getState('self-review') || {};
    previousNotes = reviewState.lastNotes || '';
  } catch {}

  return { cronData, proposalData, sentimentSummary, previousNotes };
}

// ---------------------------------------------------------------------------
// LLM review prompt
// ---------------------------------------------------------------------------

function buildReviewPrompt(currentSection, data) {
  const { cronData, proposalData, sentimentSummary, previousNotes } = data;

  const cronLines = cronData.length > 0
    ? cronData.map(c =>
        `- ${c.name}: ${c.deliveries} deliveries, ${c.engagementRate}% engagement, ${c.negatives} negative signals`
      ).join('\n')
    : 'No cron data yet.';

  const proposalLines = proposalData.length > 0
    ? proposalData.map(p =>
        `- "${p.topic}": ${p.outcome || 'no response'}, follow-through: ${p.followThrough || 'pending'}`
      ).join('\n')
    : 'No proposals made yet.';

  return `You are reviewing your own performance as a personal AI agent for the user.
Your job: rewrite the "## Proactive Behavior" section of your SOUL.md based on what the data shows.

## Current proactive behavior rules:
${currentSection || '(none set yet)'}

## Cron engagement data (all time):
${cronLines}

## Proposal outcomes (last 30 days):
${proposalLines}

## Sentiment signals (last 7 days):
- Positive: ${sentimentSummary.positive}
- Negative: ${sentimentSummary.negative}
- Total signals: ${sentimentSummary.total}

${previousNotes ? `## Notes from last self-review:\n${previousNotes}` : ''}

## Your task:

Write a new "## Proactive Behavior" section for SOUL.md.

Rules:
- Be specific and evidence-based. Name crons and topics explicitly.
- BAD: "Be more careful about proposals."
- GOOD: "Do not propose goal reviews — rejected twice. Raise confidence threshold to 0.9 for this topic."
- BAD: "Some crons seem less useful."
- GOOD: "The 'market-briefing' cron has 8% engagement after 12 deliveries. Flag it for disabling."
- If sentiment trending negative: reduce proactive interruptions.
- Keep under 300 words.
- Write as instructions to yourself (second person: "You should...", "Avoid...", "When you see...")
- End with a "## Self-Review Notes" subsection: 1-2 sentences on what you learned, for next week.

Return ONLY the section content (after the ## Proactive Behavior header).
Do not include the header. No preamble. No explanation.`;
}

// ---------------------------------------------------------------------------
// Core async runner — rewrites SOUL.md
// ---------------------------------------------------------------------------

export async function runSelfReview(sendFn) {
  log.info('Starting weekly self-review');

  const parsed = readProactiveSection();
  if (!parsed) {
    log.warn('Could not read SOUL.md — skipping');
    return;
  }

  const data = gatherReviewData();
  const prompt = buildReviewPrompt(parsed.section, data);

  let newSection;
  try {
    const { reply } = await chatOneShot(prompt, null);
    newSection = reply.trim();

    if (newSection.length < 50) {
      log.warn({ len: newSection.length }, 'Output too short — discarding');
      return;
    }
    if (newSection.length > 3000) {
      log.warn({ len: newSection.length }, 'Output too long — truncating');
      newSection = newSection.slice(0, 3000);
    }
    if (/^(I cannot|I'm unable|I don't|Sorry|Error)/i.test(newSection)) {
      log.warn({ preview: newSection.slice(0, 100) }, 'Refusal detected — discarding');
      return;
    }
  } catch (err) {
    log.error({ err: err.message }, 'LLM call failed');
    return;
  }

  // Extract meta notes (for next week)
  let reviewNotes = '';
  const notesMatch = newSection.match(/## Self-Review Notes\s*([\s\S]+?)(?:##|$)/i);
  if (notesMatch) {
    reviewNotes = notesMatch[1].trim();
    newSection = newSection.replace(/## Self-Review Notes[\s\S]+$/, '').trim();
  }

  // Write to SOUL.md (includes backup + diff log)
  const success = writeProactiveSection(parsed.before, newSection, parsed.after, parsed.section);
  if (!success) return;

  // Persist state
  try {
    const reviewState = getState('self-review') || {};
    reviewState.lastNotes = reviewNotes;
    reviewState.lastReviewAt = Date.now();
    reviewState.lastSectionLen = newSection.length;

    // Save diff to history (last 10 reviews)
    if (!reviewState.history) reviewState.history = [];
    reviewState.history.push({
      ts: Date.now(),
      notes: reviewNotes,
      oldLen: parsed.section.length,
      newLen: newSection.length,
      oldPreview: parsed.section.slice(0, 120),
      newPreview: newSection.slice(0, 120),
    });
    if (reviewState.history.length > 10) reviewState.history.shift();

    setState('self-review', reviewState);
  } catch {}

  // Ingest into Vestige
  try {
    await smartIngest(
      `[self-review] Weekly self-review complete. Notes: ${reviewNotes || 'none'}`,
      ['self-review', 'learning', 'soul'],
      'decision',
      'self-review'
    );
  } catch {}

  // Phase 6: Run learning journal weekly synthesis
  try {
    const { runWeeklySynthesis } = await import('./learning-journal.js');
    const synthesis = await runWeeklySynthesis();
    log.info(synthesis, 'Learning journal synthesis complete');
  } catch (err) {
    log.warn({ err: err.message }, 'Learning journal synthesis failed');
  }

  // Notify
  if (sendFn) {
    try {
      await sendFn(
        `*Weekly self-review complete.* Proactive behavior rules updated.\n\n_${reviewNotes || 'No notes this week.'}_\n\nSend /rollback to revert if needed.`
      );
    } catch {}
  }

  log.info({ sectionLen: newSection.length, hasNotes: !!reviewNotes }, 'Self-review complete');
}

export async function runSelfReviewNow(sendFn) {
  return runSelfReview(sendFn);
}

// ---------------------------------------------------------------------------
// Sync analysis for dashboard/IPC — runReview() + getReviewHistory()
// ---------------------------------------------------------------------------

/**
 * Synchronous review analysis for IPC endpoint (POST /review).
 * Returns stats + suggestions without calling LLM or modifying SOUL.md.
 */
export function runReview() {
  const proposals = getState('outcome-proposals') || {};
  const patterns = (getState('agent-patterns') || {}).patterns || [];
  const cronEngagement = getState('outcome-cron-engagement') || {};

  const now = Date.now();
  const weekMs = 7 * 24 * 3600_000;

  // --- Proposal analysis (last 14 days) ---
  const recentProposals = Object.values(proposals).filter(p => p.proposedAt > now - 2 * weekMs);
  const approved = recentProposals.filter(p => p.outcome === 'approved');
  const rejected = recentProposals.filter(p => p.outcome === 'rejected');
  const snoozed = recentProposals.filter(p => p.outcome === 'snoozed');
  const unanswered = recentProposals.filter(p => !p.outcome);
  const followedThrough = recentProposals.filter(p => p.followThrough === 'completed');

  // --- Cron engagement analysis ---
  const cronEntries = Object.values(cronEngagement);
  const lowEngagement = cronEntries.filter(e => e.deliveries >= 5 && e.engagementRate !== null && e.engagementRate <= 20);
  const highEngagement = cronEntries.filter(e => e.deliveries >= 5 && e.engagementRate !== null && e.engagementRate >= 80);

  // --- Pattern analysis ---
  const rejectedPatterns = patterns.filter(p => p.userFeedback === 'rejected');
  const highConfidence = patterns.filter(p => p.confidence >= 0.8);
  const decaying = patterns.filter(p => p.confidence < 0.3 && p.occurrences > 1);

  // --- Generate suggestions ---
  const suggestions = [];

  const totalResponded = approved.length + rejected.length + snoozed.length;
  if (totalResponded >= MIN_DATA_POINTS) {
    const approvalRate = Math.round((approved.length / totalResponded) * 100);
    if (approvalRate < 30) {
      suggestions.push('Low proposal approval rate (' + approvalRate + '%). Consider raising the PROPOSE confidence threshold.');
    } else if (approvalRate > 80) {
      suggestions.push('High approval rate (' + approvalRate + '%). Consider slightly lowering the threshold.');
    }
  }

  const rejectionsByTopic = {};
  for (const p of rejected) {
    const topic = p.topic || p.patternKey || 'unknown';
    rejectionsByTopic[topic] = (rejectionsByTopic[topic] || 0) + 1;
  }
  for (const [topic, count] of Object.entries(rejectionsByTopic)) {
    if (count >= 2) {
      suggestions.push(`Topic "${topic}" rejected ${count} times — stop proposing this.`);
    }
  }

  if (unanswered.length > 3 && totalResponded > 0) {
    const ignoreRate = Math.round((unanswered.length / (unanswered.length + totalResponded)) * 100);
    if (ignoreRate > 50) {
      suggestions.push(ignoreRate + '% of proposals ignored. Reduce frequency.');
    }
  }

  if (approved.length >= 3 && followedThrough.length === 0) {
    suggestions.push('No proposals followed through despite approvals. Check execution pipeline.');
  }

  for (const cron of lowEngagement) {
    suggestions.push(`Cron "${cron.cronName}" has ${cron.engagementRate}% engagement after ${cron.deliveries} deliveries — consider disabling.`);
  }

  if (decaying.length > 3) {
    suggestions.push(`${decaying.length} patterns decaying (low confidence). These will auto-prune.`);
  }

  const stats = {
    proposalsTotal: recentProposals.length,
    approved: approved.length,
    rejected: rejected.length,
    snoozed: snoozed.length,
    unanswered: unanswered.length,
    followedThrough: followedThrough.length,
    activePatterns: patterns.length,
    highConfidencePatterns: highConfidence.length,
    rejectedPatterns: rejectedPatterns.length,
    lowEngagementCrons: lowEngagement.length,
    highEngagementCrons: highEngagement.length,
  };

  const summaryParts = [];
  summaryParts.push('*Self-Review (14d)*');
  summaryParts.push(`Proposals: ${stats.proposalsTotal} total — ${stats.approved} approved, ${stats.rejected} rejected, ${stats.snoozed} snoozed, ${stats.unanswered} unanswered`);
  if (stats.followedThrough > 0) summaryParts.push(`Follow-through: ${stats.followedThrough} completed`);
  summaryParts.push(`Patterns: ${stats.activePatterns} active (${stats.highConfidencePatterns} high-confidence)`);
  if (stats.lowEngagementCrons > 0) summaryParts.push(`Low-engagement crons: ${stats.lowEngagementCrons}`);

  if (suggestions.length > 0) {
    summaryParts.push('');
    summaryParts.push('*Suggestions:*');
    for (const s of suggestions) summaryParts.push(`- ${s}`);
  } else if (recentProposals.length < MIN_DATA_POINTS) {
    summaryParts.push('');
    summaryParts.push(`_Need ${MIN_DATA_POINTS - recentProposals.length} more proposals before generating suggestions._`);
  } else {
    summaryParts.push('');
    summaryParts.push('_No issues found. Keep going._');
  }

  const review = {
    ts: now,
    summary: summaryParts.join('\n'),
    suggestions,
    stats,
    notes: suggestions.length > 0 ? suggestions.join(' | ') : 'No issues found',
  };

  // Save to review history
  const history = getState(STATE_KEY) || {};
  const entries = history.entries || [];
  entries.push(review);
  if (entries.length > 20) entries.splice(0, entries.length - 20);
  setState(STATE_KEY, { entries });

  log.info({ proposalCount: stats.proposalsTotal, suggestions: suggestions.length }, 'Self-review completed');
  return review;
}

/**
 * Get review history for dashboard.
 */
export function getReviewHistory() {
  // Merge both history sources (IPC reviews + SOUL.md rewrite reviews)
  const ipcHistory = getState(STATE_KEY) || {};
  const soulHistory = getState('self-review') || {};
  return {
    reviews: ipcHistory.entries || [],
    soulRewrites: soulHistory.history || [],
    lastSoulRewrite: soulHistory.lastReviewAt || null,
    lastNotes: soulHistory.lastNotes || '',
    canRollback: !!soulHistory.previousSection,
  };
}
