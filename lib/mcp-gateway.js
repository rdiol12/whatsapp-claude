import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { createLogger } from './logger.js';
import { notify } from './notify.js';
import config from './config.js';

const log = createLogger('mcp-gateway');

const TOOL_TIMEOUT = config.mcpToolTimeout;
const SEARCH_TIMEOUT = config.mcpSearchTimeout;
const HEALTH_CHECK_INTERVAL = config.mcpHealthCheckInterval;
const MAX_RECONNECT_DELAY = config.mcpReconnectDelay;

// Servers to skip — connecting to our own MCP server would be circular
const SKIP_SERVERS = new Set(['bot-ops']);

// ── ServerConnection class ──────────────────────────────────────────────────

class ServerConnection {
  constructor(name, serverConfig) {
    this.name = name;
    this.serverConfig = serverConfig; // { command, args, env }
    this.client = null;
    this.transport = null;
    this.connected = false;
    this.reconnecting = false;
    this.consecutiveFailures = 0;
    this.healthCheckTimer = null;
    this.closing = false;
    this.offlineUntil = 0;
  }

  async connect() {
    if (this.reconnecting) return;
    this.reconnecting = true;

    try {
      if (this.client) {
        try { await this.client.close(); } catch {}
        this.client = null;
        this.transport = null;
        this.connected = false;
      }

      // Resolve command — bare names check node_modules/.bin (e.g. "qmd" → "qmd.cmd")
      let command = this.serverConfig.command;
      const args = [...(this.serverConfig.args || [])];

      if (!command.includes('/') && !command.includes('\\')) {
        const binName = process.platform === 'win32' ? `${command}.cmd` : command;
        const binPath = join(process.cwd(), 'node_modules', '.bin', binName);
        if (existsSync(binPath)) command = binPath;
      }

      const transportOpts = { command, args, stderr: 'pipe' };
      if (this.serverConfig.env) {
        transportOpts.env = { ...process.env, ...this.serverConfig.env };
      }
      this.transport = new StdioClientTransport(transportOpts);

      this.client = new Client(
        { name: 'sela', version: '1.0.0' },
        { capabilities: {} },
      );

      this.client.onclose = () => {
        log.warn({ server: this.name }, 'MCP connection closed');
        this.connected = false;
      };

      this.client.onerror = (err) => {
        log.warn({ server: this.name, err: err?.message || String(err) }, 'MCP client error');
      };

      await this.client.connect(this.transport);
      this.connected = true;

      // Route stderr through logger
      const stderrStream = this.transport.stderr;
      if (stderrStream) {
        let buf = '';
        stderrStream.on('data', (chunk) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.includes('Dashboard')) continue;
            if (trimmed.includes('ERROR')) log.error({ server: this.name, stderr: trimmed }, 'MCP stderr');
            else log.debug({ server: this.name, stderr: trimmed }, 'MCP stderr');
          }
        });
      }

      log.info({ server: this.name }, `Connected to MCP server: ${this.name}`);
    } finally {
      this.reconnecting = false;
    }
  }

  async ensureConnected() {
    if (this.connected && this.client) return;

    if (Date.now() < this.offlineUntil) {
      throw new Error(`${this.name} MCP circuit breaker open (retry in ${Math.ceil((this.offlineUntil - Date.now()) / 1000)}s)`);
    }

    await this.reconnectWithBackoff();
  }

  async reconnectWithBackoff() {
    if (this.closing) return;
    const delay = Math.min(1000 * Math.pow(2, this.consecutiveFailures), MAX_RECONNECT_DELAY);
    if (this.consecutiveFailures > 0) {
      log.info({ server: this.name, delay, attempt: this.consecutiveFailures + 1 }, 'Reconnecting (backoff)');
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      await this.connect();
      if (this.consecutiveFailures >= 3) {
        notify(`${this.name} MCP reconnected after ${this.consecutiveFailures} failures.`);
      }
      this.consecutiveFailures = 0;
      this.offlineUntil = 0;
    } catch (err) {
      this.consecutiveFailures++;
      this.offlineUntil = Date.now() + 60_000;
      if (this.consecutiveFailures === 3) {
        notify(`ALERT: ${this.name} MCP down — ${this.consecutiveFailures} consecutive failures. ${err.message}`);
      }
      throw err;
    }
  }

  async callTool(toolName, args = {}, timeout = TOOL_TIMEOUT) {
    await this.ensureConnected();
    const argsPreview = JSON.stringify(args).slice(0, 200);
    log.info({ server: this.name, tool: toolName, args: argsPreview }, 'MCP_CALL');
    const start = Date.now();
    try {
      const result = await Promise.race([
        this.client.callTool({ name: toolName, arguments: args }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${this.name} ${toolName} timeout (${timeout}ms)`)), timeout),
        ),
      ]);
      const text = extractText(result);
      log.info({ server: this.name, tool: toolName, latencyMs: Date.now() - start, resultLen: text.length, preview: text.slice(0, 150) }, 'MCP_CALL OK');
      this.consecutiveFailures = 0;
      return text;
    } catch (err) {
      log.warn({ server: this.name, tool: toolName, err: err.message, latencyMs: Date.now() - start, args: argsPreview }, 'MCP_CALL FAILED');
      if (err.message?.includes('closed') || err.message?.includes('timeout') || err.message?.includes('EPIPE')) {
        this.connected = false;
        this.consecutiveFailures++;
      }
      throw err;
    }
  }

  startHealthCheck(toolName = 'health_check') {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(async () => {
      if (!this.connected || this.closing) return;
      try {
        await Promise.race([
          this.client.callTool({ name: toolName, arguments: {} }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('health check timeout')), 5000)),
        ]);
      } catch {
        log.warn({ server: this.name }, 'Health check failed — marking disconnected');
        this.connected = false;
      }
    }, HEALTH_CHECK_INTERVAL);
    this.healthCheckTimer.unref();
  }

  async close() {
    this.closing = true;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.client) {
      try { await this.client.close(); } catch {}
      this.client = null;
      this.transport = null;
      this.connected = false;
      log.info({ server: this.name }, 'MCP connection closed');
    }
  }
}

// ── Server registry ─────────────────────────────────────────────────────────

const servers = new Map();
let serverConfigs = null;

function loadServerConfigs() {
  try {
    const raw = readFileSync(config.mcpConfigPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed.mcpServers || {};
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to read mcp-config.json');
    return {};
  }
}

function getServerConfigs() {
  if (!serverConfigs) serverConfigs = loadServerConfigs();
  return serverConfigs;
}

function getServer(name) {
  if (servers.has(name)) return servers.get(name);

  const configs = getServerConfigs();
  const cfg = configs[name];
  if (!cfg) throw new Error(`Unknown MCP server: ${name}`);
  if (SKIP_SERVERS.has(name)) throw new Error(`MCP server ${name} is skipped (circular)`);

  const conn = new ServerConnection(name, cfg);
  servers.set(name, conn);
  return conn;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractText(result) {
  if (!result?.content) return '';
  return result.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

// ── Vestige backward-compat ─────────────────────────────────────────────────

function getVestige() { return getServer('vestige'); }

export async function callVestigeTool(name, args = {}, timeout = TOOL_TIMEOUT) {
  return getVestige().callTool(name, args, timeout);
}

// ── Generic multi-server tool call ──────────────────────────────────────────

export async function callTool(serverName, toolName, args = {}, timeout = TOOL_TIMEOUT) {
  return getServer(serverName).callTool(toolName, args, timeout);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export async function init() {
  try {
    const vestige = getVestige();
    await vestige.connect();
    vestige.startHealthCheck();
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to connect to vestige-mcp at startup — bot will work without vestige');
  }
}

export function isConnected() {
  return servers.has('vestige') ? servers.get('vestige').connected : false;
}

export function getConnectionStats() {
  if (!servers.has('vestige')) return { connected: false, consecutiveFailures: 0 };
  const v = servers.get('vestige');
  return { connected: v.connected, consecutiveFailures: v.consecutiveFailures };
}

export function getAllConnectionStats() {
  const stats = {};
  for (const [name, conn] of servers) {
    stats[name] = { connected: conn.connected, consecutiveFailures: conn.consecutiveFailures };
  }
  return stats;
}

export async function close() {
  const promises = [];
  for (const [name, conn] of servers) {
    promises.push(conn.close().catch(err => {
      log.warn({ server: name, err: err.message }, 'Error closing MCP server');
    }));
  }
  await Promise.all(promises);
  servers.clear();
}

// ── Vestige search (with configurable TTL cache) ────────────────────────────

const searchCache = new Map();
const SEARCH_CACHE_TTL = config.mcpConnectionCacheTtl;

// Prune search cache every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of searchCache) {
    if (now - entry.ts > SEARCH_CACHE_TTL) searchCache.delete(key);
  }
}, 60_000).unref();

export async function searchMemories(query, opts = {}) {
  if (!query || !query.trim()) return '';

  // Cache key: normalized query (lowercase, collapsed whitespace, first 80 chars) + limit
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
  const cacheKey = `${normalized}:${opts.limit || 10}`;
  const cached = searchCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < SEARCH_CACHE_TTL) return cached.result;

  try {
    const result = await callVestigeTool('search', {
      query,
      limit: opts.limit || 10,
      detail_level: opts.detail_level || 'summary',
      min_similarity: opts.min_similarity ?? 0.5,
    }, SEARCH_TIMEOUT);
    searchCache.set(cacheKey, { result, ts: Date.now() });
    return result;
  } catch {
    return '';
  }
}

// --- Memory write ---

export async function smartIngest(content, tags = [], nodeType = 'fact', source, { skipDedup = false } = {}) {
  // Pre-ingest dedup: check if a near-duplicate already exists in Vestige
  if (!skipDedup && content.length >= 20) {
    try {
      const dupCheck = await Promise.race([
        callVestigeTool('search', {
          query: content,
          limit: 3,
          detail_level: 'summary',
          min_similarity: 0.85,
        }, SEARCH_TIMEOUT),
        new Promise((_, reject) => setTimeout(() => reject(new Error('dedup timeout')), 3000)),
      ]);
      if (dupCheck && dupCheck.trim().length > 10) {
        log.info({ contentPreview: content.slice(0, 80) }, 'DEDUP: Skipping ingest — near-duplicate exists');
        return `[dedup] Near-duplicate exists, skipping ingest`;
      }
    } catch {
      // Dedup check failed or timed out — proceed with ingest normally
    }
  }

  const args = { content, node_type: nodeType };
  if (tags.length > 0) args.tags = tags;
  if (source) args.source = source;
  return callVestigeTool('smart_ingest', args);
}

export async function ingestMemory(content, tags = [], nodeType = 'fact', source) {
  const args = { content, node_type: nodeType };
  if (tags.length > 0) args.tags = tags;
  if (source) args.source = source;
  return callVestigeTool('ingest', args);
}

export async function sessionCheckpoint(items) {
  return callVestigeTool('session_checkpoint', { items });
}

// --- Memory management ---

export async function getMemory(id) {
  return callVestigeTool('memory', { action: 'get', id });
}

export async function deleteMemory(id) {
  return callVestigeTool('memory', { action: 'delete', id });
}

export async function getMemoryState(id) {
  return callVestigeTool('memory', { action: 'state', id });
}

export async function promoteMemory(id, reason) {
  const args = { id };
  if (reason) args.reason = reason;
  return callVestigeTool('promote_memory', args);
}

export async function demoteMemory(id, reason) {
  const args = { id };
  if (reason) args.reason = reason;
  return callVestigeTool('demote_memory', args);
}

// --- Intentions ---

export async function setIntention(description, trigger = {}, priority = 'normal', deadline) {
  const args = { action: 'set', description, priority };
  if (trigger && Object.keys(trigger).length > 0) args.trigger = trigger;
  if (deadline) args.deadline = deadline;
  return callVestigeTool('intention', args);
}

export async function checkIntentions(context = {}) {
  try {
    return await callVestigeTool('intention', { action: 'check', context }, SEARCH_TIMEOUT);
  } catch {
    return '';
  }
}

export async function listIntentions(filterStatus = 'active', limit = 20) {
  try {
    return await callVestigeTool('intention', { action: 'list', filter_status: filterStatus, limit }, SEARCH_TIMEOUT);
  } catch {
    return '';
  }
}

export async function updateIntention(id, status, snoozeMinutes) {
  const args = { action: 'update', id, status };
  if (status === 'snooze' && snoozeMinutes) args.snooze_minutes = snoozeMinutes;
  return callVestigeTool('intention', args);
}

// --- Browse & timeline ---

export async function memoryTimeline(opts = {}) {
  try {
    return await callVestigeTool('memory_timeline', {
      detail_level: opts.detail_level || 'summary',
      limit: opts.limit || 50,
      ...(opts.start && { start: opts.start }),
      ...(opts.end && { end: opts.end }),
      ...(opts.node_type && { node_type: opts.node_type }),
      ...(opts.tags && { tags: opts.tags }),
    });
  } catch {
    return '';
  }
}

export async function memoryChangelog(opts = {}) {
  try {
    return await callVestigeTool('memory_changelog', {
      limit: opts.limit || 20,
      ...(opts.memory_id && { memory_id: opts.memory_id }),
      ...(opts.start && { start: opts.start }),
      ...(opts.end && { end: opts.end }),
    });
  } catch {
    return '';
  }
}

// --- Codebase ---

export async function rememberPattern(codebase, name, description, files) {
  const args = { action: 'remember_pattern', codebase, name, description };
  if (files) args.files = files;
  return callVestigeTool('codebase', args);
}

export async function rememberDecision(codebase, decision, rationale, alternatives, files) {
  const args = { action: 'remember_decision', codebase, decision, rationale };
  if (alternatives) args.alternatives = alternatives;
  if (files) args.files = files;
  return callVestigeTool('codebase', args);
}

export async function getCodebaseContext(codebase, limit = 10) {
  try {
    return await callVestigeTool('codebase', { action: 'get_context', codebase, limit });
  } catch {
    return '';
  }
}

// --- System / admin ---

export async function getVestigeStats() {
  try {
    return await callVestigeTool('stats', {});
  } catch {
    return null;
  }
}

export async function healthCheck() {
  try {
    return await callVestigeTool('health_check', {});
  } catch {
    return null;
  }
}

export async function consolidate() {
  return callVestigeTool('consolidate', {}, 30_000); // 30s timeout
}

export async function backupMemories() {
  return callVestigeTool('backup', {});
}

export async function exportMemories(opts = {}) {
  return callVestigeTool('export', {
    format: opts.format || 'json',
    ...(opts.path && { path: opts.path }),
    ...(opts.since && { since: opts.since }),
    ...(opts.tags && { tags: opts.tags }),
  });
}

export async function garbageCollect(dryRun = true, minRetention = 0.1, maxAgeDays) {
  const args = { dry_run: dryRun, min_retention: minRetention };
  if (maxAgeDays) args.max_age_days = maxAgeDays;
  return callVestigeTool('gc', args);
}

export async function findDuplicates(threshold = 0.8, limit = 20) {
  return callVestigeTool('find_duplicates', { similarity_threshold: threshold, limit });
}

export async function importanceScore(content, project, contextTopics) {
  const args = { content };
  if (project) args.project = project;
  if (contextTopics) args.context_topics = contextTopics;
  return callVestigeTool('importance_score', args);
}

// ── QMD convenience exports ─────────────────────────────────────────────────

const qmdCache = new Map();
const QMD_CACHE_TTL = SEARCH_CACHE_TTL;

// Prune QMD cache alongside Vestige cache
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of qmdCache) {
    if (now - entry.ts > QMD_CACHE_TTL) qmdCache.delete(key);
  }
}, 60_000).unref();

export async function qmdSearch(query, opts = {}) {
  if (!query?.trim()) return '';

  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
  const cacheKey = `search:${normalized}:${opts.limit || 10}`;
  const cached = qmdCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < QMD_CACHE_TTL) return cached.result;

  try {
    const result = await callTool('qmd', 'search', {
      query,
      limit: opts.limit || 10,
      minScore: opts.minScore ?? 0,
      ...(opts.collection && { collection: opts.collection }),
    }, SEARCH_TIMEOUT);
    qmdCache.set(cacheKey, { result, ts: Date.now() });
    return result;
  } catch {
    return '';
  }
}

export async function qmdQuery(query, opts = {}) {
  if (!query?.trim()) return '';

  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
  const cacheKey = `deep:${normalized}:${opts.limit || 10}`;
  const cached = qmdCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < QMD_CACHE_TTL) return cached.result;

  try {
    const result = await callTool('qmd', 'deep_search', {
      query,
      limit: opts.limit || 10,
      minScore: opts.minScore ?? 0,
      ...(opts.collection && { collection: opts.collection }),
    }, 15_000); // deep_search uses query expansion + reranking
    qmdCache.set(cacheKey, { result, ts: Date.now() });
    return result;
  } catch {
    return '';
  }
}

export async function qmdGet(file, opts = {}) {
  try {
    return await callTool('qmd', 'get', {
      file,
      ...(opts.fromLine && { fromLine: opts.fromLine }),
      ...(opts.maxLines && { maxLines: opts.maxLines }),
      lineNumbers: opts.lineNumbers ?? true,
    });
  } catch {
    return '';
  }
}
