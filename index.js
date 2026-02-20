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
import { addCron, deleteCron, toggleCron, listCrons, runCronNow } from './lib/crons.js';
import { getMessages, addMessage } from './lib/history.js';
import { persistMetrics } from './lib/metrics.js';
import config from './lib/config.js';

const log = createLogger('bot');

log.info('=== WhatsApp Claude Bot ===');
log.info({ model: process.env.CLAUDE_MODEL || 'sonnet' }, 'Model configured');
log.info({ allowedPhone: process.env.ALLOWED_PHONE || '972543260864' }, 'Allowed phone configured');

// Load conversation history from disk
load();

// Load cron jobs and start scheduler
loadCrons();
initScheduler();

// Load goals
loadGoals();

// Connect to vestige-mcp persistently (for pre-fetch context)
await initMcpGateway();

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
  log.info({ ms: Date.now() - t1 }, 'Shutdown: stopped accepting new work');

  // 2. Drain in-flight messages (up to 10s)
  const t2 = Date.now();
  const drained = await queue.drain(10_000);
  log.info({ ms: Date.now() - t2, drained }, 'Shutdown: queue drain');

  // 3. Persist state
  const t3 = Date.now();
  flushHistory();
  flushGoals();
  cleanupWorkflows();
  persistMetrics();
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
