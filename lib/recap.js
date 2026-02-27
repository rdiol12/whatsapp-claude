/**
 * Recap — generates a summary of today's bot activity.
 * Used by: /recap command, 22:00 cron, dashboard API, Telegram /recap.
 *
 * Gathers data from daily-notes, vestige memory, workflows, crons,
 * agent brain, goals, and cost metrics. Passes everything to chatOneShot
 * for a 2-4 paragraph first-person reflection.
 *
 * Result stored in state.js under 'last-recap' for dashboard access.
 */

import { chatOneShot } from './claude.js';
import { getTodayNotes, getNotesForDate, listAvailableDates } from './daily-notes.js';
import { memoryTimeline } from './mcp-gateway.js';
import { listWorkflows } from './workflow-engine.js';
import { listCrons } from './crons.js';
import { getBrainStatus } from './agent-brain.js';
import { listGoals } from './goals.js';
import { getCostSummary } from './cost-analytics.js';
import { getSkillUsageStats } from './skill-registry.js';
import { formatPatternInsights } from './outcome-tracker.js';
import { getState, setState } from './state.js';
import { createLogger } from './logger.js';
import config from './config.js';

const log = createLogger('recap');
const STATE_KEY = 'last-recap';
const TZ = config.timezone;

function todayStart() {
  const now = new Date();
  const today = now.toLocaleDateString('en-CA', { timeZone: TZ });
  return new Date(today + 'T00:00:00').getTime();
}

/**
 * Gather raw activity data for today.
 * All operations are safe (return empty/null on failure).
 */
function gatherTodayActivity() {
  const start = todayStart();

  // Today's conversation notes
  const notes = getTodayNotes() || '';

  // Workflows completed or failed today
  let workflows = [];
  try {
    const all = listWorkflows();
    workflows = all.filter(w =>
      (w.completedAt && w.completedAt >= start) ||
      (w.createdAt && w.createdAt >= start)
    ).map(w => ({
      name: w.name,
      status: w.status,
      steps: w.steps,
      completed: w.completed,
      costUsd: w.costUsd,
    }));
  } catch {}

  // Cron runs today (from cron state)
  let cronActivity = [];
  try {
    const crons = listCrons();
    cronActivity = crons
      .filter(j => j.state?.lastRun && j.state.lastRun >= start)
      .map(j => ({
        name: j.name,
        lastRun: j.state.lastRun,
        consecutiveErrors: j.state.consecutiveErrors || 0,
        success: (j.state.consecutiveErrors || 0) === 0,
      }));
  } catch {}

  // Agent brain status (pattern counts, proposals today)
  let brain = '';
  try {
    brain = getBrainStatus();
  } catch {}

  // Active goals snapshot
  let goals = [];
  try {
    goals = listGoals({ status: ['active', 'in_progress', 'completed'] })
      .filter(g => g.status === 'completed'
        ? (g.updatedAt >= start) // only completed today
        : true
      )
      .slice(0, 10)
      .map(g => ({ title: g.title, status: g.status, progress: g.progress }));
  } catch {}

  // Today's cost
  let cost = null;
  try {
    cost = getCostSummary('today');
  } catch {}

  // Skill usage stats (surface unused skills)
  let skillUsage = [];
  try {
    const stats = getSkillUsageStats();
    // Include top 5 used + any never-used
    const used = stats.filter(s => s.count > 0).slice(0, 5);
    const unused = stats.filter(s => s.count === 0);
    skillUsage = { used, unusedCount: unused.length, unusedNames: unused.map(s => s.name) };
  } catch {}

  // Vestige memories ingested today
  let vestige = '';
  // (async, handled separately in generateRecap)

  // Response quality pattern insights (30-day window)
  let patternInsights = '';
  try { patternInsights = formatPatternInsights(30); } catch {}

  return { notes, workflows, cronActivity, brain, goals, cost, skillUsage, vestige, patternInsights };
}

/**
 * Build the prompt for the recap LLM call.
 */
function buildRecapPrompt(activity) {
  const { notes, workflows, cronActivity, brain, goals, cost, skillUsage, vestige, patternInsights } = activity;

  const parts = [];

  parts.push(`You are a personal AI agent writing a brief end-of-day recap for your user.
Write 2-4 short paragraphs. Be direct and specific. Focus on what actually happened.
Do not include headers, bullet points, or formatting. Just prose.
Write in first person as the bot ("I monitored...", "We discussed...", "I ran...").
Be honest about failures. Skip sections where nothing happened.`);

  if (notes && notes.length > 100) {
    parts.push(`\n--- Today's conversation notes ---\n${notes.slice(0, 3000)}`);
  }

  if (vestige && vestige.length > 20) {
    parts.push(`\n--- Memories ingested today ---\n${vestige.slice(0, 1500)}`);
  }

  if (workflows.length > 0) {
    const wfLines = workflows.map(w =>
      `- ${w.name}: ${w.status} (${w.completed}/${w.steps} steps, $${(w.costUsd || 0).toFixed(4)})`
    ).join('\n');
    parts.push(`\n--- Workflows today ---\n${wfLines}`);
  }

  if (cronActivity.length > 0) {
    const cronLines = cronActivity.map(j =>
      `- ${j.name}: ${j.success ? 'OK' : `FAILED (${j.consecutiveErrors} errors)`}`
    ).join('\n');
    parts.push(`\n--- Cron runs today ---\n${cronLines}`);
  }

  if (goals.length > 0) {
    const goalLines = goals.map(g =>
      `- ${g.title}: ${g.status} (${g.progress}%)`
    ).join('\n');
    parts.push(`\n--- Goals ---\n${goalLines}`);
  }

  if (cost && cost.count > 0) {
    parts.push(`\n--- Cost ---\n$${(cost.total || 0).toFixed(4)} today, ${cost.count} messages, ${(cost.inputTokens || 0).toLocaleString()} in / ${(cost.outputTokens || 0).toLocaleString()} out tokens`);
  }

  if (brain && brain.length > 20) {
    parts.push(`\n--- Agent brain ---\n${brain.slice(0, 500)}`);
  }

  if (skillUsage && (skillUsage.used?.length > 0 || skillUsage.unusedCount > 0)) {
    const lines = [];
    if (skillUsage.used?.length > 0) {
      lines.push(`Top used: ${skillUsage.used.map(s => `${s.name} (${s.count}x)`).join(', ')}`);
    }
    if (skillUsage.unusedCount > 0) {
      lines.push(`Never used (${skillUsage.unusedCount}): ${skillUsage.unusedNames.slice(0, 5).join(', ')}`);
    }
    parts.push(`\n--- Skill usage ---\n${lines.join('\n')}`);
  }

  if (patternInsights && patternInsights.length > 10) {
    parts.push(`\n--- Response quality patterns ---\n${patternInsights}`);
  }

  parts.push('\nNow write the recap:');

  return parts.join('\n');
}

/**
 * Generate a recap of today's activity.
 * Returns { text, generatedAt, activity }.
 * Stores result in state for dashboard access.
 */
export async function generateRecap() {
  log.info('Generating daily recap');

  const activity = gatherTodayActivity();

  // Async: fetch vestige memory timeline for today
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const timeline = await memoryTimeline({
      start: today + 'T00:00:00Z',
      end: today + 'T23:59:59Z',
      limit: 20,
      detail_level: 'summary',
    });
    if (timeline) activity.vestige = timeline;
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to get memory timeline for recap');
  }

  const prompt = buildRecapPrompt(activity);

  let text;
  try {
    const { reply } = await chatOneShot(prompt, null);
    text = reply.trim();
  } catch (err) {
    log.warn({ err: err.message }, 'Recap LLM call failed');
    text = 'Unable to generate recap — LLM call failed.';
  }

  const result = {
    text,
    generatedAt: Date.now(),
    activity: {
      workflowCount: activity.workflows.length,
      cronCount: activity.cronActivity.length,
      cronFailures: activity.cronActivity.filter(j => !j.success).length,
      goalCount: activity.goals.length,
      notesLength: activity.notes.length,
    },
  };

  // Persist for dashboard — store per day + as latest
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  setState(STATE_KEY, result);
  setState(`recap:${today}`, result);
  log.info({ textLen: text.length, date: today }, 'Recap generated and saved');

  // Prune old recaps beyond retention
  pruneOldRecaps();

  return result;
}

/**
 * Get the last generated recap from state (for dashboard).
 */
export function getLastRecap() {
  return getState(STATE_KEY);
}

/**
 * Get recaps for the last N days (from config.recapRetentionDays).
 * Returns array of { date, text, generatedAt } sorted newest first.
 */
export function getRecentRecaps() {
  const days = config.recapRetentionDays || 7;
  const dates = listAvailableDates().slice(0, days);
  const recaps = [];

  for (const date of dates) {
    const saved = getState(`recap:${date}`);
    if (saved && saved.text) {
      recaps.push({ date, text: saved.text, generatedAt: saved.generatedAt });
    } else {
      // No generated recap for this day, but notes exist
      const notes = getNotesForDate(date);
      if (notes && notes.length > 20) {
        recaps.push({ date, text: null, notes: notes.slice(0, 2000), generatedAt: null });
      }
    }
  }

  return recaps;
}

/**
 * Remove recaps older than retention period.
 */
function pruneOldRecaps() {
  const days = config.recapRetentionDays || 7;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toLocaleDateString('en-CA', { timeZone: TZ });

  const dates = listAvailableDates();
  for (const date of dates) {
    if (date < cutoffStr) {
      try {
        setState(`recap:${date}`, null);
      } catch {}
    }
  }
}
