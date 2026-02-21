import 'dotenv/config';
import { load, flushHistory } from './lib/history.js';
import { load as loadCrons, initScheduler } from './lib/crons.js';
import { load as loadGoals, flush as flushGoals, listGoals, getGoal, addGoal, updateGoal, deleteGoal, addMilestone, completeMilestone, getGoalSummary, getGoalDetail } from './lib/goals.js';
import { init as initWorkflows, cleanup as cleanupWorkflows, listWorkflows, getWorkflow, getWorkflowSummary, getWorkflowDetail, createWorkflow, startWorkflow, cancelWorkflow, pauseWorkflow, resumeWorkflow, handleUserInput as handleWorkflowInput, hasWaitingWorkflow } from './lib/workflow-engine.js';
import { startWhatsApp } from './lib/whatsapp.js';
import { notify } from './lib/notify.js';
import { createLogger } from './lib/logger.js';
import { init as initMcpGateway, close as closeMcpGateway } from './lib/mcp-gateway.js';
import { loadPlugins, shutdownPlugins } from './lib/plugins.js';
import { startProactiveLoop, stopProactiveLoop } from './lib/proactive.js';
import { startIpcServer, stopIpcServer } from './lib/bot-ipc.js';
import { startTelegramPolling, stopTelegramPolling } from './lib/telegram.js';
import { createQueue } from './lib/queue.js';
import { getState, setState } from './lib/state.js';
import { searchMemories, smartIngest, setIntention } from './lib/mcp-gateway.js';
import { Cron } from 'croner';
import { addCron, deleteCron, toggleCron, listCrons, runCronNow } from './lib/crons.js';
import { generateRecap } from './lib/recap.js';
import { getMessages, addMessage } from './lib/history.js';
import { persistMetrics } from './lib/metrics.js';
import { flushOutcomeState } from './lib/outcome-tracker.js';
import config from './lib/config.js';

const log = createLogger('bot');

log.info('=== WhatsApp Claude Bot ===');
log.info({ model: process.env.CLAUDE_MODEL || 'sonnet', persistentMode: config.persistentMode }, 'Config loaded');

// Startup config validation — warn on missing critical vars
if (!config.allowedPhone) {
  log.warn('SECURITY: ALLOWED_PHONE not set — bot will accept messages from ANY number');
}
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
  log.warn('Telegram alerts disabled — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
}
if (!process.env.DASHBOARD_SECRET) {
  log.warn('SECURITY: DASHBOARD_SECRET not set — dashboard has NO authentication');
}
log.info({ allowedPhone: config.allowedPhone ? config.allowedPhone.slice(0, 4) + '****' : 'NOT SET' }, 'Allowed phone configured');

// Load conversation history from disk
load();

// Load cron jobs and start scheduler
loadCrons();
initScheduler();

// Load goals
loadGoals();

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
};

// Load plugins
await loadPlugins(botApi);

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
  stopIpcServer();
  recapCron.stop();
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
  notify(`*WhatsApp Claude Bot* shutting down (${signal}).`);
  log.info({ totalMs: Date.now() - shutdownStart }, 'Shutdown complete');

  // Give Telegram API a moment to send
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', () => onShutdown('SIGINT'));
process.on('SIGTERM', () => onShutdown('SIGTERM'));

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

// Start WhatsApp connection
startWhatsApp({ queue, botApi });

// Start Telegram receive (two-way control)
startTelegramPolling({ queueStats: () => queue.stats() });

// Initialize workflow engine (resumes interrupted workflows, wires queue)
// Wrapper sendFn reads botApi.send at call time (set when WhatsApp connects)
initWorkflows({
  send: async (text) => {
    if (botApi.send) await botApi.send(text);
    else log.warn({ text: text.slice(0, 80) }, 'Workflow message dropped (no send function)');
  },
  queue,
});

// Start proactive agent loop (reminders, cron failure alerts)
// Wrapper ensures it uses botApi.send which gets wired when WhatsApp connects
startProactiveLoop(async (text) => {
  if (botApi.send) await botApi.send(text);
  else log.warn({ text: text.slice(0, 100) }, 'Proactive message dropped (no send function)');
});

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

// Bootstrap: daily recap at 22:00 (silent delivery, announce result via WhatsApp)
const recapCron = new Cron('0 22 * * *', { timezone: 'Asia/Jerusalem' }, async () => {
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
