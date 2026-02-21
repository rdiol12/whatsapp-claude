import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import config from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('claude-persistent');
const MCP_CONFIG = join(homedir(), 'whatsapp-claude', 'mcp-config.json');

// Resolve claude CLI entry point (bypass shell to avoid Windows 8K cmd line limit)
const CLAUDE_CLI_JS = join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
if (!existsSync(CLAUDE_CLI_JS)) {
  log.error({ path: CLAUDE_CLI_JS }, 'Claude CLI entry point not found');
}

// --- State ---
let proc = null;
let lineBuffer = '';
let fullText = '';
let resultEvent = null;
let currentMessage = null;   // { id, content, resolve, reject, onTextDelta, onToolUse, timeout }
let pendingQueue = [];       // messages waiting to send
let isReady = false;
let respawnAttempts = 0;
const MAX_RESPAWN_ATTEMPTS = 5;
let lastActivity = Date.now();
let healthCheckInterval = null;
let sessionId = null;
let systemPrompt = null;
let spawnArgs = [];
let sessionStartedFlag = false; // tracks whether the CLI session has received a first message
let messageCount = 0;
let consecutiveTimeouts = 0;
let respawning = false; // lock to prevent double respawn

// --- Core functions ---

export function initPersistentProcess(sid, sysPrompt, extraArgs = []) {
  sessionId = sid;
  systemPrompt = sysPrompt;
  buildSpawnArgs(false, extraArgs);
  spawnProcess();

  // Health check every 60s
  healthCheckInterval = setInterval(() => {
    if (respawning) return; // respawn already scheduled

    if (!proc) {
      log.warn('Health check: process is null, attempting respawn');
      handleRespawn();
      return;
    }
    const idleMs = Date.now() - lastActivity;
    log.debug({ idleMs, alive: !!proc, queueDepth: pendingQueue.length }, 'Health check');

    // Proactive respawn after 500 messages to prevent heap growth
    // Re-check !currentMessage && !pendingQueue atomically before killing
    if (messageCount > 500 && !currentMessage && pendingQueue.length === 0) {
      log.info({ messageCount }, 'Proactive respawn after 500 messages');
      messageCount = 0;
      killProcess();
      sessionStartedFlag = true; // session exists, use --resume
      buildSpawnArgs(true);
      spawnProcess();
    }
  }, 60_000);

  log.info({ sessionId: sid.slice(0, 8) }, 'Persistent process initialized');
}

function buildSpawnArgs(isResume, extraArgs = []) {
  const homeDir = homedir().replace(/\\/g, '/');
  const base = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--model', config.claudeModel,
    '--mcp-config', MCP_CONFIG,
    '--permission-mode', 'bypassPermissions',
    '--add-dir', homeDir,
  ];

  if (isResume && sessionStartedFlag) {
    spawnArgs = [...base, '--resume', sessionId, ...extraArgs];
  } else {
    spawnArgs = [...base, '--session-id', sessionId, '--system-prompt', systemPrompt, ...extraArgs];
  }
}

function spawnProcess() {
  killProcess();

  log.info({ args: spawnArgs.join(' ').slice(0, 200), attempt: respawnAttempts }, 'Spawning persistent Claude process');

  const childEnv = { ...process.env };
  delete childEnv.CLAUDECODE;

  proc = spawn(process.execPath, [CLAUDE_CLI_JS, ...spawnArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
    windowsHide: true,
  });

  lineBuffer = '';
  fullText = '';
  resultEvent = null;

  proc.stdout.on('data', handleStdout);

  proc.stderr.on('data', (d) => {
    const msg = d.toString();
    if (/mcp|connection|error|fatal|crash/i.test(msg)) {
      log.warn({ stderr: msg.slice(0, 300) }, 'Persistent process stderr (notable)');
    } else {
      log.debug({ stderr: msg.slice(0, 200) }, 'Persistent process stderr');
    }
  });

  proc.on('close', (code) => {
    log.warn({ code }, 'Persistent process exited');
    proc = null;
    isReady = false;

    // Reject in-flight message
    if (currentMessage) {
      currentMessage.reject(new Error(`Persistent process exited (code ${code}) during message ${currentMessage.id}`));
      clearTimeout(currentMessage.timeout);
      currentMessage = null;
    }

    handleRespawn();
  });

  proc.on('error', (err) => {
    log.error({ err: err.message }, 'Persistent process error');
    proc = null;
    isReady = false;

    if (currentMessage) {
      currentMessage.reject(err);
      clearTimeout(currentMessage.timeout);
      currentMessage = null;
    }

    handleRespawn();
  });

  isReady = true;
  lastActivity = Date.now();

  // Drain queue in case messages were waiting
  drainQueue();
}

function handleStdout(chunk) {
  lineBuffer += chunk.toString();
  while (true) {
    const nlIdx = lineBuffer.indexOf('\n');
    if (nlIdx === -1) break;
    const line = lineBuffer.slice(0, nlIdx).trim();
    lineBuffer = lineBuffer.slice(nlIdx + 1);
    if (!line) continue;

    // Ignore stale output arriving after message was completed/timed out
    if (!currentMessage) continue;

    try {
      const event = JSON.parse(line);

      // Stream text deltas for real-time WhatsApp delivery
      if (event.type === 'stream_event' &&
          event.event?.type === 'content_block_delta' &&
          event.event.delta?.type === 'text_delta') {
        if (currentMessage?.onTextDelta) currentMessage.onTextDelta(event.event.delta.text);
      }

      // Tool use events
      if (event.type === 'stream_event' &&
          event.event?.type === 'content_block_start' &&
          event.event.content_block?.type === 'tool_use') {
        const toolName = event.event.content_block.name;
        if (currentMessage?.onToolUse) currentMessage.onToolUse(toolName);
      }

      // Complete assistant message (full text)
      if (event.type === 'assistant' && !event.partial && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') fullText += block.text;
        }
      }

      // Result event = turn complete
      if (event.type === 'result') {
        resultEvent = event;
        finishCurrentMessage();
      }
    } catch { /* skip non-JSON lines */ }
  }
}

function finishCurrentMessage() {
  if (!currentMessage) return;

  clearTimeout(currentMessage.timeout);
  lastActivity = Date.now();
  messageCount++;
  consecutiveTimeouts = 0;
  respawnAttempts = 0; // reset on successful completion

  const replyText = resultEvent?.result || fullText;

  if (resultEvent?.is_error) {
    const err = new Error(replyText || 'Claude returned error');
    err.isPermanent = true;
    currentMessage.reject(err);
  } else {
    const usage = resultEvent?.usage || {};
    currentMessage.resolve({
      text: replyText,
      durationMs: resultEvent?.duration_ms || 0,
      apiMs: resultEvent?.duration_api_ms || 0,
      costUsd: resultEvent?.total_cost_usd || 0,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
    });
  }

  // Clear current message (allows drainQueue to pick up the next one)
  currentMessage = null;
  // Note: fullText/resultEvent are reset in drainQueue() before the next message starts

  // Mark session as started after first successful message
  if (!sessionStartedFlag) sessionStartedFlag = true;

  drainQueue();
}

export function sendToPersistentProcess(content, onTextDelta, onToolUse) {
  return new Promise((resolve, reject) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    pendingQueue.push({ id, content, resolve, reject, onTextDelta, onToolUse });
    log.info({ id, queueDepth: pendingQueue.length }, 'Message queued for persistent process');
    drainQueue();
  });
}

function drainQueue() {
  if (!isReady || !proc || currentMessage || pendingQueue.length === 0) return;

  const msg = pendingQueue.shift();
  currentMessage = msg;

  // Reset accumulators
  fullText = '';
  resultEvent = null;

  // Per-message timeout
  msg.timeout = setTimeout(() => {
    consecutiveTimeouts++;
    log.warn({ id: msg.id, consecutiveTimeouts }, 'Persistent process message timeout');

    msg.reject(new Error(`Persistent process message timeout (${config.cliTimeout / 1000}s)`));
    currentMessage = null;

    // Escalating timeout recovery:
    // 3+ consecutive → MCP might be stuck, full respawn with new session
    // 2 consecutive → process might be stuck, kill + resume session
    if (consecutiveTimeouts >= 3) {
      log.error('MCP appears stuck, full respawn with new session');
      consecutiveTimeouts = 0;
      killProcess();
      buildSpawnArgs(false);
      spawnProcess();
    } else if (consecutiveTimeouts >= 2) {
      log.error({ consecutiveTimeouts }, 'Multiple consecutive timeouts, force respawning');
      consecutiveTimeouts = 0;
      killProcess();
      sessionStartedFlag = true;
      buildSpawnArgs(true);
      spawnProcess();
    }
  }, config.cliTimeout);

  // Write message to stdin (guard against process dying between check and write)
  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: msg.content },
  }) + '\n';

  if (!proc || !proc.stdin.writable) {
    log.warn({ id: msg.id }, 'Process died before stdin write, re-queuing');
    pendingQueue.unshift(msg);
    currentMessage = null;
    clearTimeout(msg.timeout);
    return;
  }

  const ok = proc.stdin.write(payload);
  if (!ok) {
    log.debug('stdin backpressure, waiting for drain');
    proc.stdin.once('drain', () => {
      log.debug('stdin drained');
    });
  }

  log.info({ id: msg.id, payloadLen: payload.length }, 'Sent message to persistent process');
}

function handleRespawn() {
  // Prevent double respawn from concurrent triggers (close + error + health check)
  if (respawning) {
    log.debug('Respawn already in progress, skipping');
    return;
  }

  if (respawnAttempts >= MAX_RESPAWN_ATTEMPTS) {
    log.error({ attempts: respawnAttempts }, 'Max respawn attempts reached, rejecting all pending');
    rejectAllPending(new Error('Persistent process failed after max respawn attempts'));
    return;
  }

  respawning = true;
  respawnAttempts++;
  const delayMs = Math.min(2000 * Math.pow(2, respawnAttempts - 1), 32_000);
  log.info({ attempt: respawnAttempts, delayMs }, 'Scheduling respawn');

  setTimeout(() => {
    respawning = false;
    // Use --resume if session was already started
    if (sessionStartedFlag) {
      buildSpawnArgs(true);
    }
    spawnProcess();
  }, delayMs);
}

export function respawnForCompression(newSessionId, newSysPrompt) {
  log.info({ newSessionId: newSessionId.slice(0, 8) }, 'Respawning for session compression');
  sessionId = newSessionId;
  systemPrompt = newSysPrompt;
  sessionStartedFlag = false; // new session, use --session-id
  respawnAttempts = 0;
  respawning = false; // clear any pending respawn — compression takes priority
  messageCount = 0;
  consecutiveTimeouts = 0;
  buildSpawnArgs(false);
  killProcess();
  spawnProcess();
}

export function shutdownPersistentProcess() {
  log.info('Shutting down persistent process');
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  killProcess();
  rejectAllPending(new Error('Persistent process shutdown'));
}

export function getPersistentProcessStats() {
  return {
    alive: !!proc,
    queueDepth: pendingQueue.length,
    currentMessageId: currentMessage?.id || null,
    respawnAttempts,
    idleMs: Date.now() - lastActivity,
    messageCount,
    sessionStarted: sessionStartedFlag,
  };
}

// --- Helpers ---

function killProcess() {
  if (!proc) return;
  try {
    proc.stdin.end();
    proc.kill();
  } catch (err) {
    log.debug({ err: err.message }, 'Error killing persistent process');
  }
  proc = null;
  isReady = false;
}

function rejectAllPending(err) {
  for (const msg of pendingQueue) {
    msg.reject(err);
  }
  pendingQueue = [];
  if (currentMessage) {
    clearTimeout(currentMessage.timeout);
    currentMessage.reject(err);
    currentMessage = null;
  }
}
