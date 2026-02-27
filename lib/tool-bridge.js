/**
 * Tool Bridge — Registry of callable tools with uniform interface.
 *
 * Each tool: { name, description, execute(params) → result }
 * Built-in tools: file read/write (sandboxed), shell exec (sandboxed).
 * Rate limiting per tool. Results stored in state.js for agent-loop pickup.
 *
 * Skill companions in skills/ register themselves via registerTool().
 * Agent invokes tools via <tool_call name="...">params</tool_call> XML tags
 * or [TOOL_CALL: name | params_json] text markers.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync, lstatSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { createLogger } from './logger.js';
import { classifyError } from './resilience.js';
import { getState, setState } from './state.js';
import config from './config.js';

const log = createLogger('tool-bridge');

// --- Tool Registry ---

const tools = new Map();
const rateLimits = new Map(); // name → { lastCall, minIntervalMs }

const STATE_KEY = 'tool-bridge';
const RESULTS_DIR = join(config.dataDir, 'tool-results');
try { mkdirSync(RESULTS_DIR, { recursive: true }); } catch {}

/**
 * Register a callable tool.
 * @param {object} tool - { name, description, execute(params) → Promise<result> }
 * @param {object} opts - { rateLimit: ms between calls (default 0) }
 */
export function registerTool(tool, opts = {}) {
  if (!tool.name || !tool.execute) {
    throw new Error(`Tool registration requires name and execute: ${JSON.stringify(tool)}`);
  }
  tools.set(tool.name, tool);
  if (opts.rateLimit) {
    rateLimits.set(tool.name, { minIntervalMs: opts.rateLimit, lastCall: 0 });
  }
  log.info({ name: tool.name, rateLimit: opts.rateLimit || 0 }, 'Tool registered');
}

/**
 * Unregister a tool by name.
 */
export function unregisterTool(name) {
  tools.delete(name);
  rateLimits.delete(name);
}

/**
 * List all registered tools (for prompt injection).
 */
export function listTools() {
  return Array.from(tools.values()).map(t => ({
    name: t.name,
    description: t.description,
  }));
}

/**
 * Get a tool by name.
 */
export function getTool(name) {
  return tools.get(name) || null;
}

/**
 * Execute a tool by name with params. Respects rate limits.
 * @param {string} name - Tool name
 * @param {object} params - Parameters for the tool
 * @returns {Promise<{ success: boolean, result?: any, error?: string }>}
 */
export async function executeTool(name, params = {}) {
  if (!config.toolBridgeEnabled) {
    return { success: false, error: 'Tool bridge is disabled' };
  }

  const tool = tools.get(name);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  // Rate limit check
  const limit = rateLimits.get(name);
  if (limit) {
    const elapsed = Date.now() - limit.lastCall;
    if (elapsed < limit.minIntervalMs) {
      const waitMs = limit.minIntervalMs - elapsed;
      return { success: false, error: `Rate limited — try again in ${Math.ceil(waitMs / 1000)}s` };
    }
  }

  const startMs = Date.now();
  try {
    if (limit) limit.lastCall = Date.now();
    const result = await tool.execute(params);
    const durationMs = Date.now() - startMs;

    // Store result in state for agent-loop pickup
    const state = getState(STATE_KEY);
    const results = state.recentResults || [];
    results.push({
      tool: name,
      params: JSON.stringify(params).slice(0, 500),
      success: true,
      resultPreview: JSON.stringify(result).slice(0, 1000),
      ts: Date.now(),
      durationMs,
    });
    // Keep last 20 results
    if (results.length > 20) results.splice(0, results.length - 20);
    setState(STATE_KEY, { recentResults: results });

    log.info({ tool: name, durationMs, resultLen: JSON.stringify(result).length }, 'Tool executed successfully');
    return { success: true, result };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    log.error({ tool: name, durationMs, err: err.message }, 'Tool execution failed');

    // Attempt smart recovery (timeout → longer timeout, rate limit → wait, etc.)
    try {
      const { attemptRecovery } = await import('./error-recovery.js');
      const recovery = await attemptRecovery(err, () => tool.execute(params), {
        source: 'tool-bridge',
        action: name,
        actionType: 'execute_tool',
      });

      if (recovery.recovered) {
        const recoveredMs = Date.now() - startMs;
        log.info({ tool: name, recoveredMs, attempts: recovery.attempts }, 'Tool recovered via error-recovery');

        // Store recovered result
        const state2 = getState(STATE_KEY);
        const results2 = state2.recentResults || [];
        results2.push({
          tool: name,
          params: JSON.stringify(params).slice(0, 500),
          success: true,
          resultPreview: JSON.stringify(recovery.result).slice(0, 1000),
          ts: Date.now(),
          durationMs: recoveredMs,
          recovered: true,
        });
        if (results2.length > 20) results2.splice(0, results2.length - 20);
        setState(STATE_KEY, { recentResults: results2 });

        return { success: true, result: recovery.result };
      }
    } catch (recoveryErr) {
      log.warn({ tool: name, err: recoveryErr.message }, 'Error-recovery itself failed');
    }

    // Store failure
    const state = getState(STATE_KEY);
    const results = state.recentResults || [];
    results.push({
      tool: name,
      params: JSON.stringify(params).slice(0, 500),
      success: false,
      error: err.message,
      ts: Date.now(),
      durationMs,
    });
    if (results.length > 20) results.splice(0, results.length - 20);
    setState(STATE_KEY, { recentResults: results });

    return { success: false, error: err.message };
  }
}

/**
 * Parse tool call from XML tag. Supports two formats:
 *   Format A (preferred): <tool_call name="toolName">{"param": "value"}</tool_call>
 *   Format B (HF/Llama):  <tool_call><function=toolName><parameter=key>value</parameter></function></tool_call>
 * Returns array of { name, params } objects.
 */
export function parseToolCalls(text) {
  const calls = [];

  // Format A: <tool_call name="toolName">{"param": "value"}</tool_call>
  for (const m of text.matchAll(/<tool_call\s+name="([^"]*)">([\s\S]*?)<\/tool_call>/g)) {
    const name = m[1].trim();
    let params = {};
    const raw = m[2].trim();
    if (raw) {
      let parsed = false;
      // First attempt: parse as-is
      try { params = JSON.parse(raw); parsed = true; } catch {}
      // Second attempt: repair common NIM artifacts — trailing }" or stray quotes after closing brace
      if (!parsed) {
        try {
          const cleaned = raw.replace(/\}"?\s*$/, '}').replace(/,\s*\}/, '}');
          params = JSON.parse(cleaned);
          parsed = true;
          log.warn({ name, raw: raw.slice(0, 200) }, 'parseToolCalls: repaired malformed JSON');
        } catch {}
      }
      // Last resort: store raw input so tool can return a descriptive error
      if (!parsed) {
        params = { _malformed: true, input: raw.slice(0, 500) };
        log.warn({ name, raw: raw.slice(0, 200) }, 'parseToolCalls: JSON parse failed — using _malformed fallback');
      }
    }
    calls.push({ name, params });
  }

  // Format B: <tool_call><function=toolName><parameter=key>value</parameter>...</function></tool_call>
  // Only if Format A found nothing (avoid double-parsing)
  if (calls.length === 0) {
    for (const m of text.matchAll(/<tool_call>\s*<function=([^>]*)>([\s\S]*?)<\/function>\s*<\/tool_call>/g)) {
      const name = m[1].trim();
      const body = m[2];
      const params = {};
      for (const p of body.matchAll(/<parameter=([^>]*)>([\s\S]*?)<\/parameter>/g)) {
        params[p[1].trim()] = p[2].trim();
      }
      calls.push({ name, params });
    }
  }

  return calls;
}

/**
 * Parse tool call from text marker: [TOOL_CALL: name | params_json]
 * Returns array of { name, params } objects.
 */
export function parseToolCallMarkers(text) {
  const calls = [];
  for (const m of text.matchAll(/\[TOOL_CALL:\s*(\S+)\s*\|\s*([\s\S]*?)\]/g)) {
    const name = m[1].trim();
    let params = {};
    try {
      params = JSON.parse(m[2].trim());
    } catch {
      params = { input: m[2].trim() };
    }
    calls.push({ name, params });
  }
  return calls;
}

/**
 * Execute all tool calls found in text (both XML and marker formats).
 * Returns array of { name, params, result } objects.
 */
export async function executeToolCallsFromText(text) {
  const xmlCalls = parseToolCalls(text);
  const markerCalls = parseToolCallMarkers(text);
  const allCalls = [...xmlCalls, ...markerCalls];

  const results = [];
  for (const call of allCalls) {
    const result = await executeTool(call.name, call.params);
    results.push({ name: call.name, params: call.params, ...result });
  }
  return results;
}

// --- Built-in Tools ---

// Note: http_fetch removed — Claude's built-in WebFetch is superior.
// Kept: file_read, file_write, shell_exec — these add sandboxing for agent-loop autonomy.

// 1. File Read (sandboxed to ~/sela/)
registerTool({
  name: 'file_read',
  description: 'Read a file from the sela directory. Returns { content, size }.',
  async execute(params) {
    const filePath = params.path || params.file_path;
    // Return clean error instead of throwing — prevents cascade through error-recovery retries
    if (!filePath) return { content: null, exists: false, error: 'path is required — provide { path: "relative/path/to/file" }' };

    // Sandbox: resolve relative to ~/sela/ — canonicalize to prevent traversal/symlink attacks
    const selaRoot = resolve(config.dataDir, '..');
    const resolved = resolve(selaRoot, filePath);
    if (!resolved.startsWith(selaRoot + (resolved === selaRoot ? '' : require('path').sep))) {
      throw new Error('Access denied');
    }

    // Existence check — prevents ENOENT errors cascading through error-recovery
    if (!existsSync(resolved)) {
      return { content: null, exists: false, error: `File not found: ${filePath}` };
    }
    // Verify real path after symlink resolution
    try {
      const real = realpathSync(resolved);
      if (!real.startsWith(selaRoot)) {
        throw new Error('Access denied');
      }
    } catch (e) {
      if (e.message === 'Access denied') throw e;
      // realpathSync may fail on broken symlinks — treat as not found
      return { content: null, exists: false, error: `File not found: ${filePath}` };
    }
    const content = readFileSync(resolved, 'utf-8');
    return { content: content.slice(0, 50000), size: content.length, exists: true };
  },
});

// 3. File Write (sandboxed to ~/sela/workspace/)
registerTool({
  name: 'file_write',
  description: 'Write a file to the sela workspace directory. Returns { written, path }.',
  async execute(params) {
    const filePath = params.path || params.file_path;
    const content = params.content;
    // Return clean error — prevents cascade through error-recovery retries (same pattern as file_read)
    if (!filePath || content === undefined) return { written: false, exists: false, error: `path and content are required — provide { path: "relative/path", content: "..." }${params._malformed ? ' (JSON was malformed)' : ''}` };

    // Strip leading "workspace/" prefix — consistent with resolveFilePath in whatsapp.js
    // Prevents double-prefix bug: Claude often passes "workspace/file" which would otherwise
    // resolve to workspaceDir/workspace/file instead of workspaceDir/file
    const normalized = filePath.replace(/^workspace[/\\]/i, '');
    const resolved = resolve(config.workspaceDir, normalized);
    if (!resolved.startsWith(config.workspaceDir + require('path').sep) && resolved !== config.workspaceDir) {
      throw new Error('Access denied');
    }

    mkdirSync(join(resolved, '..'), { recursive: true });
    writeFileSync(resolved, content, 'utf-8');
    return { written: true, path: resolved, size: content.length };
  },
});

// 4. Shell Exec (sandboxed, timeout, no destructive commands)
registerTool({
  name: 'shell_exec',
  description: 'Execute a shell command (sandboxed, 30s timeout). Returns { stdout, exitCode }.',
  async execute(params) {
    const { command, cwd = config.workspaceDir, timeout = 30000 } = params;
    // Return clean error — prevents cascade through error-recovery retries
    if (!command) return { stdout: '', exitCode: 1, error: `command is required — provide { command: "..." }${params._malformed ? ' (JSON was malformed)' : ''}` };

    // Block destructive commands and shell injection patterns
    const blocked = /\b(rm\s+-rf|rmdir\s+\/|del\s+\/|format\b|mkfs\b|dd\s+if|shutdown|reboot|kill\s+-9|killall|pkill|taskkill)\b/i;
    if (blocked.test(command)) {
      throw new Error('Blocked: destructive command not allowed');
    }
    // Block shell metacharacter injection (pipes, semicolons, backtick subshells)
    // Allow: &&, ||, >, >> (needed for normal shell usage) but block backticks and $()
    if (/[`]|\$\(/.test(command)) {
      throw new Error('Blocked: shell injection pattern detected');
    }

    try {
      const stdout = execSync(command, {
        timeout,
        encoding: 'utf-8',
        shell: true,
        cwd,
        maxBuffer: 1024 * 1024,
      });
      return { stdout: stdout.slice(0, 10000), exitCode: 0 };
    } catch (err) {
      return {
        stdout: (err.stdout || '').slice(0, 5000),
        stderr: (err.stderr || '').slice(0, 5000),
        exitCode: err.status || 1,
      };
    }
  },
}, { rateLimit: 2000 });

/**
 * Load skill companion tools from skills/ directory.
 * Skill companions export: { name, description, execute(params) }
 */
export async function loadSkillCompanions() {
  const skillsDir = join(config.dataDir, '..', 'skills');
  // Reject symlinked skills directory (supply-chain attack vector)
  try {
    if (lstatSync(skillsDir).isSymbolicLink()) {
      log.warn('Skills directory is a symlink — skipping for security');
      return;
    }
  } catch { return; }
  const jsFiles = readdirSync(skillsDir).filter(f => f.endsWith('.js'));

  for (const file of jsFiles) {
    const fullPath = join(skillsDir, file);
    // Reject symlinked skill files
    try {
      if (lstatSync(fullPath).isSymbolicLink()) {
        log.warn({ file }, 'Skill file is a symlink — skipping');
        continue;
      }
    } catch { continue; }
    try {
      const mod = await import(`file://${fullPath.replace(/\\/g, '/')}`);
      if (mod.tools && Array.isArray(mod.tools)) {
        for (const tool of mod.tools) {
          registerTool(tool, { rateLimit: tool.rateLimit || 2000 });
        }
        log.info({ file, toolCount: mod.tools.length }, 'Loaded skill companion tools');
      }
    } catch (err) {
      log.warn({ file, err: err.message }, 'Failed to load skill companion');
    }
  }
}

/**
 * Get recent tool execution results.
 */
export function getRecentResults(limit = 10) {
  const state = getState(STATE_KEY);
  return (state.recentResults || []).slice(-limit);
}
