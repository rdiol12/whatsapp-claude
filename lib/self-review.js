/**
 * Self-review module — analyzes outcome data and suggests behavior adjustments.
 *
 * Looks at:
 * - Proposal outcomes (approved/rejected/snoozed) from outcome-tracker
 * - Cron engagement rates (low engagement = noisy crons)
 * - Agent brain patterns (what's working, what's being rejected)
 *
 * Produces a review summary with actionable suggestions for SOUL.md tuning.
 */

import { getState, setState } from './state.js';
import { createLogger } from './logger.js';

const log = createLogger('self-review');
const STATE_KEY = 'review-history';
const MIN_DATA_POINTS = 5; // Need at least 5 proposals to generate meaningful review

/**
 * Analyze outcome data and generate a review.
 * Returns { summary, suggestions, stats, ts }
 */
export function runReview() {
  const proposals = getState('outcome-proposals') || {};
  const patterns = (getState('agent-patterns') || {}).patterns || [];
  const cronEngagement = getState('outcome-cron-engagement') || {};

  const now = Date.now();
  const weekMs = 7 * 24 * 3600_000;

  // --- Proposal analysis (last 14 days for enough data) ---
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

  // Proposal hit rate
  const totalResponded = approved.length + rejected.length + snoozed.length;
  if (totalResponded >= MIN_DATA_POINTS) {
    const approvalRate = Math.round((approved.length / totalResponded) * 100);
    if (approvalRate < 30) {
      suggestions.push('Low proposal approval rate (' + approvalRate + '%). Consider raising the PROPOSE confidence threshold or being more selective about what to suggest.');
    } else if (approvalRate > 80) {
      suggestions.push('High approval rate (' + approvalRate + '%). Proposals are well-calibrated — consider slightly lowering the threshold to catch more opportunities.');
    }
  }

  // High rejection rate on specific topics
  const rejectionsByTopic = {};
  for (const p of rejected) {
    const topic = p.topic || p.patternKey || 'unknown';
    rejectionsByTopic[topic] = (rejectionsByTopic[topic] || 0) + 1;
  }
  for (const [topic, count] of Object.entries(rejectionsByTopic)) {
    if (count >= 2) {
      suggestions.push(`Topic "${topic}" rejected ${count} times — stop proposing this unless user re-enables.`);
    }
  }

  // Unanswered proposals (user ignoring them = noisy)
  if (unanswered.length > 3 && totalResponded > 0) {
    const ignoreRate = Math.round((unanswered.length / (unanswered.length + totalResponded)) * 100);
    if (ignoreRate > 50) {
      suggestions.push(ignoreRate + '% of proposals ignored. Reduce proposal frequency or improve timing.');
    }
  }

  // Follow-through tracking
  if (approved.length >= 3 && followedThrough.length === 0) {
    suggestions.push('No proposals have been followed through on despite approvals. Check if the execution pipeline is working.');
  }

  // Low engagement crons
  for (const cron of lowEngagement) {
    suggestions.push(`Cron "${cron.cronName}" has ${cron.engagementRate}% engagement after ${cron.deliveries} deliveries — consider disabling or changing schedule.`);
  }

  // Decaying patterns (things user stopped caring about)
  if (decaying.length > 3) {
    suggestions.push(`${decaying.length} patterns are decaying (low confidence, not seen recently). These will auto-prune.`);
  }

  // Summary
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
  summaryParts.push(`*Self-Review (14d)*`);
  summaryParts.push(`Proposals: ${stats.proposalsTotal} total — ${stats.approved} approved, ${stats.rejected} rejected, ${stats.snoozed} snoozed, ${stats.unanswered} unanswered`);
  if (stats.followedThrough > 0) summaryParts.push(`Follow-through: ${stats.followedThrough} completed`);
  summaryParts.push(`Patterns: ${stats.activePatterns} active (${stats.highConfidencePatterns} high-confidence)`);
  if (stats.lowEngagementCrons > 0) summaryParts.push(`Low-engagement crons: ${stats.lowEngagementCrons}`);

  if (suggestions.length > 0) {
    summaryParts.push('');
    summaryParts.push('*Suggestions:*');
    for (const s of suggestions) {
      summaryParts.push(`- ${s}`);
    }
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
  // Keep last 20 reviews
  if (entries.length > 20) entries.splice(0, entries.length - 20);
  setState(STATE_KEY, { entries });

  log.info({ proposalCount: stats.proposalsTotal, suggestions: suggestions.length }, 'Self-review completed');
  return review;
}

/**
 * Get review history.
 */
export function getReviewHistory() {
  const history = getState(STATE_KEY) || {};
  return history.entries || [];
}
