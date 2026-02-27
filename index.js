// ── Pre-flight checks (before any imports that might fail) ──────────────────

// Node version check — ES module features require Node 22+
const nodeVersion = parseInt(process.version.split('.')[0].slice(1), 10);
if (nodeVersion < 22) {
  console.error(`ERROR: Node.js 22+ required. Current version: ${process.version}`);
  console.error('Download: https://nodejs.org/');
  process.exit(1);
}

// Force UTF-8 console on Windows so Hebrew renders correctly in logs
import { execSync } from 'child_process';
if (process.platform === 'win32') {
  try { execSync('chcp 65001', { stdio: 'ignore' }); } catch {}
}

import 'dotenv/config';
import { load, flushHistory } from './lib/history.js';
import { load as loadCrons, initScheduler } from './lib/crons.js';
import { load as loadGoals, flush as flushGoals, startDbPoll, stopDbPoll, listGoals, getGoal, addGoal, updateGoal, deleteGoal, addMilestone, completeMilestone, getGoalSummary, getGoalDetail } from './lib/goals.js';
import { init as initWorkflows, cleanup as cleanupWorkflows, listWorkflows, getWorkflow, getWorkflowSummary, getWorkflowDetail, createWorkflow, startWorkflow, cancelWorkflow, pauseWorkflow, resumeWorkflow, handleUserInput as handleWorkflowInput, hasWaitingWorkflow } from './lib/workflow-engine.js';
import { startWhatsApp } from './lib/whatsapp.js';
import { notify } from './lib/notify.js';
import { createLogger, registerErrorHook } from './lib/logger.js';
import { logError, getErrors } from './lib/db.js';
import { init as initMcpGateway, close as closeMcpGateway } from './lib/mcp-gateway.js';
import { loadPlugins, shutdownPlugins } from './lib/plugins.js';
import { startProactiveLoop, stopProactiveLoop } from './lib/proactive.js';
import { startAgentLoop, stopAgentLoop } from './lib/agent-loop.js';
import { loadModules } from './lib/module-loader.js';
import { startIpcServer, stopIpcServer } from './lib/bot-ipc.js';
import { startGateway, stopGateway, getChannelStats } from './lib/ws-gateway.js';
import { getStatus as getWaChannelStatus, getStats as getWaChannelStats } from './lib/channel-wa.js';
import { getStatus as getTgChannelStatus, getStats as getTgChannelStats } from './lib/channel-telegram.js';
import { startTelegramPolling, stopTelegramPolling } from './lib/telegram.js';
import { createQueue } from './lib/queue.js';
import { getState, setState } from './lib/state.js';
import { searchMemories, smartIngest, setIntention } from './lib/mcp-gateway.js';
import { Cron } from 'croner';
import { addCron, deleteCron, toggleCron, listCrons, runCronNow, setQueue as setCronQueue } from './lib/crons.js';
import { generateRecap } from './lib/recap.js';
import { rollupOldCosts } from './lib/cost-analytics.js';
import { getMessages, addMessage } from './lib/history.js';
import { persistMetrics } from './lib/metrics.js';
import { flushOutcomeState } from './lib/outcome-tracker.js';
import config from './lib/config.js';

const log = createLogger('bot');

log.info('=== Sela ===');
log.info({ model: process.env.CLAUDE_MODEL || 'sonnet', persistentMode: config.persistentMode }, 'Config loaded');

// Pre-flight: ensure required directories exist (prevents cryptic ENOENT crashes)
import { existsSync, mkdirSync } from 'fs';
for (const dir of [config.authDir, config.dataDir, config.logsDir, config.workspaceDir]) {
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
      log.info({ dir }, 'Created missing directory');
    } catch (err) {
      log.error({ dir, err: err.message }, 'SETUP ERROR: Cannot create required directory');
      log.error('Run: npm run setup');
      process.exit(1);
    }
  }
}

// Startup config validation
if (!config.allowedPhone) {
  log.error('SETUP ERROR: ALLOWED_PHONE not set — bot cannot operate without a target phone number');
  log.error('Run: npm run setup (or set ALLOWED_PHONE in .env)');
  process.exit(1);
}
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
  log.info('Telegram alerts disabled — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
}
if (!process.env.DASHBOARD_SECRET) {
  log.info('Dashboard auth disabled — set DASHBOARD_SECRET in .env to enable');
}
log.info({ allowedPhone: config.allowedPhone.slice(0, 4) + '****' }, 'Allowed phone configured');

// Register error hook to capture all error/warn logs to SQLite (M3: automatic error capture)
registerErrorHook((severity, module, message, stack = null, context = null) => {
  try {
    logError(severity, module, message, stack, context, false); // sendAlert=false to avoid double alerts
  } catch (err) {
    // Silently fail — don't cascade errors from error logging
  }
});

// Guardian ms_1: Detect restart → Telegram alert on unexpected restart
// Rate-limited to 1 alert per 2 minutes — prevents Telegram spam during rapid PM2 crash loops.
try {
  const guardianState = getState('guardian');
  const now = Date.now();
  const TWO_MIN = 2 * 60_000;
  const lastAlertAt = guardianState.lastGuardianAlertAt || 0;
  const shouldAlert = (now - lastAlertAt) > TWO_MIN;
  if (guardianState.lastStartupAt) {
    const uptimeMs = now - guardianState.lastStartupAt;
    const uptimeMins = Math.round(uptimeMs / 60000);
    if (uptimeMs < 300_000) {
      if (shouldAlert) notify(`*[Guardian] Sela crash-restart* — previous process lived only ${Math.round(uptimeMs / 1000)}s. Possible boot loop!`);
      log.warn({ uptimeSecs: Math.round(uptimeMs / 1000), alertSent: shouldAlert }, 'Guardian: crash restart detected');
    } else {
      if (shouldAlert) notify(`*[Guardian] Sela restarted* — was up ${uptimeMins}m`);
      log.info({ uptimeMins, alertSent: shouldAlert }, 'Guardian: normal restart');
    }
  }
  setState('guardian', { lastStartupAt: now, lastGuardianAlertAt: shouldAlert ? now : lastAlertAt });
} catch (err) {
  log.debug({ err: err.message }, 'Guardian: restart tracking failed');
}

// Load conversation history from disk
load();

// Load cron jobs and start scheduler
loadCrons();
initScheduler();

// Load goals + start polling for external DB changes
loadGoals();
startDbPoll();

// Connect to vestige-mcp persistently (for pre-fetch context)
await initMcpGateway();

// Initialize persistent Claude process (if enabled)
if (config.persistentMode) {
  const { initPersistentProcess } = await import('./lib/claude-persistent.js');
  const { getSessionId, getSystemPrompt } = await import('./lib/claude.js');
  initPersistentProcess(getSessionId(), getSystemPrompt());
  log.info('Persistent Claude process initialized');
}

// Create message queue (concurrency control)
const queue = createQueue({
  maxConcurrent: config.maxConcurrent,
  maxQueuePerUser: config.maxQueuePerUser,
});

// Wire queue into crons so they share concurrency slots with WhatsApp messages
setCronQueue(queue);

// Build botApi for plugins
const botApi = {
  send: null, // wired when WhatsApp socket connects
  notify,
  log,
  state: { get: getState, set: setState },
  config,
  _queue: queue,
  // Memory (vestige MCP)
  memory: { search: searchMemories, ingest: smartIngest, setIntention },
  // Cron management
  crons: { add: addCron, delete: deleteCron, toggle: toggleCron, list: listCrons, runNow: runCronNow },
  // Conversation history
  history: { get: getMessages, add: addMessage },
  // Goals (long-running objectives)
  goals: { list: listGoals, get: getGoal, add: addGoal, update: updateGoal, delete: deleteGoal, addMilestone, completeMilestone, summary: getGoalSummary, detail: getGoalDetail },
  // Workflows (multi-step autonomous execution)
  workflows: { list: listWorkflows, get: getWorkflow, create: createWorkflow, start: startWorkflow, cancel: cancelWorkflow, pause: pauseWorkflow, resume: resumeWorkflow, summary: getWorkflowSummary, detail: getWorkflowDetail, handleInput: handleWorkflowInput, hasWaiting: hasWaitingWorkflow },
  // Shutdown flag
  isShuttingDown: () => shuttingDown,
  // WhatsApp channel adapter status
  waChannel: { getStatus: getWaChannelStatus, getStats: getWaChannelStats },
  // Telegram channel adapter status
  tgChannel: { getStatus: getTgChannelStatus, getStats: getTgChannelStats },
};

// Load plugins
await loadPlugins(botApi);

// Load tool-bridge skill companions (Phase 1: external tool integration)
try {
  const { loadSkillCompanions } = await import('./lib/tool-bridge.js');
  await loadSkillCompanions();
} catch (err) {
  log.warn?.({ err: err.message }, 'Failed to load tool-bridge skill companions') || console.warn('tool-bridge load failed:', err.message);
}

// Notify on shutdown (PM2 restart, crash, SIGINT)
let shuttingDown = false;

async function onShutdown(signal) {
  if (shuttingDown) return; // prevent double shutdown
  shuttingDown = true;
  const shutdownStart = Date.now();
  log.info({ signal }, 'Shutting down');

  // 1. Stop accepting new work
  const t1 = Date.now();
  stopTelegramPolling();
  stopProactiveLoop();
  stopAgentLoop();
  stopIpcServer();
  stopGateway();
  recapCron.stop();
  morningHealthCron.stop();
  costsRollupCron.stop();
  log.info({ ms: Date.now() - t1 }, 'Shutdown: stopped accepting new work');

  // 2. Drain in-flight messages (up to 10s)
  const t2 = Date.now();
  const drained = await queue.drain(10_000);
  log.info({ ms: Date.now() - t2, drained }, 'Shutdown: queue drain');

  // 2b. Shutdown persistent Claude process (if enabled)
  if (config.persistentMode) {
    const { shutdownPersistentProcess } = await import('./lib/claude-persistent.js');
    shutdownPersistentProcess();
    log.info('Shutdown: persistent Claude process stopped');
  }

  // 3. Persist state
  const t3 = Date.now();
  stopDbPoll();
  flushHistory();
  flushGoals();
  cleanupWorkflows();
  persistMetrics();
  try { flushOutcomeState(); } catch {}
  log.info({ ms: Date.now() - t3 }, 'Shutdown: state persisted');

  // 4. Shutdown plugins
  const t4 = Date.now();
  await shutdownPlugins();
  log.info({ ms: Date.now() - t4 }, 'Shutdown: plugins stopped');

  // 5. Close MCP connection
  const t5 = Date.now();
  await closeMcpGateway();
  log.info({ ms: Date.now() - t5 }, 'Shutdown: MCP closed');

  // 6. Send notification
  notify(`*Sela* shutting down (${signal}).`);
  log.info({ totalMs: Date.now() - shutdownStart }, 'Shutdown complete');

  // Give Telegram API a moment to send
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', () => onShutdown('SIGINT'));
process.on('SIGTERM', () => onShutdown('SIGTERM'));

// Guardian ms_2: Process self-protection — intercept unexpected exits and alert
const _originalExit = process.exit.bind(process);
process.exit = (code) => {
  if (code !== 0) {
    // Capture non-clean exits that bypass the graceful shutdown handler
    const stack = new Error().stack?.split('\n').slice(1, 3).join(' | ') || '';
    notify(`*[Guardian] Sela exit(${code})* — unexpected termination. ${stack.slice(0, 200)}`);
    log.warn({ exitCode: code, stack }, 'Guardian: unexpected exit intercepted');
    // Give Telegram ~1s to send before dying; unref so it doesn't block a clean exit
    setTimeout(() => _originalExit(code), 1000).unref();
    return;
  }
  _originalExit(code);
};

// Catch unhandled errors — log + alert instead of silent crash
process.on('unhandledRejection', (err) => {
  log.error({ err: err?.message || String(err), stack: err?.stack }, 'Unhandled rejection');
  notify('ALERT: Unhandled rejection — ' + (err?.message || String(err)).slice(0, 200));
});
process.on('uncaughtException', (err) => {
  log.error({ err: err.message, stack: err.stack }, 'Uncaught exception');
  notify('ALERT: Uncaught exception — ' + err.message.slice(0, 200));
  setTimeout(() => process.exit(1), 2000);
});

// Start IPC server (used by bot-ops MCP server)
startIpcServer({ queueStats: () => queue.stats() });

// Start WebSocket gateway — channel adapters (WA, Telegram, Web) connect here
// See lib/ws-gateway.js for the protocol spec (ms_1) and implementation (ms_2)
startGateway({
  onMessage: (channel, from, body, rawMsg) => {
    log.info({ channel, from, bodyLen: body.length }, 'WS gateway: inbound message');
    // Future: route to queue for multi-channel support (ms_3–ms_5 will wire adapters)
  },
});

// Start WhatsApp connection
startWhatsApp({ queue, botApi });

// Start Telegram receive (two-way control)
startTelegramPolling({ queueStats: () => queue.stats() });

// Initialize workflow engine (resumes interrupted workflows, wires queue)
// All automated messages → Telegram (WhatsApp stays clean for conversations)
initWorkflows({
  send: async (text) => {
    notify(text);
  },
  queue,
});

// Start proactive agent loop (reminders, cron failure alerts)
// Proactive loop now routes to WA groups via sendToGroup() internally.
// This sendFn serves as Telegram fallback only.
startProactiveLoop(async (text) => {
  notify(text);
});

// Load optional modules (e.g. modules/hattrick/) before starting agent loop
await loadModules();

// Start autonomous agent loop (ReAct cycle with native tool calling)
// Agent loop now routes to WA groups via sendToGroup() internally.
startAgentLoop(async (text) => {
  notify(text);
}, queue);

// Hattrick automation: merged into agent-loop signal system (hattrick-cycle.js deleted)

// Recover interrupted tasks from previous session
const activeTask = getState('active-task');
if (activeTask.status === 'planning' || activeTask.status === 'executing') {
  log.warn({ taskId: activeTask.taskId, status: activeTask.status }, 'Found interrupted task from previous session');
  setState('active-task', { ...activeTask, status: 'interrupted', interruptedAt: Date.now() });
}

// Bootstrap: ensure vestige maintenance cron exists (weekly gc + consolidate)
if (!listCrons().some(j => j.id === 'vestige-gc' || j.name === 'vestige-gc')) {
  addCron('vestige-gc', '0 23 * * 0', 'Run vestige memory maintenance: 1) Call the consolidate MCP tool to merge duplicate/similar memories. 2) Call garbageCollect with dryRun=false and minRetention=0.1 to remove low-value memories. 3) Call findDuplicates with threshold=0.8 and report how many were found. Report a brief summary of what was cleaned up.', null, 'silent');
  log.info('Bootstrap: created vestige-gc cron (Sunday 23:00)');
}

// Bootstrap: weekly costs rollup — Sunday midnight, directly calls rollupOldCosts()
// Keeps costs.jsonl compact by aggregating entries older than 7 days into daily summaries.
// (costs.jsonl rotation goal ms_3)
const costsRollupCron = new Cron('0 0 * * 0', { timezone: config.timezone }, async () => {
  log.info('Weekly costs rollup cron firing');
  try {
    const result = rollupOldCosts(7);
    if (result.rolledUp > 0) {
      log.info(result, 'Weekly costs rollup complete');
      notify(`📊 *Costs rollup*: archived ${result.rolledUp} entries older than 7 days → ${result.dailySummaries} daily summaries`);
    } else {
      log.info(result, 'Weekly costs rollup: nothing to roll up');
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Weekly costs rollup failed');
  }
});
log.info('Bootstrap: weekly costs rollup cron scheduled (Sunday 00:00 Israel)');

// Bootstrap: daily recap at 22:00 (silent delivery, announce result via WhatsApp)
const recapCron = new Cron('0 22 * * *', { timezone: config.timezone }, async () => {
  log.info('Daily recap cron firing');
  try {
    const { text, generatedAt } = await generateRecap();
    if (botApi.send && text) {
      await botApi.send(`*Daily Recap*\n\n${text}`);
      log.info('Sent end-of-day recap');
    } else {
      log.warn('Daily recap generated but no send function available');
    }
  } catch (err) {
    log.error({ err: err.message }, 'Daily recap cron failed');
    notify('Daily recap failed: ' + err.message);
  }
});
log.info('Bootstrap: daily recap cron scheduled (22:00)');

// Morning Telegram health summary — runs at 08:00 Israel (telegram-crash-alerts M4).
// Closes the overnight blind spot: cycle count, errors, cost delivered to Telegram.
const morningHealthCron = new Cron('0 8 * * *', { timezone: config.timezone }, async () => {
  log.info('Morning health cron firing');
  try {
    const loopState = getState('agent-loop');
    const cycleCount = loopState.cycleCount || 0;
    const dailyCost = (loopState.dailyCost || 0).toFixed(2);
    const lastSpawnMs = loopState.lastClaudeSpawnAt ? Date.now() - loopState.lastClaudeSpawnAt : null;
    const lastCycleAgo = lastSpawnMs ? `${Math.round(lastSpawnMs / 60000)}m ago` : 'unknown';

    // Errors from last 8 hours
    const cutoff = Date.now() - 8 * 3600_000;
    const recentErrors = getErrors(100).filter(e => e.ts >= cutoff);
    const critCount = recentErrors.filter(e => e.severity === 'error' || e.severity === 'critical').length;
    const warnCount = recentErrors.filter(e => e.severity === 'warning').length;

    const errorLine = critCount > 0
      ? `⚠️ *${critCount} error${critCount !== 1 ? 's' : ''}* overnight — check logs`
      : warnCount > 0
        ? `🟡 ${warnCount} warning${warnCount !== 1 ? 's' : ''} overnight`
        : '✅ No errors overnight';

    notify([
      `🌅 *Morning Health Summary*`,
      `Cycles: ${cycleCount} total | Last: ${lastCycleAgo}`,
      `Cost today: $${dailyCost}`,
      errorLine,
    ].join('\n'));
    log.info('Morning health summary sent to Telegram');
  } catch (err) {
    log.warn({ err: err.message }, 'Morning health cron failed');
  }
});
log.info('Bootstrap: morning health cron scheduled (08:00 Israel)');

// Telegram startup notification — catches PM2 crash restarts (telegram-crash-alerts M3).
// Every PM2 restart (crash recovery) fires this. Rate-limited to 1 per 5 minutes to
// prevent spam during crash loops (exp_backoff_restart_delay handles the loop itself).
setTimeout(() => {
  try {
    const FIVE_MIN = 5 * 60_000;
    const lastNotify = getState('startup-notify-ts');
    if (!lastNotify.ts || (Date.now() - lastNotify.ts) > FIVE_MIN) {
      setState('startup-notify-ts', { ts: Date.now() });
      const now = new Date().toLocaleTimeString('en-IL', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hour12: false });
      notify(`🔄 *Sela started* at ${now} (Israel time). If this was unexpected, a crash may have occurred.`);
      log.info('Startup notification sent to Telegram');
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Startup notification failed');
  }
}, 3000);
