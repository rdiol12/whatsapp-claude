import { readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { Cron } from 'croner';
import config from './config.js';
import { chatOneShot } from './claude.js';
import { notify } from './notify.js';
import { createLogger } from './logger.js';
import { runHook } from './plugins.js';
import { recordCron } from './metrics.js';
import { recordCronDelivery, logObservableAction } from './outcome-tracker.js';
import { emit as wsEmit } from './ws-events.js';
import { setState } from './state.js';
import { getDb } from './db.js';

const log = createLogger('crons');
const CRONS_FILE = join(config.dataDir, 'crons.json');
const DEFAULT_TZ = config.timezone;

// Quiet hours: suppress WhatsApp delivery (still runs, logs, alerts on failure)
const QUIET_START = config.quietStart;
const QUIET_END = config.quietEnd;

let jobs = [];          // in-memory job list
let scheduledCrons = new Map(); // id → Cron instance
let sendFn = null;      // injected by whatsapp.js
let queueSlot = null;   // injected queue { acquireSlot, releaseSlot }
const runningJobs = new Set(); // execution lock: prevent overlapping runs

// --- Quiet hours check ---

function isQuietHours() {
  const now = new Date();
  const ilTime = new Date(now.toLocaleString('en-US', { timeZone: DEFAULT_TZ }));
  const hour = ilTime.getHours();
  return hour >= QUIET_START || hour < QUIET_END;
}

// --- Database operations ---

function cronToDb(job) {
  const db = getDb();
  db.prepare(`
    INSERT INTO crons (id, name, enabled, schedule, tz, prompt, delivery, model, created_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled,
      schedule = excluded.schedule,
      tz = excluded.tz,
      prompt = excluded.prompt,
      delivery = excluded.delivery,
      model = excluded.model,
      state = excluded.state
  `).run(
    job.id,
    job.name,
    job.enabled ? 1 : 0,
    job.schedule,
    job.tz || DEFAULT_TZ,
    job.prompt,
    job.delivery || 'announce',
    job.model || null,
    job.createdAt || Date.now(),
    JSON.stringify(job.state || {})
  );
}

function dbCronToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    schedule: row.schedule,
    tz: row.tz || DEFAULT_TZ,
    prompt: row.prompt,
    delivery: row.delivery || 'announce',
    model: row.model,
    createdAt: row.created_at,
    state: JSON.parse(row.state || '{}'),
  };
}

// --- Persistence ---

export function load() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM crons ORDER BY created_at DESC').all();
    jobs = rows.map(dbCronToObject);

    // On first run, migrate old JSON data to SQLite if it exists
    if (jobs.length === 0) {
      try {
        const raw = readFileSync(CRONS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        const oldJobs = data.jobs || [];
        for (const job of oldJobs) {
          // Ensure all fields exist
          if (!job.delivery) job.delivery = 'announce';
          if (!job.model) job.model = null;
          if (!job.state) job.state = { nextRun: null, lastRun: null, lastStatus: null, consecutiveErrors: 0 };
          if (job.state.lastDurationMs === undefined) job.state.lastDurationMs = null;
          cronToDb(job);
        }
        jobs = oldJobs;
        log.info({ count: oldJobs.length }, 'Migrated crons from JSON to SQLite');
      } catch (migErr) {
        if (migErr.code !== 'ENOENT') {
          log.warn({ err: migErr.message }, 'Error migrating old crons');
        }
      }
    }
    log.info({ count: jobs.length }, 'Loaded cron jobs from SQLite');
  } catch (err) {
    jobs = [];
    log.error({ err: err.message }, 'Failed to load crons from SQLite');
  }
}

function save() {
  // Each job is saved to DB inline after updates (see cronToDb)
}

// --- Send function injection (avoids circular import) ---

export function setSendFn(fn) {
  sendFn = fn;
  log.info('Send function injected');
}

export function setQueue(q) {
  queueSlot = q;
  log.info('Queue injected for cron concurrency control');
}

// --- Job execution ---

async function runJob(job) {
  // Execution lock: skip if this job is already running
  if (runningJobs.has(job.id)) {
    log.warn({ job: job.name, id: job.id }, 'Skipping cron — already running');
    return;
  }
  runningJobs.add(job.id);

  const runStart = Date.now();
  const delivery = job.delivery || 'announce';
  const quiet = isQuietHours();
  const shouldSend = delivery === 'announce' && sendFn && !quiet;

  log.info({ job: job.name, id: job.id, delivery, quiet, model: job.model || 'default' }, 'Cron firing');
  runHook('onCronRun', job);

  // Save lastRun immediately so a crash during execution doesn't cause re-fire
  job.state.lastRun = Date.now();
  job.state.lastStatus = 'running';
  cronToDb(job);
  save();

  try {
    // No streaming — accumulate result and send one Telegram message at the end
    const onChunk = null;

    // Acquire a queue slot so crons don't compete with WhatsApp messages
    if (queueSlot) {
      log.info({ job: job.name }, 'Cron waiting for queue slot');
      await queueSlot.acquireSlot();
    }

    let reply, claudeMs;
    try {
      // Persistent session per cron job (stored in job.state, survives restarts)
      ({ reply, claudeMs } = await chatOneShot(job.prompt, onChunk, job.model, { cronId: job.id, cronName: job.name, cronState: job.state }));
    } finally {
      if (queueSlot) queueSlot.releaseSlot();
    }

    // Update state
    job.state.lastRun = Date.now();
    job.state.lastStatus = 'ok';
    job.state.lastDurationMs = Date.now() - runStart;
    job.state.consecutiveErrors = 0;
    recordCron(true);
    try { recordCronDelivery(job.id, job.name); } catch {}
    cronToDb(job);
    save();

    const totalMs = Date.now() - runStart;
    log.info({ job: job.name, totalMs, claudeMs, replyLen: reply.length, delivery, quiet }, 'Cron completed');
    wsEmit('cron:completed', { name: job.name, id: job.id, durationMs: totalMs, ts: Date.now() });

    // Send cron result to Telegram (announce mode, outside quiet hours)
    if (shouldSend && reply.trim()) {
      sendFn(`*[Cron: ${job.name}]*\n${reply.slice(0, 4000)}`, job.name);
    }
    // Silent mode: only notify if result contains ALERT
    if (delivery === 'silent' && reply.includes('ALERT')) {
      notify(`*[Cron: ${job.name}]*\n${reply.slice(0, 500)}`);
    }

    // Save daily-summary result as dashboard recap
    if (job.id === 'dailysummary' && reply.trim()) {
      const TZ = config.timezone;
      const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      const recapResult = { text: reply.trim(), generatedAt: Date.now() };
      setState('last-recap', recapResult);
      setState(`recap:${today}`, recapResult);
      log.info({ date: today }, 'Daily summary saved as dashboard recap');
    }
  } catch (err) {
    runHook('onCronError', job, err);
    job.state.lastRun = Date.now();
    job.state.lastStatus = `error: ${err.message}`;
    job.state.lastDurationMs = Date.now() - runStart;
    job.state.consecutiveErrors = (job.state.consecutiveErrors || 0) + 1;
    recordCron(false);
    cronToDb(job);
    save();

    const totalMs = Date.now() - runStart;
    log.error({ job: job.name, err: err.message, totalMs, consecutive: job.state.consecutiveErrors }, 'Cron failed');
    wsEmit('cron:failed', { name: job.name, id: job.id, error: err.message, consecutive: job.state.consecutiveErrors, ts: Date.now() });

    // Send error to Telegram (announce mode only, outside quiet hours)
    if (shouldSend) {
      try { sendFn(`*[Cron: ${job.name}]* Error: ${err.message}`, job.name); } catch {}
    }

    // Alert on 3+ consecutive errors (always, regardless of mode/quiet hours)
    if (job.state.consecutiveErrors >= 3) {
      notify(`*[Cron "${job.name}"]* has failed ${job.state.consecutiveErrors} times in a row: ${err.message}`);
    }

    // Alert on first error for silent jobs (they're supposed to work quietly)
    if (delivery === 'silent' && job.state.consecutiveErrors === 1) {
      notify(`*[Cron "${job.name}"]* failed: ${err.message}`);
    }
  } finally {
    runningJobs.delete(job.id);
  }
}

// --- Scheduling ---

function scheduleJob(job) {
  if (scheduledCrons.has(job.id)) {
    scheduledCrons.get(job.id).stop();
    scheduledCrons.delete(job.id);
  }

  if (!job.enabled) return;

  try {
    const cron = new Cron(job.schedule, {
      timezone: job.tz || DEFAULT_TZ,
      protect: true,
    }, () => runJob(job));

    scheduledCrons.set(job.id, cron);

    // nextRun() can return null in croner v10 when protect:true is combined with a
    // callback (known quirk). Fall back to a probe Cron (no callback) to compute it.
    let next = cron.nextRun();
    if (next == null) {
      try {
        const probe = new Cron(job.schedule, { timezone: job.tz || DEFAULT_TZ });
        next = probe.nextRun();
        probe.stop();
        log.warn({ job: job.name, next: next?.toISOString() ?? 'null' }, 'nextRun() was null — used probe fallback');
      } catch (probeErr) {
        log.warn({ job: job.name, err: probeErr.message }, 'probe nextRun also failed');
      }
    }
    job.state.nextRun = next ? next.getTime() : null;
    cronToDb(job);
    save();

    log.info({ job: job.name, schedule: job.schedule, delivery: job.delivery, model: job.model, nextRun: next?.toISOString() }, 'Job scheduled');
  } catch (err) {
    log.error({ job: job.name, err: err.message }, 'Failed to schedule job');
  }
}

export function initScheduler() {
  log.info({ count: jobs.length }, 'Initializing cron scheduler');
  for (const job of jobs) {
    scheduleJob(job);
  }
}

// --- CRUD ---

function findJob(idOrName) {
  const lower = idOrName.toLowerCase();
  return jobs.find(j => j.id === idOrName || j.name.toLowerCase() === lower);
}

export function listCrons() {
  for (const job of jobs) {
    const cron = scheduledCrons.get(job.id);
    if (cron) {
      const next = cron.nextRun();
      job.state.nextRun = next ? next.getTime() : null;
    }
  }
  return jobs;
}

export function getCronSummary() {
  const all = listCrons();
  if (all.length === 0) return 'No scheduled cron jobs.';

  const lines = all.map(j => {
    const status = j.enabled ? 'on' : 'off';
    const mode = j.delivery || 'announce';
    const model = j.model || 'default';
    const last = j.state.lastRun
      ? new Date(j.state.lastRun).toLocaleString('en-IL', { timeZone: j.tz || DEFAULT_TZ })
      : 'never';
    const next = j.state.nextRun
      ? new Date(j.state.nextRun).toLocaleString('en-IL', { timeZone: j.tz || DEFAULT_TZ })
      : 'n/a';
    const lastStatus = j.state.lastStatus || 'n/a';
    const duration = j.state.lastDurationMs ? `${(j.state.lastDurationMs / 1000).toFixed(1)}s` : '';
    return `- "${j.name}" [${status}|${mode}] ${j.schedule} (${model}) last: ${last} (${lastStatus}${duration ? ', ' + duration : ''}), next: ${next}`;
  });
  return lines.join('\n');
}

export function getCron(idOrName) {
  return findJob(idOrName);
}

export function addCron(name, schedule, prompt, tz, delivery = 'announce', model = null) {
  // Validate cron expression
  const testCron = new Cron(schedule);
  testCron.stop();

  // Prevent duplicate names (case-insensitive)
  const existing = findJob(name);
  if (existing) {
    throw new Error(`Cron "${name}" already exists (id: ${existing.id}). Delete it first or use a different name.`);
  }

  const id = randomBytes(4).toString('hex');
  const job = {
    id,
    name,
    enabled: true,
    schedule,
    tz: tz || DEFAULT_TZ,
    prompt,
    delivery,  // 'announce' (send to WhatsApp) or 'silent' (log only, alert on failure)
    model,     // null = use default, or specific model name
    createdAt: Date.now(),
    state: {
      nextRun: null,
      lastRun: null,
      lastStatus: null,
      lastDurationMs: null,
      consecutiveErrors: 0,
    },
  };

  jobs.push(job);
  cronToDb(job);
  save();
  scheduleJob(job);

  log.info({ id, name, schedule, delivery, model }, 'Cron job added');
  return job;
}

export function deleteCron(idOrName) {
  const job = findJob(idOrName);
  if (!job) return null;

  if (scheduledCrons.has(job.id)) {
    scheduledCrons.get(job.id).stop();
    scheduledCrons.delete(job.id);
  }

  jobs = jobs.filter(j => j.id !== job.id);
  getDb().prepare('DELETE FROM crons WHERE id = ?').run(job.id);
  save();

  log.info({ id: job.id, name: job.name }, 'Cron job deleted');
  return job;
}

export function toggleCron(idOrName) {
  const job = findJob(idOrName);
  if (!job) return null;

  job.enabled = !job.enabled;
  cronToDb(job);
  save();

  if (job.enabled) {
    scheduleJob(job);
  } else {
    if (scheduledCrons.has(job.id)) {
      scheduledCrons.get(job.id).stop();
      scheduledCrons.delete(job.id);
    }
    job.state.nextRun = null;
    cronToDb(job);
    save();
  }

  log.info({ id: job.id, name: job.name, enabled: job.enabled }, 'Cron job toggled');
  return job;
}

export function runCronNow(idOrName) {
  const job = findJob(idOrName);
  if (!job) return null;

  try { logObservableAction('cron_manual_run', { cronId: job.id, cronName: job.name }); } catch {}

  runJob(job).catch(err => {
    log.error({ job: job.name, err: err.message }, 'Manual cron run failed');
  });

  return job;
}
