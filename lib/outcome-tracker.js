/**
 * Outcome Tracker — closes the feedback loop between agent actions and results.
 *
 * Three signals tracked:
 * 1. Cron engagement: did Ron respond after a cron delivery?
 * 2. Proposal follow-through: observable actions after approval
 * 3. Goal retrospectives: generated when a goal completes
 *
 * Sentiment only recorded when:
 * - Previous bot turn was an action (cron, proposal, tool)
 * - User reply is short (<50 chars)
 * - Clear signal word matches in near-isolation
 *
 * No per-message disk writes — sentiment batched, flushed every 10 minutes.
 * Every external call wrapped in try/catch — never propagates errors.
 */

import { getState, setState } from './state.js';
import { smartIngest } from './mcp-gateway.js';
import { chatOneShot } from './claude.js';
import { createLogger } from './logger.js';

const log = createLogger('outcome-tracker');

// ---------------------------------------------------------------------------
// Sentiment detection (conservative)
// ---------------------------------------------------------------------------

const POSITIVE_RE = /^[\s\W]*(perfect|great|excellent|exactly|works|fixed it|done|love it|תותח|מעולה|אחלה|מושלם|עובד|כן בדיוק|👍|✅|💯|🔥)[\s\W]*$/i;
const NEGATIVE_RE = /^[\s\W]*(wrong|broken|useless|failed|not what|לא עובד|שגוי|לא מה שביקשתי|👎|❌|nope|garbage)[\s\W]*$/i;

export function detectActionFeedback(text, prevTurnWasAction) {
  if (!text || !prevTurnWasAction) return null;
  const trimmed = text.trim();
  if (trimmed.length > 50) return null;
  // Check negative FIRST — "לא עובד" must not match positive "עובד"
  if (NEGATIVE_RE.test(trimmed)) return 'negative';
  if (POSITIVE_RE.test(trimmed)) return 'positive';
  return null;
}

// ---------------------------------------------------------------------------
// In-memory sentiment batch — flushed every 10 minutes or on shutdown
// ---------------------------------------------------------------------------

let sentimentBatch = [];

function flushSentimentBatch() {
  if (sentimentBatch.length === 0) return;
  try {
    const history = getState('outcome-sentiment-history');
    if (!history.entries) history.entries = [];
    history.entries.push(...sentimentBatch);
    if (history.entries.length > 500) history.entries = history.entries.slice(-500);
    setState('outcome-sentiment-history', history);
    log.debug({ flushed: sentimentBatch.length }, 'Sentiment batch flushed');
    sentimentBatch = [];
  } catch (err) {
    log.warn({ err: err.message }, 'Sentiment flush failed');
  }
}

setInterval(flushSentimentBatch, 10 * 60_000).unref();

export function flushOutcomeState() {
  flushSentimentBatch();
}

export function recordActionFeedback(sentiment, { cronId, proposalId, context }) {
  sentimentBatch.push({ sentiment, cronId: cronId || null, proposalId: proposalId || null, context, ts: Date.now() });
  if (cronId) recordCronEngagement(cronId, sentiment === 'positive' ? 'engaged' : 'negative');
  if (proposalId) _applyProposalSentiment(proposalId, sentiment);
}

// ---------------------------------------------------------------------------
// Proposal tracking
// Named trackProposal (not recordProposal) — avoids collision with
// agent-brain.js's local recordProposal() rate-limit function.
// ---------------------------------------------------------------------------

export function trackProposal(proposalId, { topic, action, confidence, patternKey }) {
  try {
    const proposals = getState('outcome-proposals');
    proposals[proposalId] = {
      proposalId, topic, action, confidence, patternKey,
      proposedAt: Date.now(),
      outcome: null, followThrough: null, sentimentAfter: null,
    };
    // Prune old proposals (keep last 200)
    const keys = Object.keys(proposals);
    if (keys.length > 200) {
      const sorted = keys.sort((a, b) => (proposals[a].proposedAt || 0) - (proposals[b].proposedAt || 0));
      for (const k of sorted.slice(0, keys.length - 200)) delete proposals[k];
    }
    setState('outcome-proposals', proposals);
    log.debug({ proposalId, topic }, 'Proposal tracked');
  } catch {}
}

export function trackProposalOutcome(proposalId, outcome) {
  try {
    const proposals = getState('outcome-proposals');
    if (!proposals[proposalId]) return;
    proposals[proposalId].outcome = outcome;
    proposals[proposalId].respondedAt = Date.now();
    setState('outcome-proposals', proposals);
    log.info({ proposalId, outcome }, 'Proposal outcome tracked');
  } catch {}
}

function _applyProposalSentiment(proposalId, sentiment) {
  try {
    const proposals = getState('outcome-proposals');
    if (!proposals[proposalId]) return;
    proposals[proposalId].sentimentAfter = sentiment;
    setState('outcome-proposals', proposals);
  } catch {}
}

// ---------------------------------------------------------------------------
// Observable follow-through
// ---------------------------------------------------------------------------

export function logObservableAction(type, meta = {}) {
  try {
    const actions = getState('outcome-observable-actions');
    if (!actions.log) actions.log = [];
    actions.log.push({ type, ...meta, ts: Date.now() });
    if (actions.log.length > 200) actions.log = actions.log.slice(-200);
    setState('outcome-observable-actions', actions);
  } catch {}
}

export function checkObservableFollowThrough() {
  try {
    const proposals = getState('outcome-proposals');
    const actions = getState('outcome-observable-actions');
    const now = Date.now();
    let changed = false;

    for (const [id, p] of Object.entries(proposals)) {
      if (p.outcome !== 'approved' || p.followThrough) continue;
      if (now - p.proposedAt < 48 * 3600_000) continue;

      const relevant = (actions.log || []).filter(a =>
        a.ts >= p.proposedAt && a.ts <= p.proposedAt + 48 * 3600_000
      );

      let followThrough = 'no_signal';
      if (relevant.some(a => a.type === 'cron_manual_run' && p.action?.includes('cron'))) followThrough = 'completed';
      else if (relevant.some(a => a.type === 'goal_milestone_added' && p.action?.includes('goal'))) followThrough = 'completed';
      else if (relevant.some(a => a.type === 'positive_feedback')) followThrough = 'completed';

      proposals[id].followThrough = followThrough;
      proposals[id].checkedAt = now;
      changed = true;

      if (followThrough === 'completed') {
        smartIngest(
          `[outcome] Approved proposal "${p.topic}" followed through.`,
          ['outcome', 'learning'], 'decision', 'outcome-tracker'
        ).catch(() => {});
      }
    }

    if (changed) setState('outcome-proposals', proposals);
  } catch {}
}

// ---------------------------------------------------------------------------
// Cron engagement
// ---------------------------------------------------------------------------

export function recordCronDelivery(cronId, cronName) {
  try {
    const engagement = getState('outcome-cron-engagement');
    if (!engagement[cronId]) {
      engagement[cronId] = { cronId, cronName, deliveries: 0, engagements: 0, negatives: 0, lastDelivery: null, lastEngagement: null, engagementRate: null };
    }
    engagement[cronId].deliveries++;
    engagement[cronId].lastDelivery = Date.now();
    // Prune cron engagement entries not seen in 30 days
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    for (const [id, entry] of Object.entries(engagement)) {
      if (entry.lastDelivery && entry.lastDelivery < cutoff) delete engagement[id];
    }
    setState('outcome-cron-engagement', engagement);
  } catch {}
}

export function recordCronEngagement(cronId, type) {
  try {
    const engagement = getState('outcome-cron-engagement');
    if (!engagement[cronId]) return;
    if (type === 'engaged') { engagement[cronId].engagements++; engagement[cronId].lastEngagement = Date.now(); }
    else if (type === 'negative') engagement[cronId].negatives++;
    const e = engagement[cronId];
    e.engagementRate = e.deliveries > 0 ? Math.round((e.engagements / e.deliveries) * 100) : 0;
    setState('outcome-cron-engagement', engagement);
  } catch {}
}

export function getRecentDeliveredCron() {
  try {
    const engagement = getState('outcome-cron-engagement');
    const now = Date.now();
    return Object.values(engagement)
      .filter(e => e.lastDelivery && (now - e.lastDelivery) < 10 * 60_000)
      .sort((a, b) => b.lastDelivery - a.lastDelivery)[0] || null;
  } catch { return null; }
}

export function getLowEngagementCrons(minDeliveries = 5, maxRate = 20) {
  try {
    const engagement = getState('outcome-cron-engagement');
    return Object.values(engagement).filter(e =>
      e.deliveries >= minDeliveries && e.engagementRate !== null && e.engagementRate <= maxRate
    );
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Goal retrospectives
// ---------------------------------------------------------------------------

export async function generateGoalRetrospective(goal) {
  if (!goal || goal.status !== 'completed') return null;
  log.info({ goalId: goal.id, title: goal.title }, 'Generating goal retrospective');

  const milestoneLines = (goal.milestones || []).map(m => {
    const duration = m.completedAt && m.createdAt
      ? `${Math.round((m.completedAt - m.createdAt) / 86400_000)}d`
      : 'unknown';
    return `- ${m.title}: ${m.status} (${duration})`;
  }).join('\n') || 'none tracked';

  const totalDays = goal.completedAt && goal.createdAt
    ? Math.round((goal.completedAt - goal.createdAt) / 86400_000)
    : null;

  const prompt = `Write a brief retrospective for a completed goal. Direct and specific. No bullet points, no headers.

Goal: ${goal.title}
Category: ${goal.category || 'general'}
Total time: ${totalDays !== null ? `${totalDays} days` : 'unknown'}
Milestones:
${milestoneLines}

Write 2-3 sentences: what was achieved, what took longest, one thing to do differently for similar goals next time.`;

  try {
    const { reply } = await chatOneShot(prompt, null);
    const retro = reply.trim();
    if (retro.length < 30) return null;

    goal.retrospective = retro;
    goal.retrospectiveAt = Date.now();

    await smartIngest(
      `[goal-retro] "${goal.title}" (${goal.category || 'general'}, ${totalDays}d): ${retro}`,
      ['goal', 'retrospective', 'learning'], 'decision', 'outcome-tracker'
    );

    log.info({ goalId: goal.id, retroLen: retro.length }, 'Goal retrospective saved');
    return retro;
  } catch (err) {
    log.warn({ err: err.message, goalId: goal.id }, 'Goal retrospective failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function getOutcomeSummary() {
  try {
    const proposals = getState('outcome-proposals');
    const now = Date.now();
    const recent = Object.values(proposals).filter(p => p.proposedAt > now - 7 * 24 * 3600_000);
    const approved = recent.filter(p => p.outcome === 'approved').length;
    const rejected = recent.filter(p => p.outcome === 'rejected').length;
    const completed = recent.filter(p => p.followThrough === 'completed').length;
    const lowEngagement = getLowEngagementCrons();

    const parts = [`*Outcomes (7d):* ${approved} approved, ${rejected} rejected, ${completed} followed through`];
    if (lowEngagement.length > 0) {
      parts.push(`*Low-value crons:* ${lowEngagement.map(e => `${e.cronName} (${e.engagementRate}%)`).join(', ')}`);
    }
    return parts.join('\n');
  } catch { return ''; }
}
