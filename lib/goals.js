/**
 * Goals system — long-running objectives that persist across conversations.
 * M2: SQLite migration — uses lib/db.js for persistence.
 *
 * Goals have milestones, progress tracking, deadlines, and activity logs.
 * They are injected into Claude's context so it naturally connects
 * conversations to ongoing objectives.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import config from './config.js';
import { createLogger } from './logger.js';
import { getDb } from './db.js';
import { generateGoalRetrospective, logObservableAction } from './outcome-tracker.js';
import { emit as wsEmit } from './ws-events.js';

const log = createLogger('goals');
const GOALS_FILE = join(config.dataDir, 'goals.json');

let goals = [];

// --- Valid status transitions ---

const TRANSITIONS = {
  proposed:    ['draft', 'active', 'in_progress', 'abandoned'],
  draft:       ['pending', 'active', 'abandoned'],
  pending:     ['active', 'abandoned'],
  active:      ['in_progress', 'pending', 'blocked', 'abandoned'],
  in_progress: ['pending', 'blocked', 'completed', 'abandoned'],
  blocked:     ['in_progress', 'pending', 'abandoned'],
  completed:   [],
  abandoned:   [],
};

// --- Database operations ---

function goalsToDb(goal) {
  const db = getDb();
  db.prepare(`
    INSERT INTO goals (id, title, description, status, priority, progress, milestones, log, linked_topics, category, parent_goal_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      status = excluded.status,
      priority = excluded.priority,
      progress = excluded.progress,
      milestones = excluded.milestones,
      log = excluded.log,
      linked_topics = excluded.linked_topics,
      category = excluded.category,
      parent_goal_id = excluded.parent_goal_id,
      updated_at = excluded.updated_at
  `).run(
    goal.id,
    goal.title,
    goal.description || null,
    goal.status,
    goal.priority || 'medium',
    goal.progress,
    JSON.stringify(goal.milestones || []),
    JSON.stringify(goal.log || []),
    JSON.stringify(goal.linkedTopics || []),
    goal.category || 'project',
    goal.parentGoalId || null,
    goal.createdAt || Date.now(),
    goal.updatedAt || Date.now()
  );
}

function dbGoalToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority || 'medium',
    progress: row.progress,
    milestones: JSON.parse(row.milestones || '[]'),
    log: JSON.parse(row.log || '[]'),
    linkedTopics: JSON.parse(row.linked_topics || '[]'),
    category: row.category || 'project',
    parentGoalId: row.parent_goal_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Persistence ---

export function load() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM goals ORDER BY updated_at DESC').all();
    goals = rows.map(dbGoalToObject);

    // Sync any goals from JSON that aren't in SQLite yet
    try {
      const raw = readFileSync(GOALS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      const jsonGoals = data.goals || [];
      const dbIds = new Set(goals.map(g => g.id));
      let synced = 0;
      for (const g of jsonGoals) {
        if (dbIds.has(g.id)) continue;
        if (!g.milestones) g.milestones = [];
        if (!g.log) g.log = [];
        if (!g.linkedTopics) g.linkedTopics = [];
        if (g.progress === undefined) g.progress = 0;
        const VALID_STATUSES = new Set(Object.keys(TRANSITIONS));
        if (!VALID_STATUSES.has(g.status)) {
          log.warn({ id: g.id, badStatus: g.status }, 'Fixed invalid goal status → active');
          g.status = 'active';
        }
        goalsToDb(g);
        goals.push(dbGoalToObject(db.prepare('SELECT * FROM goals WHERE id = ?').get(g.id)));
        synced++;
      }
      if (synced > 0) log.info({ count: synced }, 'Synced new goals from JSON to SQLite');
    } catch (migErr) {
      if (migErr.code !== 'ENOENT') {
        log.warn({ err: migErr.message }, 'Error syncing goals from JSON');
      }
    }

    // Write SQLite state back to goals.json so agent CLI sees current data
    syncJsonFromDb();

    log.info({ count: goals.length }, 'Loaded goals from SQLite');
  } catch (err) {
    goals = [];
    log.error({ err: err.message }, 'Failed to load goals from SQLite');
  }
}

// --- SQLite poll: detect external changes every 15s ---

let lastKnownMaxUpdated = 0;
let lastKnownCount = 0;
let pollTimer = null;

export function startDbPoll(intervalMs = 15_000) {
  if (pollTimer) return;
  // Seed from current in-memory state
  lastKnownMaxUpdated = goals.reduce((max, g) => Math.max(max, g.updatedAt || 0), 0);
  lastKnownCount = goals.length;

  pollTimer = setInterval(() => {
    try {
      const db = getDb();
      const row = db.prepare('SELECT MAX(updated_at) as maxUp, COUNT(*) as cnt FROM goals').get();
      const dbMax = row.maxUp || 0;
      const dbCount = row.cnt || 0;

      if (dbMax > lastKnownMaxUpdated || dbCount !== lastKnownCount) {
        log.info({ dbMax, memMax: lastKnownMaxUpdated, dbCount, memCount: lastKnownCount }, 'External DB change detected — reloading goals');
        const rows = db.prepare('SELECT * FROM goals ORDER BY updated_at DESC').all();
        goals = rows.map(dbGoalToObject);
        lastKnownMaxUpdated = dbMax;
        lastKnownCount = goals.length;
        syncJsonFromDb();
        wsEmit('goals:updated', { count: goals.length });
      }
    } catch (err) {
      log.warn({ err: err.message }, 'Goals DB poll error');
    }
  }, intervalMs);
}

export function stopDbPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/** Write current in-memory goals back to goals.json (keeps agent CLI in sync) */
function syncJsonFromDb() {
  try {
    const out = { goals: goals.map(g => ({ ...g })), updatedAt: Date.now() };
    writeFileSync(GOALS_FILE, JSON.stringify(out, null, 2), 'utf-8');
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to sync goals.json from SQLite');
  }
}

/** Get goals.json mtime (ms). Returns 0 if missing. */
export function getJsonMtime() {
  try { return statSync(GOALS_FILE).mtimeMs; } catch { return 0; }
}

/**
 * Import changes made directly to goals.json (by Claude CLI) into SQLite.
 * Detects new goals, status/progress changes, and new/completed milestones.
 * Returns number of goals imported or updated.
 */
export function importJsonChanges() {
  try {
    const raw = readFileSync(GOALS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const jsonGoals = data.goals || [];
    const VALID_STATUSES = new Set(Object.keys(TRANSITIONS));
    let changes = 0;

    for (const jg of jsonGoals) {
      if (!jg.id || !jg.title) continue;
      if (!jg.milestones) jg.milestones = [];
      if (!jg.log) jg.log = [];
      if (!jg.linkedTopics) jg.linkedTopics = [];
      if (jg.progress === undefined) jg.progress = 0;
      if (!VALID_STATUSES.has(jg.status)) jg.status = 'active';

      const existing = goals.find(g => g.id === jg.id);
      if (!existing) {
        // Brand new goal from JSON
        goalsToDb(jg);
        const db = getDb();
        goals.push(dbGoalToObject(db.prepare('SELECT * FROM goals WHERE id = ?').get(jg.id)));
        log.info({ id: jg.id, title: jg.title }, 'Imported new goal from goals.json');
        changes++;
        continue;
      }

      // Check for meaningful changes on existing goal
      let changed = false;
      if (jg.status && jg.status !== existing.status && VALID_STATUSES.has(jg.status)) {
        existing.status = jg.status; changed = true;
      }
      if (jg.progress !== undefined && jg.progress !== existing.progress) {
        existing.progress = jg.progress; changed = true;
      }
      if (jg.description && jg.description !== existing.description) {
        existing.description = jg.description; changed = true;
      }
      if (jg.priority && jg.priority !== existing.priority) {
        existing.priority = jg.priority; changed = true;
      }

      // Merge milestones: add new ones, mark completions
      for (const jm of jg.milestones) {
        const em = existing.milestones.find(m => m.id === jm.id);
        if (!em) {
          existing.milestones.push(jm);
          changed = true;
        } else if (jm.status === 'completed' && em.status !== 'completed') {
          em.status = 'completed';
          em.completedAt = jm.completedAt || Date.now();
          if (jm.evidence) em.evidence = jm.evidence;
          changed = true;
        }
      }

      if (changed) {
        existing.progress = computeProgress(existing);
        existing.updatedAt = Date.now();
        goalsToDb(existing);
        log.info({ id: existing.id, title: existing.title }, 'Updated goal from goals.json changes');
        changes++;
      }
    }

    if (changes > 0) {
      log.info({ changes }, 'Imported goals.json changes into SQLite');
      syncJsonFromDb(); // write normalized state back
      wsEmit('goals:updated', { count: goals.length });
    }
    return changes;
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to import goals.json changes');
    return 0;
  }
}

function save() {
  // Bump poll tracking so our own writes don't trigger a reload
  lastKnownMaxUpdated = Date.now();
  lastKnownCount = goals.length;
  // DB write happens inline via goalsToDb(). Sync JSON + emit WS event.
  syncJsonFromDb();
  wsEmit('goals:updated', { count: goals.length });
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
  const done = goal.milestones.filter(m => m.status === 'completed' || m.status === 'done').length;
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
  if (filter.parentGoalId) {
    result = result.filter(g => g.parentGoalId === filter.parentGoalId);
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

export function addGoal(title, { description = '', priority = 'normal', category = 'project', deadline = null, linkedTopics = [], milestones = [], source = 'user', parentGoalId = null } = {}) {
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
    source,
    parentGoalId,
    log: [{ ts: Date.now(), event: 'created', detail: title }],
  };

  goals.push(goal);
  goalsToDb(goal);
  save();
  log.info({ id, title, priority, category, deadline }, 'Goal added');
  return goal;
}

/**
 * Propose a goal (agent-initiated). Never auto-activates — requires user approval.
 * @returns {object} The proposed goal
 */
export function proposeGoal(title, { description = '', rationale = '', linkedTopics = [], milestones = [] } = {}) {
  const id = randomBytes(4).toString('hex');
  const goal = {
    id,
    title,
    description,
    status: 'proposed',
    priority: 'normal',
    category: 'project',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deadline: null,
    milestones: milestones.map((m, i) => ({
      id: `ms_${i + 1}`,
      title: typeof m === 'string' ? m : m.title,
      status: 'pending',
      completedAt: null,
      evidence: null,
    })),
    progress: 0,
    linkedTopics,
    source: 'agent',
    parentGoalId: null,
    log: [{ ts: Date.now(), event: 'proposed', detail: rationale || title }],
  };

  goals.push(goal);
  goalsToDb(goal);
  save();
  log.info({ id, title, rationale: rationale.slice(0, 80) }, 'Goal proposed by agent');
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
    if (fields.status === 'completed' && goal.status !== 'completed') {
      goal.completedAt = Date.now();
      generateGoalRetrospective(goal).catch(() => {}); // async, non-blocking
    }
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

  // Auto-complete goal if progress reaches 100% (milestone-based or manual)
  if (goal.progress >= 100 && goal.status !== 'completed' && goal.status !== 'abandoned') {
    const allMilestonesDone = goal.milestones.length === 0 ||
      goal.milestones.every(m => m.status === 'completed' || m.status === 'done' || m.status === 'skipped');
    if (allMilestonesDone) {
      goal.status = 'completed';
      goal.completedAt = Date.now();
      logActivity(goal, 'auto_completed', 'Progress reached 100%');
      generateGoalRetrospective(goal).catch(() => {});
      log.info({ goalId: goal.id, title: goal.title }, 'Goal auto-completed (100% progress)');
    }
  }

  goalsToDb(goal);
  save();
  log.info({ id: goal.id, title: goal.title, status: goal.status }, 'Goal updated');
  return goal;
}

export function deleteGoal(idOrTitle) {
  const goal = findGoal(idOrTitle);
  if (!goal) return null;
  goals = goals.filter(g => g.id !== goal.id);
  getDb().prepare('DELETE FROM goals WHERE id = ?').run(goal.id);
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
  goalsToDb(goal);
  try { logObservableAction('goal_milestone_added', { goalId: goal.id }); } catch {}
  save();
  log.info({ goalId: goal.id, msId, title }, 'Milestone added');
  return milestone;
}

export function completeMilestone(goalIdOrTitle, milestoneIdOrTitle, evidence = null, completedBy = null) {
  const goal = findGoal(goalIdOrTitle);
  if (!goal) return null;

  const lower = (milestoneIdOrTitle || '').toLowerCase();
  const ms = goal.milestones.find(m =>
    m.id === milestoneIdOrTitle ||
    m.title.toLowerCase() === lower ||
    m.title.toLowerCase().includes(lower)
  );
  if (!ms) return null;

  ms.status = 'completed';
  ms.completedAt = Date.now();
  if (evidence) ms.evidence = evidence;
  if (completedBy) ms.completedBy = completedBy;

  goal.updatedAt = Date.now();
  goal.progress = computeProgress(goal);
  logActivity(goal, 'milestone_completed', ms.title);

  // Auto-complete goal if all milestones done
  const allDone = goal.milestones.every(m => m.status === 'completed' || m.status === 'done' || m.status === 'skipped');
  if (allDone && goal.milestones.length > 0 && goal.status !== 'completed') {
    goal.status = 'completed';
    goal.completedAt = Date.now();
    logActivity(goal, 'auto_completed', 'All milestones done');
    generateGoalRetrospective(goal).catch(() => {}); // async, non-blocking
    log.info({ goalId: goal.id, title: goal.title }, 'Goal auto-completed (all milestones done)');
  }

  goalsToDb(goal);
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
  const dateStr = dl.toLocaleDateString('en-IL', { timeZone: config.timezone, day: '2-digit', month: '2-digit' });
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
      const icon = (ms.status === 'completed' || ms.status === 'done') ? 'v' : ms.status === 'skipped' ? '-' : 'o';
      parts.push(`  ${icon} ${ms.title}${ms.evidence ? ` (${ms.evidence})` : ''}`);
    }
  }

  if (g.log.length > 0) {
    parts.push('');
    parts.push('*Recent activity:*');
    for (const entry of g.log.slice(-5)) {
      const time = new Date(entry.ts).toLocaleString('en-IL', { timeZone: config.timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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

  // Sort by priority: high > medium > low
  const prioOrder = { critical: 0, high: 1, medium: 2, normal: 3, low: 4 };
  active.sort((a, b) => (prioOrder[a.priority] ?? 3) - (prioOrder[b.priority] ?? 3));

  const lines = active.map(g => {
    const prio = g.priority ? `[${g.priority.toUpperCase()}]` : '[NORMAL]';
    const dl = g.deadline ? `, deadline: ${new Date(g.deadline).toLocaleDateString('en-CA')}` : '';
    const nextMs = g.milestones.find(m => m.status === 'pending');
    const nextStr = nextMs ? `, next: "${nextMs.title}"` : '';
    return `- ${prio} ${g.title} (${g.progress}%${dl}${nextStr}) [${g.status}]`;
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
