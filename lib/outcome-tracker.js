/**
 * Outcome Tracker — closes the feedback loop between agent actions and results.
 *
 * Three signals tracked:
 * 1. Cron engagement: did the user respond after a cron delivery?
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

import { randomBytes } from 'crypto';
import { getState, setState } from './state.js';
import { smartIngest } from './mcp-gateway.js';
import { chatOneShot } from './claude.js';
import { createLogger } from './logger.js';
import { logReplyOutcome, aggregateReplyPatterns } from './db.js';

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
// NLU response classifier (rule-based, no LLM cost)
// Classifies any user message into type + topics for pattern analysis.
// ---------------------------------------------------------------------------

// Note: \b word boundaries work only for ASCII (\w chars). Hebrew chars are all \W,
// so pure-Hebrew words use (?:^|[\s,!?.]) prefix + (?=[\s,!?.]|$) lookahead instead.
const QUESTION_RE = /[?？]|\b(what|why|how|when|where|who|which|can you|could you|is it|are you)\b|(?:^|[\s,!?.])(מה|למה|איך|כיצד|מתי|אפשר|האם)(?=[\s,!?.]|$)/i;
const FRUSTRATION_RE = /\b(again|still broken|doesn't work|not working|wtf|why is this|ugh|seriously|not what i)\b|(?:^|[\s,!?.])(לא עובד שוב|עדיין|מה קורה|זה שובר|כל פעם|שוב אותו)(?=[\s,!?.]|$)/i;
const GRATITUDE_RE = /\b(thanks|thank you|nice one|well done|good job|perfect)\b|(?:^|[\s,!?.])(תודה|כל הכבוד|מושלם|אחלה)(?=[\s,!?.]|$)/i;
const GOAL_RE = /\b(goal|milestone|progress|task|done|complete)\b|(?:^|[\s,!?.])(סיים|מטרה|השלמ|יעד)(?=[\s,!?.]|$)/i;
const CODE_RE = /\b(error|bug|crash|fix|deploy|server|npm|git|code|function|api)\b|(?:^|[\s,!?.])(שגיאה|קריסה|תקן)(?=[\s,!?.]|$)/i;
const COST_RE = /\b(cost|price|budget|expensive|cheap)\b|(?:^|[\s,!?.])(כסף|עלות|תקציב|יקר)(?=[\s,!?.]|$)/i;

/**
 * Classify a user message into a type and topic list.
 * Returns: { type: 'question'|'frustration'|'gratitude'|'statement', topics: string[] }
 */
export function classifyUserResponse(text) {
  if (!text || text.trim().length < 2) return { type: 'empty', topics: [] };
  const t = text.trim();

  const topics = [];
  if (GOAL_RE.test(t)) topics.push('goals');
  if (CODE_RE.test(t)) topics.push('code');
  if (COST_RE.test(t)) topics.push('costs');

  let type;
  if (FRUSTRATION_RE.test(t)) type = 'frustration';
  else if (QUESTION_RE.test(t)) type = 'question';
  else if (GRATITUDE_RE.test(t)) type = 'gratitude';
  else type = 'statement';

  return { type, topics };
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
  // Cap in-memory batch to prevent unbounded growth between flushes
  if (sentimentBatch.length > 200) flushSentimentBatch();
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
// Outcome → Memory sync (feeds proposal outcomes back into memory-tiers)
// ---------------------------------------------------------------------------

export async function syncOutcomesToMemory() {
  const results = { promoted: 0, demoted: 0, lowEngagementNoted: 0 };
  try {
    const { recordFeedback } = await import('./memory-tiers.js');
    const proposals = getState('outcome-proposals');
    const synced = getState('outcome-synced-proposals');
    if (!synced.ids) synced.ids = [];

    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 3600_000;

    for (const [id, p] of Object.entries(proposals)) {
      // Skip already-synced proposals
      if (synced.ids.includes(id)) continue;
      // Only process proposals with outcomes from last 7 days
      if (!p.outcome || !p.respondedAt || p.respondedAt < sevenDaysAgo) continue;
      if (!p.topic) continue;

      if (p.outcome === 'approved') {
        recordFeedback(p.topic, 'confirmed');
        results.promoted++;
      } else if (p.outcome === 'rejected') {
        recordFeedback(p.topic, 'corrected');
        results.demoted++;
      }

      synced.ids.push(id);
    }

    // Low-engagement crons → ingest a decision note
    const lowEngagement = getLowEngagementCrons();
    for (const cron of lowEngagement) {
      const noteKey = `low-engagement-${cron.cronId}`;
      if (synced.ids.includes(noteKey)) continue;
      try {
        await smartIngest(
          `[outcome] Cron "${cron.cronName}" has low engagement (${cron.engagementRate}% over ${cron.deliveries} deliveries). Consider adjusting or removing.`,
          ['outcome', 'cron', 'low-engagement'], 'decision', 'outcome-tracker',
          { skipDedup: true }
        );
        results.lowEngagementNoted++;
        synced.ids.push(noteKey);
      } catch {}
    }

    // Cap synced IDs list
    if (synced.ids.length > 500) synced.ids = synced.ids.slice(-500);
    setState('outcome-synced-proposals', synced);

    log.info(results, 'Outcome → memory sync complete');
  } catch (err) {
    log.warn({ err: err.message }, 'Outcome → memory sync failed');
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reply outcome tracking (SQLite) — links each bot reply to user's next action
// ---------------------------------------------------------------------------

let _lastBotReply = null; // { id, sentAt, signal }
const REPLY_WINDOW_MS = 10 * 60_000; // 10-minute capture window

/**
 * Call immediately after the bot sends a WhatsApp message.
 * Returns the bot message ID (used to link user reactions).
 */
export function recordBotReply(signal = 'agent_cycle') {
  const id = randomBytes(4).toString('hex');
  _lastBotReply = { id, sentAt: Date.now(), signal };
  return id;
}

/**
 * Call when a user message arrives. If within the reply window, records
 * the outcome (sentiment + response text) to SQLite.
 */
export function captureUserReaction(userText) {
  if (!_lastBotReply) return;
  const { id, sentAt, signal } = _lastBotReply;
  const windowMs = Date.now() - sentAt;
  if (windowMs > REPLY_WINDOW_MS) {
    _lastBotReply = null;
    return;
  }
  _lastBotReply = null;

  const sentiment = detectActionFeedback(userText, true);
  const classification = classifyUserResponse(userText);
  try {
    logReplyOutcome({
      botMsgId: id,
      signal,
      sentiment,
      classification: JSON.stringify(classification),
      userResponse: userText.slice(0, 200),
      windowMs,
    });
    log.debug({ id, sentiment, signal, windowMs, classification }, 'Reply outcome captured');
  } catch (err) {
    log.warn({ err: err.message }, 'Reply outcome capture failed');
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

/**
 * Aggregate reply patterns by message type and topic (30-day window).
 * Returns { byType, byTopic, total } — which kinds of messages get positive reactions.
 */
export function aggregatePatternsByTopic(days = 30) {
  try {
    return aggregateReplyPatterns(days);
  } catch (err) {
    log.warn({ err: err.message }, 'aggregatePatternsByTopic failed');
    return { total: 0, byType: {}, byTopic: {} };
  }
}

/**
 * Format aggregated patterns as a human-readable summary string.
 * Returns empty string if no data.
 */
/**
 * Track chain (multi-step workflow) completion for pattern analysis.
 * @param {string} chainSource - Template ID or 'llm'
 * @param {boolean} success - Whether the chain completed successfully
 * @param {object} data - { stepCount, costUsd, durationMs }
 */
export function trackChainCompletion(chainSource, success, data = {}) {
  try {
    const state = getState('outcome-chains');
    const stats = state[chainSource] || { total: 0, successes: 0, failures: 0 };
    stats.total++;
    if (success) stats.successes++;
    else stats.failures++;
    stats.lastAt = Date.now();
    stats.successRate = stats.total > 0 ? Math.round(stats.successes / stats.total * 100) : 0;
    if (data.costUsd) stats.totalCost = (stats.totalCost || 0) + data.costUsd;
    setState('outcome-chains', { [chainSource]: stats });
  } catch (err) {
    log.warn({ err: err.message }, 'trackChainCompletion failed');
  }
}

/**
 * Report an action outcome for trust engine integration (Phase 3).
 * @param {string} actionType - e.g. 'send_message', 'create_cron', 'execute_tool', 'run_chain'
 * @param {boolean} success - Whether the action succeeded
 * @param {object} context - Additional context
 */
export function reportOutcome(actionType, success, context = {}) {
  try {
    const state = getState('outcome-actions');
    const stats = state[actionType] || { total: 0, successes: 0, failures: 0 };
    stats.total++;
    if (success) stats.successes++;
    else stats.failures++;
    stats.lastAt = Date.now();
    stats.successRate = stats.total > 0 ? stats.successes / stats.total : 0;
    setState('outcome-actions', { [actionType]: stats });
  } catch (err) {
    log.warn({ err: err.message }, 'reportOutcome failed');
  }
}

/**
 * Record a learning from an action outcome (Phase 6 integration point).
 * @param {string} action - What was attempted
 * @param {string} outcome - What happened
 * @param {string} lesson - What was learned
 */
export function recordLearning(action, outcome, lesson) {
  try {
    const state = getState('outcome-learnings');
    const entries = state.entries || [];
    entries.push({ action, outcome, lesson, ts: Date.now() });
    if (entries.length > 100) entries.splice(0, entries.length - 100);
    setState('outcome-learnings', { entries });
  } catch (err) {
    log.warn({ err: err.message }, 'recordLearning failed');
  }
}

export function formatPatternInsights(days = 30) {
  try {
    const { total, byType, byTopic } = aggregateReplyPatterns(days);
    if (total === 0) return '';

    const lines = [`*Response patterns (${days}d, ${total} outcomes):*`];

    // Best message types by positive rate
    const types = Object.entries(byType)
      .map(([type, counts]) => {
        const t = counts.positive + counts.negative + counts.neutral;
        const posRate = t > 0 ? Math.round(counts.positive / t * 100) : 0;
        return { type, posRate, total: t };
      })
      .filter(e => e.total >= 2)
      .sort((a, b) => b.posRate - a.posRate);

    if (types.length > 0) {
      lines.push('By type: ' + types.map(e => `${e.type}=${e.posRate}%↑`).join(', '));
    }

    // Topics with negative signal (actionable)
    const badTopics = Object.entries(byTopic)
      .filter(([, c]) => c.negative > 0)
      .sort((a, b) => b[1].negative - a[1].negative)
      .slice(0, 3);

    if (badTopics.length > 0) {
      lines.push('Friction topics: ' + badTopics.map(([t, c]) => `${t}(${c.negative}↓)`).join(', '));
    }

    return lines.join('\n');
  } catch { return ''; }
}
