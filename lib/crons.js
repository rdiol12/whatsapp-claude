import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { Cron } from 'croner';
import config from './config.js';
import { chatOneShot } from './claude.js';
import { notify } from './notify.js';
import { createLogger } from './logger.js';
import { writeFileAtomic } from './resilience.js';
import { runHook } from './plugins.js';
import { recordCron } from './metrics.js';

const log = createLogger('crons');
const CRONS_FILE = join(config.dataDir, 'crons.json');
const DEFAULT_TZ = 'Asia/Jerusalem';

// Quiet hours: suppress WhatsApp delivery (still runs, logs, alerts on failure)
const QUIET_START = config.quietStart;
const QUIET_END = config.quietEnd;

let jobs = [];          // in-memory job list
let scheduledCrons = new Map(); // id → Cron instance
let sendFn = null;      // injected by whatsapp.js

// --- Quiet hours check ---

function isQuietHours() {
  const now = new Date();
  const ilTime = new Date(now.toLocaleString('en-US', { timeZone: DEFAULT_TZ }));
  const hour = ilTime.getHours();
  return hour >= QUIET_START || hour < QUIET_END;
}

// --- Persistence ---

export function load() {
  try {
    const raw = readFileSync(CRONS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    jobs = data.jobs || [];
    // Migrate old jobs: add delivery/model fields if missing
    for (const job of jobs) {
      if (!job.delivery) job.delivery = 'announce';
      if (!job.model) job.model = null; // null = use default
      if (!job.state) job.state = { nextRun: null, lastRun: null, lastStatus: null, consecutiveErrors: 0 };
      if (job.state.lastDurationMs === undefined) job.state.lastDurationMs = null;
    }
    log.info({ count: jobs.length }, 'Loaded cron jobs');
  } catch (err) {
    jobs = [];
    if (err.code === 'ENOENT') {
      log.info('No crons file, starting fresh');
    } else {
      log.warn({ err: err.message }, 'Crons file corrupted, starting fresh');
    }
  }
}

function save() {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileAtomic(CRONS_FILE, JSON.stringify({ version: 2, jobs }, null, 2));
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save crons');
  }
}

// --- Send function injection (avoids circular import) ---

export function setSendFn(fn) {
  sendFn = fn;
  log.info('Send function injected');
}

// --- Job execution ---

async function runJob(job) {
  const runStart = Date.now();
  const delivery = job.delivery || 'announce';
  const quiet = isQuietHours();
  const shouldSend = delivery === 'announce' && sendFn && !quiet;

  log.info({ job: job.name, id: job.id, delivery, quiet, model: job.model || 'default' }, 'Cron firing');
  runHook('onCronRun', job);

  try {
    // Send header (only for announce mode outside quiet hours)
    if (shouldSend) {
      await sendFn(`*[Cron: ${job.name}]* Running...`);
    }

    // Stream chunks to WhatsApp (only for announce mode)
    const onChunk = shouldSend ? async (chunk) => {
      const clean = chunk.trim();
      if (!clean) return;
      await sendFn(clean);
    } : null;

    // One-shot: isolated session per cron run
    const { reply, claudeMs } = await chatOneShot(job.prompt, onChunk, job.model);

    // Update state
    job.state.lastRun = Date.now();
    job.state.lastStatus = 'ok';
    job.state.lastDurationMs = Date.now() - runStart;
    job.state.consecutiveErrors = 0;
    recordCron(true);
    save();

    const totalMs = Date.now() - runStart;
    log.info({ job: job.name, totalMs, claudeMs, replyLen: reply.length, delivery, quiet }, 'Cron completed');

    // Silent mode: only notify on Telegram if result contains ALERT
    if (delivery === 'silent' && reply.includes('ALERT')) {
      notify(`*[Cron: ${job.name}]*\n${reply.slice(0, 500)}`);
    }
  } catch (err) {
    runHook('onCronError', job, err);
    job.state.lastRun = Date.now();
    job.state.lastStatus = `error: ${err.message}`;
    job.state.lastDurationMs = Date.now() - runStart;
    job.state.consecutiveErrors = (job.state.consecutiveErrors || 0) + 1;
    recordCron(false);
    save();

    const totalMs = Date.now() - runStart;
    log.error({ job: job.name, err: err.message, totalMs, consecutive: job.state.consecutiveErrors }, 'Cron failed');

    // Send error to WhatsApp (announce mode only, outside quiet hours)
    if (shouldSend) {
      try { await sendFn(`*[Cron: ${job.name}]* Error: ${err.message}`); } catch {}
    }

    // Alert on 3+ consecutive errors (always, regardless of mode/quiet hours)
    if (job.state.consecutiveErrors >= 3) {
      notify(`*[Cron "${job.name}"]* has failed ${job.state.consecutiveErrors} times in a row: ${err.message}`);
    }

    // Alert on first error for silent jobs (they're supposed to work quietly)
    if (delivery === 'silent' && job.state.consecutiveErrors === 1) {
      notify(`*[Cron "${job.name}"]* failed: ${err.message}`);
    }
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

    const next = cron.nextRun();
    job.state.nextRun = next ? next.getTime() : null;
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
  save();

  log.info({ id: job.id, name: job.name }, 'Cron job deleted');
  return job;
}

export function toggleCron(idOrName) {
  const job = findJob(idOrName);
  if (!job) return null;

  job.enabled = !job.enabled;
  save();

  if (job.enabled) {
    scheduleJob(job);
  } else {
    if (scheduledCrons.has(job.id)) {
      scheduledCrons.get(job.id).stop();
      scheduledCrons.delete(job.id);
    }
    job.state.nextRun = null;
    save();
  }

  log.info({ id: job.id, name: job.name, enabled: job.enabled }, 'Cron job toggled');
  return job;
}

export function runCronNow(idOrName) {
  const job = findJob(idOrName);
  if (!job) return null;

  runJob(job).catch(err => {
    log.error({ job: job.name, err: err.message }, 'Manual cron run failed');
  });

  return job;
}
