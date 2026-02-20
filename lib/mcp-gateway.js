import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from './logger.js';
import { notify } from './notify.js';
import config from './config.js';

const log = createLogger('mcp-gateway');

const VESTIGE_PATH = join(homedir(), 'bin', 'vestige-mcp.exe');
const TOOL_TIMEOUT = config.mcpToolTimeout;
const SEARCH_TIMEOUT = config.mcpSearchTimeout;
const HEALTH_CHECK_INTERVAL = 5 * 60_000; // 5 min health check
const MAX_RECONNECT_DELAY = 60_000; // max 60s backoff

let client = null;
let transport = null;
let connected = false;
let reconnecting = false;
let consecutiveFailures = 0;
let healthCheckTimer = null;
let closing = false;

async function connect() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    // Clean up any existing connection
    if (client) {
      try { await client.close(); } catch {}
      client = null;
      transport = null;
      connected = false;
    }

    transport = new StdioClientTransport({
      command: VESTIGE_PATH,
      args: [],
      stderr: 'pipe',
    });

    client = new Client(
      { name: 'whatsapp-claude', version: '1.0.0' },
      { capabilities: {} },
    );

    client.onclose = () => {
      log.warn('vestige-mcp connection closed');
      connected = false;
    };

    client.onerror = (err) => {
      log.warn({ err: err?.message || String(err) }, 'vestige-mcp client error');
    };

    await client.connect(transport);
    connected = true;

    // Route vestige stderr through our logger (skip noisy dashboard warnings)
    const stderrStream = transport.stderr;
    if (stderrStream) {
      let stderrBuf = '';
      stderrStream.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.includes('Dashboard')) continue;
          if (trimmed.includes('ERROR')) log.error({ vestige: trimmed }, 'vestige-mcp stderr');
          else log.debug({ vestige: trimmed }, 'vestige-mcp stderr');
        }
      });
    }

    log.info('Connected to vestige-mcp');
  } finally {
    reconnecting = false;
  }
}

// Extract text content from an MCP tool result
function extractText(result) {
  if (!result?.content) return '';
  return result.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

async function ensureConnected() {
  if (!connected || !client) {
    await reconnectWithBackoff();
  }
}

async function reconnectWithBackoff() {
  if (closing) return;
  const delay = Math.min(1000 * Math.pow(2, consecutiveFailures), MAX_RECONNECT_DELAY);
  if (consecutiveFailures > 0) {
    log.info({ delay, attempt: consecutiveFailures + 1 }, 'Reconnecting to vestige-mcp (backoff)');
    await new Promise(r => setTimeout(r, delay));
  }
  try {
    await connect();
    if (consecutiveFailures >= 3) {
      notify('Vestige MCP reconnected after ' + consecutiveFailures + ' failures.');
    }
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    if (consecutiveFailures === 3) {
      notify('ALERT: vestige-mcp down — ' + consecutiveFailures + ' consecutive failures. ' + err.message);
    }
    throw err;
  }
}

function startHealthCheck() {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(async () => {
    if (!connected || closing) return;
    try {
      await Promise.race([
        client.callTool({ name: 'health_check', arguments: {} }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('health check timeout')), 5000)),
      ]);
    } catch (err) {
      log.warn({ err: err.message }, 'Health check failed — marking disconnected');
      connected = false;
      // Auto-reconnect on next tool call
    }
  }, HEALTH_CHECK_INTERVAL);
  healthCheckTimer.unref();
}

// --- Generic tool caller ---

export async function callVestigeTool(name, args = {}, timeout = TOOL_TIMEOUT) {
  await ensureConnected();
  const argsPreview = JSON.stringify(args).slice(0, 200);
  log.info({ tool: name, args: argsPreview }, 'MCP_CALL: Calling vestige tool');
  const start = Date.now();
  try {
    const result = await Promise.race([
      client.callTool({ name, arguments: args }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`vestige ${name} timeout (${timeout}ms)`)), timeout),
      ),
    ]);
    const text = extractText(result);
    log.info({ tool: name, latencyMs: Date.now() - start, resultLen: text.length, preview: text.slice(0, 150) }, 'MCP_CALL: Vestige tool OK');
    consecutiveFailures = 0;
    return text;
  } catch (err) {
    log.warn({ tool: name, err: err.message, latencyMs: Date.now() - start, args: argsPreview }, 'MCP_CALL: Vestige tool FAILED');
    if (err.message?.includes('closed') || err.message?.includes('timeout') || err.message?.includes('EPIPE')) {
      connected = false;
      consecutiveFailures++;
    }
    throw err;
  }
}

// --- Lifecycle ---

export async function init() {
  try {
    await connect();
    startHealthCheck();
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to connect to vestige-mcp at startup — bot will work without vestige');
  }
}

export function isConnected() {
  return connected;
}

export function getConnectionStats() {
  return { connected, consecutiveFailures };
}

export async function close() {
  closing = true;
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    transport = null;
    connected = false;
    log.info('vestige-mcp connection closed');
  }
}

// --- Search (with 30s TTL cache) ---

const searchCache = new Map();
const SEARCH_CACHE_TTL = 30_000;

// Prune search cache every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of searchCache) {
    if (now - entry.ts > SEARCH_CACHE_TTL) searchCache.delete(key);
  }
}, 60_000).unref();

export async function searchMemories(query, opts = {}) {
  if (!query || !query.trim()) return '';

  // Cache key: normalized query + limit
  const cacheKey = `${query.trim().toLowerCase().slice(0, 200)}:${opts.limit || 10}`;
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

export async function smartIngest(content, tags = [], nodeType = 'fact', source) {
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
