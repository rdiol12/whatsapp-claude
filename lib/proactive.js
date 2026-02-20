/**
 * Proactive agent loop — periodic checks that make the bot feel alive.
 * Runs every 30 minutes, respects quiet hours (23:00-07:00 Israel time).
 */

import { checkIntentions, listIntentions, consolidate, findDuplicates, garbageCollect } from './mcp-gateway.js';
import { listCrons } from './crons.js';
import { getGoalSummary, getUpcomingDeadlines, getStaleGoals, listGoals } from './goals.js';
import { agentBrainCycle } from './agent-brain.js';
import { createLogger } from './logger.js';
import { getState, setState } from './state.js';
import config from './config.js';

const log = createLogger('proactive');
const INTERVAL_MS = config.proactiveInterval;
let timer = null;
let sendFn = null;

function getIsraelHour() {
  return parseInt(new Date().toLocaleTimeString('en-US', {
    timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false,
  }));
}

function isQuietHours() {
  const hour = getIsraelHour();
  return hour >= config.quietStart || hour < config.quietEnd;
}

// --- Weekly memory maintenance (runs Saturday night 22:00 Israel time) ---
async function weeklyMaintenance() {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'long' });
  const hour = getIsraelHour();

  // Only run on Saturday between 22:00-22:30
  if (day !== 'Saturday' || hour !== 22) return;

  const state = getState('memory-maintenance');
  const lastRun = state.lastRun || 0;
  // Don't run more than once per week
  if (Date.now() - lastRun < 6 * 24 * 3600_000) return;

  log.info('Starting weekly memory maintenance');
  try {
    const dupes = await findDuplicates(0.85, 50);
    log.info({ dupes: typeof dupes === 'string' ? dupes.slice(0, 200) : '(none)' }, 'Duplicates check done');

    await consolidate();
    log.info('Memory consolidation done');

    const gcResult = await garbageCollect(false, 0.1, 90);
    log.info({ gcResult: typeof gcResult === 'string' ? gcResult.slice(0, 200) : '(done)' }, 'Garbage collection done');

    setState('memory-maintenance', { lastRun: Date.now(), status: 'success' });

    if (sendFn) {
      await sendFn('*Weekly memory maintenance complete.* Consolidated, deduped, and cleaned up old memories.');
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Weekly memory maintenance failed');
    setState('memory-maintenance', { lastRun: Date.now(), status: 'failed', error: err.message });
  }
}

async function checkLoop() {
  if (isQuietHours() || !sendFn) return;

  // Check weekly maintenance (non-blocking, before other checks)
  weeklyMaintenance().catch(() => {});

  try {
    // 1. Check for triggered intentions (due reminders, deadlines, followups)
    const triggered = await checkIntentions({
      current_time: new Date().toISOString(),
      topics: ['reminder', 'deadline', 'followup', 'task'],
    });

    if (triggered && triggered.length > 50) {
      // Classify: deadline vs reminder vs general
      const isDeadline = /deadline|due|overdue|עד יום|דדליין/i.test(triggered);
      const prefix = isDeadline ? '*Deadline alert:*' : '*Reminder:*';
      await sendFn(`${prefix}\n${triggered.slice(0, 600)}`);
      log.info({ len: triggered.length, isDeadline }, 'Sent proactive intention');
    }

    // 2. List active intentions and report count (once per day, morning check)
    const hour = getIsraelHour();
    if (hour === 8) {
      const state = getState('proactive-daily');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
      if (state.lastDailyCheck !== today) {
        const active = await listIntentions('active', 20);
        if (active && active.length > 50) {
          const count = (active.match(/\n/g) || []).length + 1;
          await sendFn(`*Good morning.* ${count} active intentions:\n${active.slice(0, 500)}`);
          log.info({ count }, 'Sent daily intention summary');
        }
        setState('proactive-daily', { lastDailyCheck: today });
      }
    }

    // 3. Check for cron failures in the last hour
    const crons = listCrons();
    const failedRecently = crons.filter(j =>
      j.state?.consecutiveErrors > 0 &&
      j.state?.lastRun &&
      (Date.now() - new Date(j.state.lastRun).getTime()) < 3600_000
    );

    if (failedRecently.length > 0) {
      const names = failedRecently.map(j => `• *${j.name}*: ${j.state.consecutiveErrors} consecutive failures`).join('\n');
      await sendFn(`*Cron issues:*\n${names}`);
      log.info({ count: failedRecently.length }, 'Sent proactive cron failure alert');
    }

    // 4. Goal checks (reuses `hour` from section 2 above)

    // 4a. Morning goal summary (at 8am, alongside intention summary)
    if (hour === 8) {
      const goalState = getState('proactive-goals');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
      if (goalState.lastDailyGoalCheck !== today) {
        const active = listGoals({ status: ['active', 'in_progress', 'blocked'] });
        if (active.length > 0) {
          const summary = getGoalSummary();
          // Check deadlines within 3 days
          const upcoming = getUpcomingDeadlines(3);
          let msg = `*Active goals (${active.length}):*\n${summary}`;
          if (upcoming.length > 0) {
            const dlLines = upcoming.map(g => {
              const dl = new Date(g.deadline);
              const daysLeft = Math.ceil((dl - new Date()) / (1000 * 60 * 60 * 24));
              return `• *${g.title}*: ${daysLeft <= 0 ? 'OVERDUE' : daysLeft + 'd left'}`;
            }).join('\n');
            msg += `\n\n*Deadline alerts:*\n${dlLines}`;
          }
          await sendFn(msg);
          log.info({ count: active.length, deadlines: upcoming.length }, 'Sent morning goal summary');
        }
        setState('proactive-goals', { ...goalState, lastDailyGoalCheck: today });
      }
    }

    // 4b. Stale goal nudge (check every 6 hours: 10, 16, 20)
    if ([10, 16, 20].includes(hour)) {
      const goalState = getState('proactive-goals');
      const lastStaleCheck = goalState.lastStaleCheck || 0;
      if (Date.now() - lastStaleCheck > 5 * 3600_000) { // At least 5h between checks
        const stale = getStaleGoals(48);
        if (stale.length > 0) {
          const names = stale.map(g => `• *${g.title}* (${g.progress}%)`).join('\n');
          await sendFn(`*Stale goals* (no activity in 48h):\n${names}\n\n_Still working on these?_`);
          log.info({ count: stale.length }, 'Sent stale goal nudge');
        }
        setState('proactive-goals', { ...goalState, lastStaleCheck: Date.now() });
      }
    }

    // 4c. Weekly goal review (Friday at 14:00)
    const day = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'long' });
    if (day === 'Friday' && hour === 14) {
      const goalState = getState('proactive-goals');
      const lastWeeklyReview = goalState.lastWeeklyReview || 0;
      if (Date.now() - lastWeeklyReview > 6 * 24 * 3600_000) { // At least 6 days between reviews
        const active = listGoals({ status: ['active', 'in_progress', 'blocked'] });
        const completed = listGoals({ status: ['completed'] }).filter(g =>
          Date.now() - g.updatedAt < 7 * 24 * 3600_000
        );
        if (active.length > 0 || completed.length > 0) {
          let msg = '*Weekly Goal Review:*\n';
          if (completed.length > 0) {
            msg += `\n*Completed this week (${completed.length}):*\n${completed.map(g => `• ${g.title}`).join('\n')}\n`;
          }
          if (active.length > 0) {
            msg += `\n*Active (${active.length}):*\n${getGoalSummary()}`;
          }
          await sendFn(msg);
          log.info({ active: active.length, completed: completed.length }, 'Sent weekly goal review');
        }
        setState('proactive-goals', { ...goalState, lastWeeklyReview: Date.now() });
      }
    }

    // 5. Agent brain cycle (observation → inference → action)
    try {
      await agentBrainCycle(sendFn);
    } catch (brainErr) {
      log.debug({ err: brainErr.message }, 'Agent brain cycle failed (non-critical)');
    }
  } catch (err) {
    log.debug({ err: err.message }, 'Proactive check failed (non-critical)');
  }
}

export function startProactiveLoop(send) {
  sendFn = send;
  // Initial check after 5 minutes (let everything settle first)
  setTimeout(() => {
    checkLoop();
    timer = setInterval(checkLoop, INTERVAL_MS);
    timer.unref();
  }, 5 * 60_000);
  log.info({ intervalMin: INTERVAL_MS / 60_000 }, 'Proactive loop started');
}

export function stopProactiveLoop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
