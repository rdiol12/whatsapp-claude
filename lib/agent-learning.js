/**
 * lib/agent-learning.js — Extract learning insights from agent's execution history.
 *
 * Used during reflection cycles (ALWAYS_THINK_EVERY) to help the agent improve
 * future decision-making by analyzing:
 * - Recent errors and patterns
 * - Cost trends and model performance
 * - Successful actions and outcomes
 * - Blocked signals and unresolved issues
 */

import { createLogger } from './logger.js';
import { getRecoveryStats } from './error-recovery.js';
import { getState } from './state.js';
import { getDb } from './db.js';

const log = createLogger('agent-learning');

/**
 * Build a learning context block for reflection cycles.
 * Extracts insights from recent execution history.
 * @returns {string} Markdown-formatted learning context or empty string if no insights
 */
export function getLearningContext() {
  try {
    const insights = [];

    // 1. Error patterns and recovery stats
    const recoveryStats = getRecoveryStats();
    if (recoveryStats.activePatterns > 0) {
      const topErrors = recoveryStats.patterns.slice(0, 3);
      const errorSummary = topErrors.map(e =>
        `  - "${e.rootCause}": ${e.count}× (last: ${new Date(e.lastSeen).toLocaleString('en-IL')})`
      ).join('\n');
      insights.push(`## Recent error patterns:\n${errorSummary}`);
    }

    // 2. Cost trends — compare last 7 days to historical
    const costTrend = analyzeCostTrend();
    if (costTrend) insights.push(costTrend);

    // 3. Signal effectiveness — which signal types are being resolved?
    const signalInsights = analyzeSignalResolution();
    if (signalInsights) insights.push(signalInsights);

    // 4. Goal progress momentum
    const goalMomentum = analyzeGoalMomentum();
    if (goalMomentum) insights.push(goalMomentum);

    // 5. High-priority blockers
    const blockers = identifyBlockers();
    if (blockers) insights.push(blockers);

    if (insights.length === 0) return '';
    return `<learning>\n${insights.join('\n\n')}\n</learning>`;
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to build learning context');
    return '';
  }
}

/**
 * Analyze cost trends over time.
 */
function analyzeCostTrend() {
  try {
    const db = getDb();
    const now = Date.now();
    const dayMs = 24 * 3600 * 1000;

    // Get costs from last 7 days
    const costs = db.prepare(`
      SELECT DATE(ts / 1000, 'unixepoch') as date, SUM(cost_usd) as total, COUNT(*) as calls
      FROM costs
      WHERE ts > ? AND ts <= ?
      GROUP BY date
      ORDER BY date DESC
      LIMIT 7
    `).all(now - 7 * dayMs, now);

    if (costs.length === 0) return null;

    const todaysCost = costs[0]?.total || 0;
    const avgPreviousCost = costs.slice(1).reduce((sum, c) => sum + (c.total || 0), 0) / (costs.length - 1);

    const trend = todaysCost > avgPreviousCost
      ? `📈 Costs trending UP: ${todaysCost.toFixed(2)} USD today vs ${avgPreviousCost.toFixed(2)} avg (↑${((todaysCost / avgPreviousCost - 1) * 100).toFixed(0)}%)`
      : `📉 Costs trending DOWN: ${todaysCost.toFixed(2)} USD today vs ${avgPreviousCost.toFixed(2)} avg`;

    return `## Cost efficiency:\n${trend}\nRecent calls: ${costs[0]?.calls || 0} today`;
  } catch {
    return null;
  }
}

/**
 * Analyze which signal types are being resolved vs accumulated.
 */
function analyzeSignalResolution() {
  try {
    const agentState = getState('agent-loop') || {};
    const lastSignals = agentState.lastSignals || [];

    if (lastSignals.length === 0) return null;

    // Count by type
    const typeCounts = {};
    lastSignals.forEach(s => {
      typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
    });

    const summary = Object.entries(typeCounts)
      .map(([type, count]) => `  - ${type}: ${count}×`)
      .join('\n');

    return `## Signal breakdown (last cycle):\n${summary}\n→ Check if any signals are stuck and need different approach`;
  } catch {
    return null;
  }
}

/**
 * Analyze goal progress momentum — are goals moving forward?
 */
function analyzeGoalMomentum() {
  try {
    const db = getDb();
    const now = Date.now();
    const dayMs = 24 * 3600 * 1000;

    // Get goals modified in last 3 days
    const recentGoals = db.prepare(`
      SELECT id, title, status, progress
      FROM goals
      WHERE updated_at > ?
      ORDER BY updated_at DESC
      LIMIT 10
    `).all(now - 3 * dayMs);

    if (recentGoals.length === 0) return null;

    const active = recentGoals.filter(g => g.status === 'active');
    const completed = recentGoals.filter(g => g.status === 'completed');
    const avgProgress = active.length > 0
      ? (active.reduce((sum, g) => sum + g.progress, 0) / active.length).toFixed(0)
      : 0;

    const summary = `${active.length} active, ${completed.length} completed, avg progress ${avgProgress}%`;
    return `## Goal momentum:\n${summary}\n→ Focus on top-priority goals for sustained progress`;
  } catch {
    return null;
  }
}

/**
 * Identify high-priority blockers from error patterns and signal backlog.
 */
function identifyBlockers() {
  try {
    const recoveryStats = getRecoveryStats();
    const pendingFollowups = (getState('error-recovery') || {}).pendingFollowups || [];

    const blockers = [];

    if (recoveryStats.activePatterns >= 3) {
      blockers.push(`⚠️ ${recoveryStats.activePatterns} active error patterns — may indicate systemic issue`);
    }

    if (pendingFollowups.length >= 5) {
      blockers.push(`⚠️ ${pendingFollowups.length} pending recovery followups — backlog accumulating`);
    }

    if (blockers.length === 0) return null;
    return `## Potential blockers:\n${blockers.map(b => `  ${b}`).join('\n')}`;
  } catch {
    return null;
  }
}
