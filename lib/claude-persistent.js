import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { createLogger } from './logger.js';

const MCP_CONFIG = config.mcpConfigPath;

// Resolve claude CLI entry point (bypass shell to avoid Windows 8K cmd line limit)
const CLAUDE_CLI_JS = join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
if (!existsSync(CLAUDE_CLI_JS)) {
  createLogger('claude-persistent').error({ path: CLAUDE_CLI_JS }, 'Claude CLI entry point not found');
}

const MAX_RESPAWN_ATTEMPTS = 5;

// ─── PersistentProcess class ────────────────────────────────────────────────

export class PersistentProcess {
  /**
   * @param {string} name - identifier for logging ('wa' | 'agent')
   * @param {string} sessionId
   * @param {string} systemPrompt
   * @param {{ model?: string, extraArgs?: string[], timeout?: number, activityTimeout?: number, cacheKeepAlive?: boolean }} opts
   */
  constructor(name, sessionId, systemPrompt, opts = {}) {
    this.name = name;
    this.log = createLogger(`claude-persistent:${name}`);
    this.model = opts.model || config.claudeModel;
    this.timeout = opts.timeout || config.cliTimeout;
    this.activityTimeout = opts.activityTimeout || config.cliActivityTimeout;
    this.cacheKeepAlive = opts.cacheKeepAlive ?? (config.cacheKeepAlive && config.persistentMode);

    // Process state
    this.proc = null;
    this.lineBuffer = '';
    this.fullText = '';
    this.resultEvent = null;
    this.currentMessage = null;
    this.pendingQueue = [];
    this.isReady = false;
    this.respawnAttempts = 0;
    this.lastActivity = Date.now();
    this.sessionId = sessionId;
    this.systemPrompt = systemPrompt;
    this.spawnArgs = [];
    this.sessionStartedFlag = false;
    this.messageCount = 0;
    this.consecutiveTimeouts = 0;
    this.respawning = false;
    this.keepAliveTimer = null;
    this.lastApiCall = Date.now();

    this._buildSpawnArgs(false, opts.extraArgs || []);
    this._spawnProcess();

    this.log.info({ sessionId: sessionId.slice(0, 8), model: this.model }, 'Persistent process initialized');
  }

  // ─── Spawn Args ───────────────────────────────────────────────────────────

  _buildSpawnArgs(isResume, extraArgs = []) {
    const addDir = config.projectRoot.replace(/\\/g, '/');
    const base = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', this.model,
      '--mcp-config', MCP_CONFIG,
      '--permission-mode', 'bypassPermissions',
      '--add-dir', addDir,
    ];

    if (isResume && this.sessionStartedFlag) {
      this.spawnArgs = [...base, '--resume', this.sessionId, ...extraArgs];
    } else {
      this.spawnArgs = [...base, '--session-id', this.sessionId, '--system-prompt', this.systemPrompt, ...extraArgs];
    }
  }

  // ─── Process Lifecycle ────────────────────────────────────────────────────

  _spawnProcess() {
    this._killProcess();

    this.log.info({ args: this.spawnArgs.join(' ').slice(0, 200), attempt: this.respawnAttempts }, 'Spawning persistent Claude process');

    const childEnv = { ...process.env };
    delete childEnv.CLAUDECODE;

    this.proc = spawn(process.execPath, [CLAUDE_CLI_JS, ...this.spawnArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      windowsHide: true,
    });

    this.lineBuffer = '';
    this.fullText = '';
    this.resultEvent = null;

    this.proc.stdout.on('data', (chunk) => this._handleStdout(chunk));

    this.proc.stderr.on('data', (d) => {
      const msg = d.toString();
      if (/mcp|connection|error|fatal|crash/i.test(msg)) {
        this.log.warn({ stderr: msg.slice(0, 300) }, 'Persistent process stderr (notable)');
      } else {
        this.log.debug({ stderr: msg.slice(0, 200) }, 'Persistent process stderr');
      }
    });

    this.proc.on('close', (code) => {
      this.log.warn({ code }, 'Persistent process exited');
      this.proc = null;
      this.isReady = false;

      if (this.currentMessage) {
        this.currentMessage.reject(new Error(`Persistent process exited (code ${code}) during message ${this.currentMessage.id}`));
        clearTimeout(this.currentMessage.timeout);
        clearInterval(this.currentMessage.activityCheck);
        this.currentMessage = null;
      }

      this._handleRespawn();
    });

    this.proc.on('error', (err) => {
      this.log.error({ err: err.message }, 'Persistent process error');
      this.proc = null;
      this.isReady = false;

      if (this.currentMessage) {
        this.currentMessage.reject(err);
        clearTimeout(this.currentMessage.timeout);
        clearInterval(this.currentMessage.activityCheck);
        this.currentMessage = null;
      }

      this._handleRespawn();
    });

    this.isReady = true;
    this.lastActivity = Date.now();

    this._drainQueue();
  }

  // ─── Stdout Parsing ───────────────────────────────────────────────────────

  _handleStdout(chunk) {
    this.lastActivity = Date.now();
    this.lineBuffer += chunk.toString();
    while (true) {
      const nlIdx = this.lineBuffer.indexOf('\n');
      if (nlIdx === -1) break;
      const line = this.lineBuffer.slice(0, nlIdx).trim();
      this.lineBuffer = this.lineBuffer.slice(nlIdx + 1);
      if (!line) continue;

      if (!this.currentMessage) continue;

      try {
        const event = JSON.parse(line);

        if (event.type === 'stream_event' &&
            event.event?.type === 'content_block_delta' &&
            event.event.delta?.type === 'text_delta') {
          if (this.currentMessage?.onTextDelta) this.currentMessage.onTextDelta(event.event.delta.text);
        }

        if (event.type === 'stream_event' &&
            event.event?.type === 'content_block_start' &&
            event.event.content_block?.type === 'tool_use') {
          const toolName = event.event.content_block.name;
          if (this.currentMessage?.onToolUse) this.currentMessage.onToolUse(toolName);
        }

        if (event.type === 'assistant' && !event.partial && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') this.fullText += block.text;
          }
        }

        if (event.type === 'result') {
          this.resultEvent = event;
          this._finishCurrentMessage();
        }
      } catch { /* skip non-JSON lines */ }
    }
  }

  _finishCurrentMessage() {
    if (!this.currentMessage) return;

    clearTimeout(this.currentMessage.timeout);
    clearInterval(this.currentMessage.activityCheck);
    this.lastActivity = Date.now();
    this.messageCount++;
    this.consecutiveTimeouts = 0;
    this.respawnAttempts = 0;
    this._resetKeepAliveTimer();

    const replyText = this.resultEvent?.result || this.fullText;

    if (this.resultEvent?.is_error) {
      const err = new Error(replyText || 'Claude returned error');
      err.isPermanent = true;
      this.currentMessage.reject(err);
    } else {
      const usage = this.resultEvent?.usage || {};
      this.currentMessage.resolve({
        text: replyText,
        durationMs: this.resultEvent?.duration_ms || 0,
        apiMs: this.resultEvent?.duration_api_ms || 0,
        costUsd: this.resultEvent?.total_cost_usd || 0,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
      });
    }

    this.currentMessage = null;
    if (!this.sessionStartedFlag) this.sessionStartedFlag = true;

    this._drainQueue();
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  send(content, onTextDelta, onToolUse) {
    return new Promise((resolve, reject) => {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      this.pendingQueue.push({ id, content, resolve, reject, onTextDelta, onToolUse });
      this.log.info({ id, queueDepth: this.pendingQueue.length }, 'Message queued for persistent process');
      this._drainQueue();
    });
  }

  shutdown() {
    this.log.info('Shutting down persistent process');
    if (this.keepAliveTimer) { clearTimeout(this.keepAliveTimer); this.keepAliveTimer = null; }
    this._killProcess();
    this._rejectAllPending(new Error('Persistent process shutdown'));
  }

  getStats() {
    return {
      name: this.name,
      alive: !!this.proc,
      queueDepth: this.pendingQueue.length,
      currentMessageId: this.currentMessage?.id || null,
      respawnAttempts: this.respawnAttempts,
      idleMs: Date.now() - this.lastActivity,
      messageCount: this.messageCount,
      sessionStarted: this.sessionStartedFlag,
      model: this.model,
    };
  }

  respawnForCompression(newSessionId, newSysPrompt) {
    this.log.info({ newSessionId: newSessionId.slice(0, 8) }, 'Respawning for session compression');
    this.sessionId = newSessionId;
    this.systemPrompt = newSysPrompt;
    this.sessionStartedFlag = false;
    this.respawnAttempts = 0;
    this.respawning = false;
    this.messageCount = 0;
    this.consecutiveTimeouts = 0;
    this._buildSpawnArgs(false);
    this._killProcess();
    this._spawnProcess();
  }

  // ─── Queue Management ─────────────────────────────────────────────────────

  _drainQueue() {
    // Proactive respawn after 500 messages to prevent heap growth
    if (this.messageCount > 500 && !this.currentMessage && this.pendingQueue.length === 0 && !this.respawning && this.proc) {
      this.log.info({ messageCount: this.messageCount }, 'Proactive respawn after 500 messages');
      this.messageCount = 0;
      this._killProcess();
      this.sessionStartedFlag = true;
      this._buildSpawnArgs(true);
      this._spawnProcess();
      return;
    }

    if (!this.isReady || !this.proc || this.currentMessage || this.pendingQueue.length === 0) return;

    const msg = this.pendingQueue.shift();
    this.currentMessage = msg;

    this.fullText = '';
    this.resultEvent = null;

    // Per-message absolute timeout
    msg.timeout = setTimeout(() => {
      clearInterval(msg.activityCheck);
      this.consecutiveTimeouts++;
      this.log.warn({ id: msg.id, consecutiveTimeouts: this.consecutiveTimeouts }, 'Persistent process message timeout');

      msg.reject(new Error(`Persistent process message timeout (${this.timeout / 1000}s)`));
      this.currentMessage = null;

      if (this.consecutiveTimeouts >= 3) {
        this.log.error('MCP appears stuck, full respawn with new session');
        this.consecutiveTimeouts = 0;
        this._killProcess();
        this._buildSpawnArgs(false);
        this._spawnProcess();
      } else if (this.consecutiveTimeouts >= 2) {
        this.log.error({ consecutiveTimeouts: this.consecutiveTimeouts }, 'Multiple consecutive timeouts, force respawning');
        this.consecutiveTimeouts = 0;
        this._killProcess();
        this.sessionStartedFlag = true;
        this._buildSpawnArgs(true);
        this._spawnProcess();
      }
    }, this.timeout);

    // Per-message activity timeout
    this.lastActivity = Date.now();
    msg.activityCheck = setInterval(() => {
      if (!this.currentMessage || this.currentMessage.id !== msg.id) {
        clearInterval(msg.activityCheck);
        return;
      }
      const idleMs = Date.now() - this.lastActivity;
      if (idleMs > this.activityTimeout) {
        clearInterval(msg.activityCheck);
        clearTimeout(msg.timeout);
        this.consecutiveTimeouts++;
        this.log.error({ id: msg.id, idleMs, activityTimeout: this.activityTimeout / 1000, consecutiveTimeouts: this.consecutiveTimeouts }, 'Persistent process inactivity timeout');

        msg.reject(new Error(`Persistent process inactivity timeout (no output for ${this.activityTimeout / 1000}s)`));
        this.currentMessage = null;

        if (this.consecutiveTimeouts >= 3) {
          this.log.error('Inactivity: MCP appears stuck, full respawn with new session');
          this.consecutiveTimeouts = 0;
          this._killProcess();
          this._buildSpawnArgs(false);
          this._spawnProcess();
        } else if (this.consecutiveTimeouts >= 2) {
          this.log.error({ consecutiveTimeouts: this.consecutiveTimeouts }, 'Inactivity: force respawning');
          this.consecutiveTimeouts = 0;
          this._killProcess();
          this.sessionStartedFlag = true;
          this._buildSpawnArgs(true);
          this._spawnProcess();
        }
      }
    }, 10_000);

    // Write message to stdin
    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: msg.content },
    }) + '\n';

    if (!this.proc || !this.proc.stdin.writable) {
      this.log.warn({ id: msg.id }, 'Process died before stdin write, re-queuing');
      this.pendingQueue.unshift(msg);
      this.currentMessage = null;
      clearTimeout(msg.timeout);
      return;
    }

    const ok = this.proc.stdin.write(payload);
    if (!ok) {
      this.log.debug('stdin backpressure, waiting for drain');
      this.proc.stdin.once('drain', () => { this.log.debug('stdin drained'); });
    }

    this.log.info({ id: msg.id, payloadLen: payload.length }, 'Sent message to persistent process');
  }

  // ─── Respawn ──────────────────────────────────────────────────────────────

  _handleRespawn() {
    if (this.respawning) {
      this.log.debug('Respawn already in progress, skipping');
      return;
    }

    if (this.respawnAttempts >= MAX_RESPAWN_ATTEMPTS) {
      this.log.error({ attempts: this.respawnAttempts }, 'Max respawn attempts reached, rejecting all pending');
      this._rejectAllPending(new Error('Persistent process failed after max respawn attempts'));
      return;
    }

    this.respawning = true;
    this.respawnAttempts++;
    const delayMs = Math.min(2000 * Math.pow(2, this.respawnAttempts - 1), 32_000);
    this.log.info({ attempt: this.respawnAttempts, delayMs }, 'Scheduling respawn');

    setTimeout(() => {
      this.respawning = false;
      if (this.sessionStartedFlag) {
        this._buildSpawnArgs(true);
      }
      this._spawnProcess();
    }, delayMs);
  }

  // ─── Cache Keep-Alive ─────────────────────────────────────────────────────

  _resetKeepAliveTimer() {
    this.lastApiCall = Date.now();
    if (!this.cacheKeepAlive) return;

    if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = setTimeout(() => {
      if (!this.proc || !this.isReady || !this.sessionStartedFlag || this.currentMessage || this.pendingQueue.length > 0) return;

      const ilHour = new Date(new Date().toLocaleString('en-US', { timeZone: config.timezone })).getHours();
      if (ilHour >= config.quietStart || ilHour < config.quietEnd) {
        this.log.debug({ ilHour }, 'Cache keep-alive: skipping (quiet hours)');
        return;
      }

      this.log.info({ idleSinceMs: Date.now() - this.lastApiCall }, 'Cache keep-alive: sending ping');
      this.send(
        '[system: cache-keepalive ping, respond with just "ok"]',
        () => {},
        () => {},
      ).then(() => {
        this.log.info('Cache keep-alive: pong received');
      }).catch(err => {
        this.log.warn({ err: err.message }, 'Cache keep-alive: ping failed');
      });
    }, config.cacheKeepAliveMs);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _killProcess() {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
      this.proc.kill();
    } catch (err) {
      this.log.debug({ err: err.message }, 'Error killing persistent process');
    }
    this.proc = null;
    this.isReady = false;
  }

  _rejectAllPending(err) {
    for (const msg of this.pendingQueue) {
      msg.reject(err);
    }
    this.pendingQueue = [];
    if (this.currentMessage) {
      clearTimeout(this.currentMessage.timeout);
      clearInterval(this.currentMessage.activityCheck);
      this.currentMessage.reject(err);
      this.currentMessage = null;
    }
  }
}

// ─── Legacy API (backwards-compatible wrappers for WhatsApp callers) ────────

let waInstance = null;

export function initPersistentProcess(sid, sysPrompt, extraArgs = []) {
  waInstance = new PersistentProcess('wa', sid, sysPrompt, { extraArgs });
}

export function sendToPersistentProcess(content, onTextDelta, onToolUse) {
  return waInstance.send(content, onTextDelta, onToolUse);
}

export function shutdownPersistentProcess() {
  waInstance?.shutdown();
}

export function getPersistentProcessStats() {
  return waInstance?.getStats() || {};
}

export function respawnForCompression(newSessionId, newSysPrompt) {
  waInstance?.respawnForCompression(newSessionId, newSysPrompt);
}
