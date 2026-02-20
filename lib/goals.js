/**
 * Goals system — long-running objectives that persist across conversations.
 * Follows the exact pattern of crons.js: load/save JSON, CRUD, state machine.
 *
 * Goals have milestones, progress tracking, deadlines, and activity logs.
 * They are injected into Claude's context so it naturally connects
 * conversations to ongoing objectives.
 */

import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import config from './config.js';
import { createLogger } from './logger.js';
import { writeFileAtomic } from './resilience.js';

const log = createLogger('goals');
const GOALS_FILE = join(config.dataDir, 'goals.json');

let goals = [];

// --- Valid status transitions ---

const TRANSITIONS = {
  draft:       ['active', 'abandoned'],
  active:      ['in_progress', 'blocked', 'abandoned'],
  in_progress: ['blocked', 'completed', 'abandoned'],
  blocked:     ['in_progress', 'abandoned'],
  completed:   [],
  abandoned:   [],
};

// --- Persistence ---

export function load() {
  try {
    const raw = readFileSync(GOALS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    goals = data.goals || [];
    // Migrate old goals: ensure all fields exist
    for (const g of goals) {
      if (!g.milestones) g.milestones = [];
      if (!g.log) g.log = [];
      if (!g.linkedTopics) g.linkedTopics = [];
      if (g.progress === undefined) g.progress = 0;
    }
    log.info({ count: goals.length }, 'Loaded goals');
  } catch (err) {
    goals = [];
    if (err.code === 'ENOENT') {
      log.info('No goals file, starting fresh');
    } else {
      log.warn({ err: err.message }, 'Goals file corrupted, starting fresh');
    }
  }
}

function save() {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileAtomic(GOALS_FILE, JSON.stringify({ version: 1, goals }, null, 2));
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save goals');
  }
}

// --- Helpers ---

function findGoal(idOrTitle) {
  const lower = idOrTitle.toLowerCase();
  return goals.find(g =>
    g.id === idOrTitle ||
    g.title.toLowerCase() === lower ||
    g.title.toLowerCase().includes(lower)
  );
}

function computeProgress(goal) {
  if (goal.milestones.length === 0) return goal.progress;
  const done = goal.milestones.filter(m => m.status === 'done').length;
  const total = goal.milestones.filter(m => m.status !== 'skipped').length;
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

function logActivity(goal, event, detail = '') {
  goal.log.push({ ts: Date.now(), event, detail });
  // Keep last 50 log entries
  if (goal.log.length > 50) goal.log = goal.log.slice(-50);
}

// --- CRUD ---

export function listGoals(filter = {}) {
  let result = goals;
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    result = result.filter(g => statuses.includes(g.status));
  }
  if (filter.category) {
    result = result.filter(g => g.category === filter.category);
  }
  // Recalculate progress for each
  for (const g of result) {
    g.progress = computeProgress(g);
  }
  return result;
}

export function getGoal(idOrTitle) {
  const goal = findGoal(idOrTitle);
  if (goal) goal.progress = computeProgress(goal);
  return goal;
}

export function addGoal(title, { description = '', priority = 'normal', category = 'project', deadline = null, linkedTopics = [], milestones = [] } = {}) {
  const id = randomBytes(4).toString('hex');
  const goal = {
    id,
    title,
    description,
    status: 'active',
    priority,
    category,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deadline,
    milestones: milestones.map((m, i) => ({
      id: `ms_${i + 1}`,
      title: typeof m === 'string' ? m : m.title,
      status: 'pending',
      completedAt: null,
      evidence: null,
    })),
    progress: 0,
    linkedTopics,
    parentGoalId: null,
    log: [{ ts: Date.now(), event: 'created', detail: title }],
  };

  goals.push(goal);
  save();
  log.info({ id, title, priority, category, deadline }, 'Goal added');
  return goal;
}

export function updateGoal(idOrTitle, fields) {
  const goal = findGoal(idOrTitle);
  if (!goal) return null;

  // Status transition validation
  if (fields.status && fields.status !== goal.status) {
    const allowed = TRANSITIONS[goal.status] || [];
    if (!allowed.includes(fields.status)) {
      log.warn({ id: goal.id, from: goal.status, to: fields.status }, 'Invalid status transition');
      return null;
    }
    logActivity(goal, 'status_change', `${goal.status} → ${fields.status}`);
    goal.status = fields.status;
  }

  // Update simple fields
  const updatable = ['title', 'description', 'priority', 'category', 'deadline', 'linkedTopics', 'parentGoalId'];
  for (const key of updatable) {
    if (fields[key] !== undefined) {
      goal[key] = fields[key];
    }
  }

  // Manual progress override (only if no milestones)
  if (fields.progress !== undefined && goal.milestones.length === 0) {
    goal.progress = Math.max(0, Math.min(100, fields.progress));
    logActivity(goal, 'progress_update', `${goal.progress}%`);
  }

  goal.updatedAt = Date.now();
  goal.progress = computeProgress(goal);
  save();
  log.info({ id: goal.id, title: goal.title, status: goal.status }, 'Goal updated');
  return goal;
}

export function deleteGoal(idOrTitle) {
  const goal = findGoal(idOrTitle);
  if (!goal) return null;
  goals = goals.filter(g => g.id !== goal.id);
  save();
  log.info({ id: goal.id, title: goal.title }, 'Goal deleted');
  return goal;
}

// --- Milestones ---

export function addMilestone(goalIdOrTitle, title) {
  const goal = findGoal(goalIdOrTitle);
  if (!goal) return null;

  const msId = `ms_${goal.milestones.length + 1}`;
  const milestone = { id: msId, title, status: 'pending', completedAt: null, evidence: null };
  goal.milestones.push(milestone);
  goal.updatedAt = Date.now();
  goal.progress = computeProgress(goal);
  logActivity(goal, 'milestone_added', title);
  save();
  log.info({ goalId: goal.id, msId, title }, 'Milestone added');
  return milestone;
}

export function completeMilestone(goalIdOrTitle, milestoneIdOrTitle, evidence = null) {
  const goal = findGoal(goalIdOrTitle);
  if (!goal) return null;

  const lower = (milestoneIdOrTitle || '').toLowerCase();
  const ms = goal.milestones.find(m =>
    m.id === milestoneIdOrTitle ||
    m.title.toLowerCase() === lower ||
    m.title.toLowerCase().includes(lower)
  );
  if (!ms) return null;

  ms.status = 'done';
  ms.completedAt = Date.now();
  if (evidence) ms.evidence = evidence;

  goal.updatedAt = Date.now();
  goal.progress = computeProgress(goal);
  logActivity(goal, 'milestone_completed', ms.title);

  // Auto-complete goal if all milestones done
  const allDone = goal.milestones.every(m => m.status === 'done' || m.status === 'skipped');
  if (allDone && goal.milestones.length > 0 && goal.status !== 'completed') {
    goal.status = 'completed';
    logActivity(goal, 'auto_completed', 'All milestones done');
    log.info({ goalId: goal.id, title: goal.title }, 'Goal auto-completed (all milestones done)');
  }

  save();
  return ms;
}

// --- Formatting ---

function progressBar(pct) {
  const filled = Math.round(pct / 10);
  return '[' + '='.repeat(filled) + '-'.repeat(10 - filled) + ']';
}

function formatDeadline(deadline) {
  if (!deadline) return '';
  const dl = new Date(deadline);
  const now = new Date();
  const daysLeft = Math.ceil((dl - now) / (1000 * 60 * 60 * 24));
  const dateStr = dl.toLocaleDateString('en-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit' });
  if (daysLeft < 0) return ` (${dateStr}, ${Math.abs(daysLeft)}d overdue)`;
  if (daysLeft <= 3) return ` (${dateStr}, ${daysLeft}d left)`;
  return ` (${dateStr})`;
}

export function getGoalSummary() {
  const active = listGoals({ status: ['active', 'in_progress', 'blocked'] });
  if (active.length === 0) return 'No active goals.';

  const priorityOrder = { critical: 0, high: 1, normal: 2, low: 3 };
  active.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

  const lines = active.map((g, i) => {
    const status = g.status === 'blocked' ? ' BLOCKED' : '';
    const prio = g.priority !== 'normal' ? ` [${g.priority}]` : '';
    const dl = formatDeadline(g.deadline);
    return `${i + 1}. *${g.title}* ${progressBar(g.progress)} ${g.progress}%${dl}${prio}${status}`;
  });
  return lines.join('\n');
}

export function getGoalDetail(idOrTitle) {
  const g = getGoal(idOrTitle);
  if (!g) return null;

  const parts = [];
  parts.push(`*${g.title}*`);
  parts.push(`Status: ${g.status} | Priority: ${g.priority} | Progress: ${g.progress}%`);
  if (g.description) parts.push(g.description);
  if (g.deadline) parts.push(`Deadline: ${formatDeadline(g.deadline)}`);

  if (g.milestones.length > 0) {
    parts.push('');
    parts.push('*Milestones:*');
    for (const ms of g.milestones) {
      const icon = ms.status === 'done' ? 'v' : ms.status === 'skipped' ? '-' : 'o';
      parts.push(`  ${icon} ${ms.title}${ms.evidence ? ` (${ms.evidence})` : ''}`);
    }
  }

  if (g.log.length > 0) {
    parts.push('');
    parts.push('*Recent activity:*');
    for (const entry of g.log.slice(-5)) {
      const time = new Date(entry.ts).toLocaleString('en-IL', { timeZone: 'Asia/Jerusalem', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      parts.push(`  ${time}: ${entry.event}${entry.detail ? ' — ' + entry.detail : ''}`);
    }
  }

  return parts.join('\n');
}

/**
 * Build a compact context block for Claude injection.
 * Only includes active/in_progress/blocked goals.
 */
export function getGoalsContext() {
  const active = listGoals({ status: ['active', 'in_progress', 'blocked'] });
  if (active.length === 0) return '';

  const lines = active.map(g => {
    const dl = g.deadline ? `, deadline: ${new Date(g.deadline).toLocaleDateString('en-CA')}` : '';
    const nextMs = g.milestones.find(m => m.status === 'pending');
    const nextStr = nextMs ? `, next: "${nextMs.title}"` : '';
    return `- ${g.title} (${g.progress}%${dl}${nextStr}) [${g.status}]`;
  });
  return lines.join('\n');
}

/**
 * Match a message against goal linkedTopics.
 * Returns the most relevant goal or null.
 */
export function matchGoalByTopic(text) {
  const lower = text.toLowerCase();
  const active = listGoals({ status: ['active', 'in_progress', 'blocked'] });

  let bestGoal = null;
  let bestScore = 0;

  for (const g of active) {
    let score = 0;
    // Check linkedTopics
    for (const topic of g.linkedTopics) {
      if (lower.includes(topic.toLowerCase())) score += 2;
    }
    // Check title words
    const titleWords = g.title.toLowerCase().split(/\s+/);
    for (const word of titleWords) {
      if (word.length > 3 && lower.includes(word)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestGoal = g;
    }
  }

  return bestScore >= 2 ? bestGoal : null;
}

/**
 * Get goals with upcoming deadlines (within N days).
 */
export function getUpcomingDeadlines(daysAhead = 3) {
  const now = Date.now();
  const cutoff = now + daysAhead * 24 * 60 * 60 * 1000;
  return listGoals({ status: ['active', 'in_progress'] })
    .filter(g => g.deadline && new Date(g.deadline).getTime() <= cutoff)
    .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime());
}

/**
 * Get stale goals (no activity in N hours).
 */
export function getStaleGoals(hoursInactive = 48) {
  const cutoff = Date.now() - hoursInactive * 60 * 60 * 1000;
  return listGoals({ status: ['in_progress'] })
    .filter(g => g.updatedAt < cutoff);
}

export function flush() {
  save();
}
