/**
 * Proactive agent loop — periodic checks that make the bot feel alive.
 * Runs every 30 minutes, respects quiet hours (23:00-07:00 Israel time).
 */

import { checkIntentions, listIntentions, consolidate, findDuplicates, garbageCollect } from './mcp-gateway.js';
import { listCrons } from './crons.js';
import { getGoalSummary, getUpcomingDeadlines, getStaleGoals, listGoals } from './goals.js';
import { agentBrainCycle } from './agent-brain.js';
import { generateDigest } from './daily-digest.js';
import { createLogger } from './logger.js';
import { getState, setState } from './state.js';
import { runDecay } from './memory-tiers.js';
import { runSelfReview } from './self-review.js';
import { sendToGroup } from './whatsapp.js';
import config from './config.js';

const log = createLogger('proactive');
const INTERVAL_MS = config.proactiveInterval;
let timer = null;
let sendFn = null;

function getIsraelHour() {
  return parseInt(new Date().toLocaleTimeString('en-US', {
    timeZone: config.timezone, hour: 'numeric', hour12: false,
  }));
}

function isQuietHours() {
  const hour = getIsraelHour();
  return hour >= config.quietStart || hour < config.quietEnd;
}

// --- Weekly memory maintenance (runs Saturday night 22:00 Israel time) ---
async function weeklyMaintenance() {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { timeZone: config.timezone, weekday: 'long' });
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

    const decayed = runDecay();
    log.info({ decayed }, 'Memory tier decay applied');

    // Sync proposal outcomes into memory-tiers (dynamic import to avoid circular deps)
    try {
      const { syncOutcomesToMemory } = await import('./outcome-tracker.js');
      const syncResults = await syncOutcomesToMemory();
      log.info(syncResults, 'Outcome → memory sync applied');
    } catch (err) {
      log.warn({ err: err.message }, 'Outcome sync failed (non-critical)');
    }

    // Phase 4: Knowledge extraction — extract stable facts from conversations into Vestige
    try {
      const { runExtraction } = await import('./knowledge-extractor.js');
      const extraction = await runExtraction();
      log.info(extraction, 'Knowledge extraction done');
    } catch (err) {
      log.warn({ err: err.message }, 'Knowledge extraction failed (non-critical)');
    }

    // Phase 3: Trust decay — reduce trust scores slightly to require ongoing proof
    try {
      const { applyTrustDecay } = await import('./trust-engine.js');
      applyTrustDecay();
      log.info('Trust decay applied');
    } catch (err) {
      log.warn({ err: err.message }, 'Trust decay failed (non-critical)');
    }

    // Reasoning journal: prune old entries (keep 200)
    try {
      const { pruneOld } = await import('./reasoning-journal.js');
      const pruned = pruneOld(200);
      if (pruned > 0) log.info({ pruned }, 'Reasoning journal pruned');
    } catch (err) {
      log.warn({ err: err.message }, 'Reasoning journal prune failed (non-critical)');
    }

    setState('memory-maintenance', { lastRun: Date.now(), status: 'success' });

    await sendToGroup('daily', '*Weekly memory maintenance complete.* Consolidated, deduped, cleaned up old memories, and extracted knowledge.');
  } catch (err) {
    log.warn({ err: err.message }, 'Weekly memory maintenance failed');
    setState('memory-maintenance', { lastRun: Date.now(), status: 'failed', error: err.message });
  }
}

/**
 * Legacy morning messages — the pre-digest 8am behavior.
 * Sends separate intention summary + goal summary + deadline alerts.
 * Used as fallback when digest is disabled or fails.
 */
async function sendLegacyMorningMessages(send) {
  try {
    const active = await listIntentions('active', 20);
    if (active && active.length > 50) {
      const count = (active.match(/\n/g) || []).length + 1;
      await send(`*Good morning.* ${count} active intentions:\n${active.slice(0, 500)}`);
      log.info({ count }, 'Sent daily intention summary (legacy)');
    }
  } catch (err) {
    log.debug({ err: err.message }, 'Legacy intention summary failed');
  }

  try {
    const goalState = getState('proactive-goals');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
    if (goalState.lastDailyGoalCheck !== today) {
      const activeGoals = listGoals({ status: ['active', 'in_progress', 'blocked'] });
      if (activeGoals.length > 0) {
        const summary = getGoalSummary();
        const upcoming = getUpcomingDeadlines(3);
        let msg = `*Active goals (${activeGoals.length}):*\n${summary}`;
        if (upcoming.length > 0) {
          const dlLines = upcoming.map(g => {
            const dl = new Date(g.deadline);
            const daysLeft = Math.ceil((dl - new Date()) / (1000 * 60 * 60 * 24));
            return `• *${g.title}*: ${daysLeft <= 0 ? 'OVERDUE' : daysLeft + 'd left'}`;
          }).join('\n');
          msg += `\n\n*Deadline alerts:*\n${dlLines}`;
        }
        await send(msg);
        log.info({ count: activeGoals.length, deadlines: upcoming.length }, 'Sent morning goal summary (legacy)');
      }
      setState('proactive-goals', { ...goalState, lastDailyGoalCheck: today });
    }
  } catch (err) {
    log.debug({ err: err.message }, 'Legacy goal summary failed');
  }
}

async function checkLoop() {
  if (isQuietHours() || !sendFn) return;

  // User model: defer non-urgent proactive messages if user is likely unavailable
  let userAvailable = true;
  try {
    const { isLikelyAvailable } = await import('./user-model.js');
    userAvailable = isLikelyAvailable();
  } catch {}

  // Check weekly maintenance (non-blocking, before other checks)
  weeklyMaintenance().catch(() => {});

  // Weekly self-review — Sunday 23:00 Israel time
  try {
    const now = new Date();
    const day = now.toLocaleDateString('en-US', { timeZone: config.timezone, weekday: 'long' });
    const hour = getIsraelHour();
    if (day === 'Sunday' && hour === 23) {
      const reviewState = getState('self-review') || {};
      const lastRun = reviewState.lastRun || 0;
      if (Date.now() - lastRun > 6 * 24 * 3600_000) {
        log.info('Triggering weekly self-review');
        runSelfReview(sendFn).catch(err =>
          log.warn({ err: err.message }, 'Self-review failed (non-critical)')
        );
        const rs = getState('self-review') || {};
        rs.lastRun = Date.now();
        setState('self-review', rs);
      }
    }
  } catch {}

  // --- Daily memory decay (midnight Israel time) ---
  try {
    const decayHour = 0; // midnight
    const hour = getIsraelHour();
    if (hour === decayHour) {
      const decayState = getState('memory-decay-daily');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
      if (decayState.lastDecayDate !== today) {
        const changed = runDecay();
        setState('memory-decay-daily', { lastDecayDate: today, changed });
        log.info({ changed }, 'Daily memory decay applied');
      }
    }
  } catch (err) {
    log.debug({ err: err.message }, 'Daily memory decay failed (non-critical)');
  }

  try {
    // 1. Check for triggered intentions (due reminders, deadlines, followups)
    const triggered = await checkIntentions({
      current_time: new Date().toISOString(),
      topics: ['reminder', 'deadline', 'followup', 'task'],
    });

    if (triggered && triggered.length > 50) {
      // Parse JSON response — only send if there are actual triggered items
      try {
        const parsed = JSON.parse(triggered);
        const triggeredItems = parsed.triggered || [];
        // Only send if there are actually triggered (due now) intentions — not just pending
        if (triggeredItems.length > 0) {
          const lines = triggeredItems.map(i => `• ${i.description}`).join('\n');
          const isDeadline = triggeredItems.some(i => /deadline|due|overdue/i.test(i.description));
          const prefix = isDeadline ? '*Deadline alert:*' : '*Reminder:*';
          await sendToGroup('daily', `${prefix}\n${lines}`);
          log.info({ count: triggeredItems.length }, 'Sent proactive intention');
        }
        // pending (not yet due) — skip silently
      } catch {
        // Not valid JSON — send raw if it looks like a real message
        if (!/^\s*\{/.test(triggered)) {
          const isDeadline = /deadline|due|overdue|עד יום|דדליין/i.test(triggered);
          const prefix = isDeadline ? '*Deadline alert:*' : '*Reminder:*';
          await sendToGroup('daily', `${prefix}\n${triggered.slice(0, 600)}`);
          log.info({ len: triggered.length }, 'Sent proactive intention (raw)');
        }
      }
    }

    // 2. Morning digest or legacy messages (once per day)
    const hour = getIsraelHour();
    if (hour === config.digestHour) {
      const state = getState('proactive-daily');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
      if (state.lastDailyCheck !== today) {
        if (config.digestEnabled) {
          // LLM-synthesized morning briefing
          try {
            await generateDigest((text) => sendToGroup('daily', text));
            log.info('Daily digest sent');
          } catch (err) {
            log.warn({ err: err.message }, 'Digest failed, falling back to legacy morning messages');
            await sendLegacyMorningMessages((text) => sendToGroup('daily', text));
          }
        } else {
          await sendLegacyMorningMessages((text) => sendToGroup('daily', text));
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
      await sendToGroup('alerts', `*Cron issues:*\n${names}`);
      log.info({ count: failedRecently.length }, 'Sent proactive cron failure alert');
    }

    // 4. Goal checks

    // 4a. Morning goal summary is now handled by the digest (when enabled).
    // When digest is disabled, sendLegacyMorningMessages() covers it above.

    // 4b. Stale goal nudge (once per day at 10am — per-goal cooldown 3 days to avoid spam)
    if (hour === 10) {
      const goalState = getState('proactive-goals');
      const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
      if (goalState.lastStaleCheck !== today) {
        const stale = getStaleGoals(72); // raised from 48h → 72h
        const GOAL_NUDGE_COOLDOWN_MS = 5 * 24 * 3600_000; // 5 days per goal (raised from 3)
        const lastNudged = goalState.lastNudgedGoals || {};
        const now = Date.now();
        const toNudge = stale.filter(g => !lastNudged[g.id] || now - lastNudged[g.id] > GOAL_NUDGE_COOLDOWN_MS);
        if (toNudge.length > 0) {
          const names = toNudge.map(g => `• *${g.title}* (${g.progress}%)`).join('\n');
          await sendToGroup('daily', `*Stale goals* (no activity in 72h):\n${names}\n\n_Still working on these?_`);
          log.info({ count: toNudge.length }, 'Sent stale goal nudge');
          toNudge.forEach(g => { lastNudged[g.id] = now; });
        }
        setState('proactive-goals', { ...goalState, lastStaleCheck: today, lastNudgedGoals: lastNudged });
      }
    }

    // 4c. Weekly goal review (Friday at 14:00)
    const day = new Date().toLocaleDateString('en-US', { timeZone: config.timezone, weekday: 'long' });
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
          await sendToGroup('daily', msg);
          log.info({ active: active.length, completed: completed.length }, 'Sent weekly goal review');
        }
        setState('proactive-goals', { ...goalState, lastWeeklyReview: Date.now() });
      }
    }

    // 5. Agent brain cycle (observation → inference → action)
    try {
      await agentBrainCycle((text) => sendToGroup('daily', text));
    } catch (brainErr) {
      log.debug({ err: brainErr.message }, 'Agent brain cycle failed (non-critical)');
    }

    // 6. Check running experiments (Phase 7: auto-revert or conclude)
    try {
      const { checkExperiments } = await import('./experiments.js');
      const results = checkExperiments();
      for (const r of results) {
        if (!isQuietHours() && userAvailable) {
          const emoji = r.action === 'reverted' ? 'Reverted' : 'Done';
          await sendToGroup('daily', `*Experiment ${emoji}:* ${r.name}\n${r.conclusion}`);
        }
      }
    } catch (err) {
      log.debug({ err: err.message }, 'Experiment check failed (non-critical)');
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
