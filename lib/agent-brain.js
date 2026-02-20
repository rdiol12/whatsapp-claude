/**
 * Agent Brain — Observation → Inference → Action loop.
 *
 * Makes the bot self-initiated: it detects patterns from conversation history,
 * metrics, cron health, and system state, then proposes or auto-executes actions.
 *
 * Runs every 30 minutes inside the proactive loop. Rule-based (no LLM cost).
 * Patterns build confidence over time and decay if not re-observed.
 *
 * Safety: max 2 proposals/day, quiet hours respected, destructive actions
 * always require approval, rejection penalizes patterns for 7 days.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger.js';
import { getState, setState } from './state.js';
import { listCrons } from './crons.js';
import { getMetrics, getDetailedMetrics } from './metrics.js';
import { listGoals, getStaleGoals, getUpcomingDeadlines } from './goals.js';
import { isConnected as isMcpConnected } from './mcp-gateway.js';
import { notify } from './notify.js';
import { appendEvent } from './daily-notes.js';
import config from './config.js';

const log = createLogger('agent-brain');

const PATTERNS_KEY = 'agent-patterns';
const PROPOSALS_KEY = 'agent-proposals';
const RATE_KEY = 'agent-rate-limits';
const NOTES_DIR = join(config.dataDir, 'notes');

// --- Confidence thresholds ---

const THRESHOLDS = {
  AUTO_EXECUTE: 0.9,    // Non-destructive actions: save memory, set intention
  PROPOSE: 0.7,         // Reversible actions: create cron, set reminder
  SUGGEST: 0.5,         // Informational: flag, suggest
  MIN_OBSERVE: 0.3,     // Below this, discard
};

const MAX_PROPOSALS_PER_DAY = 2;
const MIN_HOURS_BETWEEN_SAME_TOPIC = 4;
const REJECTION_COOLDOWN_DAYS = 7;
const CONFIDENCE_DECAY_PER_WEEK = 0.05;
const REJECTION_PENALTY = 0.15;
const MAX_PATTERNS = 100;

// --- Pattern Store ---

function loadPatterns() {
  const state = getState(PATTERNS_KEY);
  return state.patterns || [];
}

function savePatterns(patterns) {
  // Prune to max size, keeping highest-confidence ones
  if (patterns.length > MAX_PATTERNS) {
    patterns.sort((a, b) => b.confidence - a.confidence);
    patterns = patterns.slice(0, MAX_PATTERNS);
  }
  setState(PATTERNS_KEY, { patterns });
}

function findPattern(patterns, type, key) {
  return patterns.find(p => p.type === type && p.key === key);
}

function upsertPattern(patterns, { type, key, description, confidence, proposedAction }) {
  let existing = findPattern(patterns, type, key);
  if (existing) {
    existing.occurrences++;
    existing.lastSeen = Date.now();
    // Confidence increases with occurrences, capped at 0.95
    existing.confidence = Math.min(0.95, existing.confidence + 0.05);
    if (description) existing.description = description;
    if (proposedAction) existing.proposedAction = proposedAction;
  } else {
    existing = {
      type,
      key,
      description,
      confidence: confidence || 0.4,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      occurrences: 1,
      proposedAction,
      status: 'observed',
      userFeedback: null,
      feedbackAt: null,
    };
    patterns.push(existing);
  }
  return existing;
}

/**
 * Decay old patterns that haven't been re-observed.
 */
function decayPatterns(patterns) {
  const now = Date.now();
  const weekMs = 7 * 24 * 3600_000;

  for (let i = patterns.length - 1; i >= 0; i--) {
    const p = patterns[i];
    const weeksSinceLastSeen = (now - p.lastSeen) / weekMs;
    if (weeksSinceLastSeen > 1) {
      p.confidence -= CONFIDENCE_DECAY_PER_WEEK * Math.floor(weeksSinceLastSeen);
      if (p.confidence < 0.1) {
        patterns.splice(i, 1); // Remove dead patterns
      }
    }
  }
}

// --- Proposals ---

function loadProposals() {
  const state = getState(PROPOSALS_KEY);
  return state.proposals || [];
}

function saveProposals(proposals) {
  // Keep last 20 proposals
  if (proposals.length > 20) proposals = proposals.slice(-20);
  setState(PROPOSALS_KEY, { proposals });
}

function addProposal(proposals, pattern, message) {
  const proposal = {
    id: `prop_${Date.now().toString(36)}`,
    patternKey: pattern.key,
    patternType: pattern.type,
    message,
    confidence: pattern.confidence,
    status: 'pending',
    createdAt: Date.now(),
    respondedAt: null,
    response: null,
  };
  proposals.push(proposal);
  return proposal;
}

// --- Rate Limiting ---

function canPropose(pattern) {
  const rates = getState(RATE_KEY);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

  // Max proposals per day
  const todayCount = rates[`proposals_${today}`] || 0;
  if (todayCount >= MAX_PROPOSALS_PER_DAY) return false;

  // Min hours between proposals on the same topic
  const lastProposal = rates[`last_${pattern.key}`];
  if (lastProposal && (Date.now() - lastProposal) < MIN_HOURS_BETWEEN_SAME_TOPIC * 3600_000) return false;

  // Rejection cooldown
  if (pattern.userFeedback === 'rejected' && pattern.feedbackAt) {
    if (Date.now() - pattern.feedbackAt < REJECTION_COOLDOWN_DAYS * 24 * 3600_000) return false;
  }

  return true;
}

function recordProposal(patternKey) {
  const rates = getState(RATE_KEY);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const todayKey = `proposals_${today}`;
  setState(RATE_KEY, {
    [todayKey]: (rates[todayKey] || 0) + 1,
    [`last_${patternKey}`]: Date.now(),
  });
}

// ============================================================
// OBSERVERS — scan data sources, return raw observations
// ============================================================

/**
 * Check cron health: consecutive failures, stale jobs, increasing duration.
 */
function observeCronHealth() {
  const observations = [];
  const crons = listCrons();

  for (const job of crons) {
    if (!job.enabled) continue;

    // Consecutive failures
    if (job.state?.consecutiveErrors >= 3) {
      observations.push({
        type: 'cron_failing',
        key: `cron_fail_${job.id}`,
        description: `Cron "${job.name}" has ${job.state.consecutiveErrors} consecutive failures`,
        confidence: Math.min(0.9, 0.6 + job.state.consecutiveErrors * 0.05),
        proposedAction: {
          type: 'suggest',
          message: `Cron "*${job.name}*" has failed ${job.state.consecutiveErrors} times in a row. Last error: ${(job.state.lastStatus || '').slice(0, 100)}\n\nDisable it? Reply "disable ${job.name}" or "skip".`,
        },
      });
    }

    // Stale: hasn't run in 2x its expected interval
    if (job.state?.nextRun && job.state?.lastRun) {
      const expectedInterval = job.state.nextRun - job.state.lastRun;
      const timeSinceLastRun = Date.now() - job.state.lastRun;
      if (expectedInterval > 0 && timeSinceLastRun > expectedInterval * 3) {
        observations.push({
          type: 'cron_stale',
          key: `cron_stale_${job.id}`,
          description: `Cron "${job.name}" hasn't run in ${Math.round(timeSinceLastRun / 3600_000)}h (expected every ${Math.round(expectedInterval / 3600_000)}h)`,
          confidence: 0.7,
          proposedAction: {
            type: 'suggest',
            message: `Cron "*${job.name}*" seems stuck — hasn't run in ${Math.round(timeSinceLastRun / 3600_000)}h. Want me to trigger it manually?`,
          },
        });
      }
    }
  }

  return observations;
}

/**
 * Check metrics for anomalies: cost spikes, error rate increases.
 */
function observeMetricsAnomalies() {
  const observations = [];
  const metricsState = getState('metrics');

  // Compare today to 7-day average
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const todayData = metricsState[`day_${today}`];
  if (!todayData) return observations;

  // Gather last 7 days
  const pastDays = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `day_${d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })}`;
    const data = metricsState[key];
    if (data) pastDays.push(data);
  }

  if (pastDays.length < 2) return observations; // Need history to compare

  // Cost spike
  const avgCost = pastDays.reduce((s, d) => s + (d.costUsd || 0), 0) / pastDays.length;
  if (avgCost > 0 && todayData.costUsd > avgCost * 2.5) {
    observations.push({
      type: 'cost_spike',
      key: `cost_spike_${today}`,
      description: `Today's cost ($${todayData.costUsd.toFixed(2)}) is ${(todayData.costUsd / avgCost).toFixed(1)}x the 7-day avg ($${avgCost.toFixed(2)})`,
      confidence: 0.85,
      proposedAction: {
        type: 'alert',
        message: `*Cost spike:* Today's spend is $${todayData.costUsd.toFixed(2)} — ${(todayData.costUsd / avgCost).toFixed(1)}x your 7-day average ($${avgCost.toFixed(2)}/day).`,
      },
    });
  }

  // Error rate spike
  const avgErrors = pastDays.reduce((s, d) => s + (d.errors || 0), 0) / pastDays.length;
  if (todayData.errors > 5 && avgErrors > 0 && todayData.errors > avgErrors * 3) {
    observations.push({
      type: 'error_spike',
      key: `error_spike_${today}`,
      description: `${todayData.errors} errors today vs ${avgErrors.toFixed(1)} avg`,
      confidence: 0.8,
      proposedAction: {
        type: 'alert',
        message: `*Error spike:* ${todayData.errors} errors today vs ${avgErrors.toFixed(1)} average. Something may be wrong.`,
      },
    });
  }

  return observations;
}

/**
 * Check system health: memory usage, MCP connection, disk.
 */
function observeSystemHealth() {
  const observations = [];
  const mem = process.memoryUsage();
  const rssМb = Math.round(mem.rss / 1048576);

  // High memory
  if (rssМb > 450) {
    observations.push({
      type: 'high_memory',
      key: 'high_memory',
      description: `RSS at ${rssМb}MB (limit 512MB)`,
      confidence: rssМb > 480 ? 0.9 : 0.7,
      proposedAction: {
        type: 'alert',
        message: `*Memory warning:* Bot is using ${rssМb}MB of RAM (PM2 limit: 512MB). May restart soon.`,
      },
    });
  }

  // MCP disconnected for a while
  if (!isMcpConnected()) {
    observations.push({
      type: 'mcp_disconnected',
      key: 'mcp_disconnected',
      description: 'Vestige MCP is disconnected',
      confidence: 0.8,
      proposedAction: {
        type: 'alert',
        message: '*Vestige MCP disconnected.* Memory features are degraded.',
      },
    });
  }

  return observations;
}

/**
 * Scan daily notes for recurring conversation patterns.
 * Looks at the last 7 days for repeated topics at similar times.
 */
function observeConversationPatterns() {
  const observations = [];

  // Read last 7 days of notes
  const notesByDay = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const dayName = d.toLocaleDateString('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'long' });
    try {
      const content = readFileSync(join(NOTES_DIR, `${dateStr}.md`), 'utf-8');
      notesByDay.push({ date: dateStr, dayName, content });
    } catch {
      // No notes for this day
    }
  }

  if (notesByDay.length < 3) return observations; // Need at least 3 days

  // Extract time-tagged entries
  const entries = [];
  for (const day of notesByDay) {
    const lines = day.content.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*-\s*\*\*(\d{2}:\d{2})\*\*\s*(.*)/);
      if (match) {
        const hour = parseInt(match[1].split(':')[0]);
        const text = match[2].toLowerCase();
        entries.push({ date: day.date, dayName: day.dayName, hour, text });
      }
    }
  }

  // Group by keyword and detect recurring topics
  const topicCounts = {};
  const TOPIC_KEYWORDS = [
    { pattern: /cost|spend|budget|עלו|הוצא/, topic: 'cost_check' },
    { pattern: /status|health|מצב|בריא/, topic: 'status_check' },
    { pattern: /cron|schedul|תזמון/, topic: 'cron_management' },
    { pattern: /backup|גיבו/, topic: 'backup' },
    { pattern: /deploy|ship|דיפלו/, topic: 'deployment' },
    { pattern: /goal|יעד|מטר/, topic: 'goal_review' },
  ];

  for (const entry of entries) {
    for (const { pattern, topic } of TOPIC_KEYWORDS) {
      if (pattern.test(entry.text)) {
        if (!topicCounts[topic]) topicCounts[topic] = { days: new Set(), hours: [], dayNames: new Set() };
        topicCounts[topic].days.add(entry.date);
        topicCounts[topic].hours.push(entry.hour);
        topicCounts[topic].dayNames.add(entry.dayName);
      }
    }
  }

  // Detect patterns: same topic on 3+ different days
  for (const [topic, data] of Object.entries(topicCounts)) {
    if (data.days.size >= 3) {
      // Find most common hour
      const hourCounts = {};
      for (const h of data.hours) {
        const bucket = Math.round(h); // round to nearest hour
        hourCounts[bucket] = (hourCounts[bucket] || 0) + 1;
      }
      const topHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];
      const hourStr = topHour ? `~${topHour[0]}:00` : '';

      // Check if same day of week
      const dayPattern = data.dayNames.size <= 2 ? [...data.dayNames].join('/') : '';

      const topicLabel = topic.replace(/_/g, ' ');
      observations.push({
        type: 'recurring_query',
        key: `recurring_${topic}`,
        description: `"${topicLabel}" appears on ${data.days.size}/7 days${hourStr ? ` around ${hourStr}` : ''}${dayPattern ? ` on ${dayPattern}` : ''}`,
        confidence: Math.min(0.85, 0.4 + data.days.size * 0.1),
        proposedAction: {
          type: 'create_cron',
          message: `I noticed you check *${topicLabel}* frequently${hourStr ? ` around ${hourStr}` : ''}${dayPattern ? ` on ${dayPattern}` : ''}. Want me to auto-send a ${topicLabel} report${hourStr ? ` at ${hourStr}` : ' daily'}?`,
        },
      });
    }
  }

  return observations;
}

/**
 * Check goal health: goals without milestones, abandoned-looking goals.
 */
function observeGoalHealth() {
  const observations = [];
  const active = listGoals({ status: ['active', 'in_progress', 'blocked'] });

  for (const goal of active) {
    // Goal with no milestones and no progress update in a week
    if (goal.milestones.length === 0 && goal.progress === 0) {
      const daysSinceUpdate = (Date.now() - goal.updatedAt) / (24 * 3600_000);
      if (daysSinceUpdate > 7) {
        observations.push({
          type: 'goal_no_milestones',
          key: `goal_noms_${goal.id}`,
          description: `Goal "${goal.title}" has no milestones and no progress for ${Math.round(daysSinceUpdate)} days`,
          confidence: 0.6,
          proposedAction: {
            type: 'suggest',
            message: `Goal "*${goal.title}*" has been active for ${Math.round(daysSinceUpdate)} days with no milestones. Want me to break it into milestones, or should we abandon it?`,
          },
        });
      }
    }

    // Blocked goal with no update in 3+ days
    if (goal.status === 'blocked') {
      const daysSinceUpdate = (Date.now() - goal.updatedAt) / (24 * 3600_000);
      if (daysSinceUpdate > 3) {
        observations.push({
          type: 'goal_stuck',
          key: `goal_stuck_${goal.id}`,
          description: `Goal "${goal.title}" has been blocked for ${Math.round(daysSinceUpdate)} days`,
          confidence: 0.65,
          proposedAction: {
            type: 'suggest',
            message: `Goal "*${goal.title}*" has been blocked for ${Math.round(daysSinceUpdate)} days. Want to unblock it, break it down differently, or abandon it?`,
          },
        });
      }
    }
  }

  return observations;
}

// ============================================================
// INFERENCE ENGINE — process observations into actions
// ============================================================

/**
 * Process all observations, update pattern store, generate actions.
 * Returns { alerts: string[], proposals: string[] } to send.
 */
function processObservations(allObservations, sendFn) {
  const patterns = loadPatterns();
  const proposals = loadProposals();
  const alerts = [];
  const proposalMessages = [];

  // Decay old patterns
  decayPatterns(patterns);

  // Process each observation
  for (const obs of allObservations) {
    const pattern = upsertPattern(patterns, obs);

    // Determine action based on confidence
    if (pattern.confidence >= THRESHOLDS.AUTO_EXECUTE && obs.proposedAction?.type === 'alert') {
      // Auto-execute: send alert immediately (non-destructive)
      alerts.push(obs.proposedAction.message);
      pattern.status = 'executed';
      appendEvent('agent-brain', `Auto-alert: ${obs.description}`);
      log.info({ type: obs.type, key: obs.key, confidence: pattern.confidence.toFixed(2) }, 'Auto-executing alert');
    } else if (pattern.confidence >= THRESHOLDS.PROPOSE && canPropose(pattern)) {
      // Propose: send to user for approval
      const msg = `*Agent observation:*\n${obs.proposedAction?.message || obs.description}\n\nConfidence: ${Math.round(pattern.confidence * 100)}%\n_Reply "do it" to approve, "skip" to dismiss, or "later" to snooze._`;
      proposalMessages.push(msg);
      addProposal(proposals, pattern, msg);
      recordProposal(pattern.key);
      pattern.status = 'proposed';
      appendEvent('agent-brain', `Proposed: ${obs.description} (${Math.round(pattern.confidence * 100)}%)`);
      log.info({ type: obs.type, key: obs.key, confidence: pattern.confidence.toFixed(2) }, 'Sending proposal');
    } else if (pattern.confidence >= THRESHOLDS.SUGGEST && canPropose(pattern)) {
      // Suggest: informational, no action needed
      // Only suggest for high-value patterns (3+ occurrences)
      if (pattern.occurrences >= 3) {
        proposalMessages.push(`*Observation:* ${obs.description}`);
        appendEvent('agent-brain', `Observation: ${obs.description}`);
      }
    }
    // Below SUGGEST threshold: just observe and accumulate
  }

  // Save state
  savePatterns(patterns);
  saveProposals(proposals);

  return { alerts, proposals: proposalMessages };
}

// ============================================================
// BRAIN CYCLE — called from proactive loop
// ============================================================

/**
 * Main brain cycle. Called every 30 minutes from proactive.js.
 * @param {Function} sendFn - Send WhatsApp message
 */
export async function agentBrainCycle(sendFn) {
  const cycleStart = Date.now();

  try {
    // Gather all observations
    const observations = [
      ...observeCronHealth(),
      ...observeMetricsAnomalies(),
      ...observeSystemHealth(),
      ...observeConversationPatterns(),
      ...observeGoalHealth(),
    ];

    if (observations.length === 0) {
      log.debug('Brain cycle: no observations');
      return;
    }

    log.info({ observationCount: observations.length }, 'Brain cycle: processing observations');

    // Process and generate actions
    const { alerts, proposals } = processObservations(observations, sendFn);

    // Send alerts via Telegram (immediate, not WhatsApp to avoid noise)
    for (const alert of alerts) {
      notify(alert);
    }

    // Send proposals via WhatsApp (user-facing)
    for (const proposal of proposals) {
      if (sendFn) await sendFn(proposal);
    }

    const cycleMs = Date.now() - cycleStart;
    log.info({ cycleMs, observations: observations.length, alerts: alerts.length, proposals: proposals.length }, 'Brain cycle complete');
  } catch (err) {
    log.warn({ err: err.message }, 'Brain cycle failed (non-critical)');
  }
}

// ============================================================
// FEEDBACK HANDLING — called when user responds to a proposal
// ============================================================

/**
 * Check if a user message is a response to a pending proposal.
 * Returns the action to take or null.
 */
export function checkProposalResponse(userText) {
  const proposals = loadProposals();
  const pending = proposals.filter(p => p.status === 'pending');
  if (pending.length === 0) return null;

  const text = userText.trim().toLowerCase();

  // Check for approval
  const APPROVE = /^(do it|yes|sure|go ahead|approve|ok|yeah|yep|כן|יאללה|סבבה|תעשה|עשה|בוא)/i;
  const REJECT = /^(no|skip|don't|nope|nah|pass|dismiss|לא|עזוב|דלג|תשכח|לא צריך)/i;
  const SNOOZE = /^(later|not now|remind|snooze|אח.?כ|לא עכשיו|תזכיר|מאוחר)/i;

  let feedback = null;
  if (APPROVE.test(text)) feedback = 'approved';
  else if (REJECT.test(text)) feedback = 'rejected';
  else if (SNOOZE.test(text)) feedback = 'snoozed';
  else return null; // Not a response to a proposal

  // Apply feedback to the most recent pending proposal
  const latest = pending[pending.length - 1];
  latest.status = feedback;
  latest.respondedAt = Date.now();
  latest.response = text;

  // Update the pattern's feedback
  const patterns = loadPatterns();
  const pattern = findPattern(patterns, latest.patternType, latest.patternKey);
  if (pattern) {
    pattern.userFeedback = feedback;
    pattern.feedbackAt = Date.now();

    if (feedback === 'rejected') {
      pattern.confidence = Math.max(0.1, pattern.confidence - REJECTION_PENALTY);
      log.info({ key: pattern.key, newConfidence: pattern.confidence.toFixed(2) }, 'Pattern rejected, confidence penalized');
    } else if (feedback === 'approved') {
      pattern.confidence = Math.min(0.95, pattern.confidence + 0.1);
      pattern.status = 'approved';
      log.info({ key: pattern.key }, 'Pattern approved');
    }
    // Snoozed: no confidence change, will re-propose after cooldown

    savePatterns(patterns);
  }

  saveProposals(proposals);
  appendEvent('agent-brain', `Feedback: ${feedback} for ${latest.patternKey}`);

  return { feedback, proposal: latest, pattern };
}

// ============================================================
// STATUS / REPORTING
// ============================================================

/**
 * Get brain status for /brain command.
 */
export function getBrainStatus() {
  const patterns = loadPatterns();
  const proposals = loadProposals();
  const rates = getState(RATE_KEY);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const todayProposals = rates[`proposals_${today}`] || 0;

  const parts = [];
  parts.push(`*Agent Brain*`);
  parts.push(`Patterns: ${patterns.length} tracked`);
  parts.push(`Proposals today: ${todayProposals}/${MAX_PROPOSALS_PER_DAY}`);

  // Active patterns (confidence > 0.5)
  const active = patterns
    .filter(p => p.confidence >= THRESHOLDS.SUGGEST)
    .sort((a, b) => b.confidence - a.confidence);

  if (active.length > 0) {
    parts.push('');
    parts.push('*Detected patterns:*');
    for (const p of active.slice(0, 8)) {
      const status = p.status === 'proposed' ? ' (proposed)' : p.status === 'approved' ? ' (approved)' : p.status === 'executed' ? ' (acted)' : '';
      parts.push(`- ${p.description} [${Math.round(p.confidence * 100)}%]${status}`);
    }
  }

  // Recent proposals
  const recent = proposals.filter(p => Date.now() - p.createdAt < 7 * 24 * 3600_000);
  if (recent.length > 0) {
    parts.push('');
    parts.push(`*Recent proposals (${recent.length}):*`);
    for (const p of recent.slice(-5)) {
      const ago = Math.round((Date.now() - p.createdAt) / 3600_000);
      parts.push(`- ${p.patternKey}: ${p.status} (${ago}h ago)`);
    }
  }

  return parts.join('\n');
}
