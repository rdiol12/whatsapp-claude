/**
 * LLM Router — Unified pluggable backend for any OpenAI-compatible API.
 *
 * Replaces duplicated code in ollama-client.js and nim-client.js with a
 * single generic HTTP client + shared tool-use loop.
 *
 * ## Adding a backend (zero code)
 *
 * Set these env vars and restart:
 *
 *   LLM_<NAME>_ENABLED=true              (required — activates the backend)
 *   LLM_<NAME>_BASE_URL=https://...      (required — OpenAI-compatible base URL)
 *   LLM_<NAME>_MODEL=model-name          (required — default model ID)
 *   LLM_<NAME>_API_KEY=sk-...            (optional — Bearer token for auth)
 *   LLM_<NAME>_COST_INPUT=0.0001         (optional — USD per input token, default 0)
 *   LLM_<NAME>_COST_OUTPUT=0.0002        (optional — USD per output token, default 0)
 *   LLM_<NAME>_MAX_TOKENS=4096           (optional — max completion tokens)
 *   LLM_<NAME>_STRIP_THINKING=true       (optional — strip <think> tags from output)
 *
 * Example — Groq:
 *   LLM_GROQ_ENABLED=true
 *   LLM_GROQ_BASE_URL=https://api.groq.com/openai
 *   LLM_GROQ_API_KEY=gsk_abc123
 *   LLM_GROQ_MODEL=llama-3.3-70b-versatile
 *
 * Example — local vLLM/LiteLLM:
 *   LLM_LOCAL_ENABLED=true
 *   LLM_LOCAL_BASE_URL=http://localhost:8000
 *   LLM_LOCAL_MODEL=my-model
 *
 * Built-in backends (configured via existing env vars):
 *   - ollama: OLLAMA_ENABLED, OLLAMA_BASE_URL, OLLAMA_MODEL
 *   - nim: NIM_ENABLED, NVIDIA_API_KEY, NIM_MODEL
 *
 * ## Programmatic registration
 *
 *   import { registerBackend } from './llm-router.js';
 *   registerBackend('my-custom', { baseUrl, model, apiKey, requestFn });
 */

import http from 'node:http';
import https from 'node:https';
import config from './config.js';
import { createLogger } from './logger.js';
import { executeTool, parseToolCalls } from './tool-bridge.js';

const log = createLogger('llm-router');

const MAX_TOOL_ROUNDS = 5;

// ── Backend registry ────────────────────────────────────────────────────────

/** @type {Map<string, BackendConfig>} */
const backends = new Map();

/**
 * @typedef {object} BackendConfig
 * @property {string} baseUrl - API base URL (e.g. http://localhost:11434, https://api.groq.com/openai)
 * @property {string} model - Default model ID
 * @property {string} [apiKey] - Bearer token for Authorization header
 * @property {number} [costPerInputToken=0] - USD per input token (0 = free)
 * @property {number} [costPerOutputToken=0] - USD per output token (0 = free)
 * @property {number} [timeout=120000] - Default request timeout ms
 * @property {number} [maxTokens] - max_tokens to pass in request body
 * @property {boolean} [stripThinking=false] - Strip <think> tags from response
 * @property {string} [healthEndpoint] - Optional health check URL path (e.g. /api/tags)
 * @property {function} [healthCheck] - Custom async health check function → boolean
 * @property {function} [requestFn] - Fully custom request function (overrides openaiRequest)
 */

/**
 * Register a backend by name.
 * @param {string} name - Backend identifier (e.g. 'groq', 'ollama', 'nim')
 * @param {BackendConfig} cfg
 */
export function registerBackend(name, cfg) {
  const key = name.toLowerCase();
  backends.set(key, {
    timeout: 120_000,
    costPerInputToken: 0,
    costPerOutputToken: 0,
    stripThinking: false,
    ...cfg,
  });
  log.info({ backend: key, model: cfg.model, baseUrl: cfg.baseUrl }, 'Backend registered');
}

/**
 * Get list of registered backend names.
 * @returns {string[]}
 */
export function getAvailableBackends() {
  return [...backends.keys()];
}

/**
 * Get a backend config by name.
 * @param {string} name
 * @returns {BackendConfig|undefined}
 */
export function getBackend(name) {
  return backends.get(name.toLowerCase());
}

// ── Generic OpenAI-compatible HTTP client ───────────────────────────────────

/**
 * Make a single OpenAI-compatible chat completion request.
 * Works with Ollama, NIM, Groq, OpenAI, LiteLLM, vLLM, etc.
 *
 * @param {Array} messages - Chat messages array
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.model
 * @param {string} [opts.apiKey]
 * @param {number} [opts.timeout=120000]
 * @param {number} [opts.maxTokens]
 * @param {boolean} [opts.stripThinking=false]
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number}>}
 */
async function openaiRequest(messages, opts) {
  const { baseUrl, model, apiKey, timeout = 120_000, maxTokens, stripThinking = false } = opts;

  const payload = { model, messages, stream: false };
  if (maxTokens) payload.max_tokens = maxTokens;

  const body = JSON.stringify(payload);
  const url = new URL('/v1/chat/completions', baseUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const result = await new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: 'POST',
      headers,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode !== 200) {
          // Sanitize response body — may contain API keys or tokens in error details
          const sanitized = raw.slice(0, 300).replace(/["']?[a-zA-Z0-9_\-]{32,}["']?/g, '[REDACTED]');
          reject(new Error(`LLM API ${res.statusCode}: ${sanitized}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`LLM response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`LLM request timed out (${timeout}ms)`)); });
    req.write(body);
    req.end();
  });

  const choice = result.choices?.[0];
  if (!choice) throw new Error('LLM response has no choices');

  let text = (choice.message?.content || '').trim();
  if (stripThinking) {
    text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  }

  const reasoning = choice.message?.reasoning_content;
  if (reasoning) log.debug({ reasoningLen: reasoning.length }, 'Reasoning content received');

  const usage = result.usage || {};
  return {
    text,
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
  };
}

// ── Shared tool-use loop ────────────────────────────────────────────────────

/**
 * Run a chat completion with automatic tool-call loop.
 * If the model emits <tool_call> XML tags, executes them via tool-bridge
 * and feeds results back for another round (up to MAX_TOOL_ROUNDS).
 *
 * @param {Array} messages - Chat messages (mutated in-place with tool rounds)
 * @param {function} requestFn - async (messages) => {text, inputTokens, outputTokens}
 * @param {string} backendName - For logging
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number, toolLog: Array}>}
 */
async function chatWithTools(messages, requestFn, backendName) {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalText = '';
  const toolLog = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await requestFn(messages);
    totalInputTokens += res.inputTokens;
    totalOutputTokens += res.outputTokens;
    finalText = res.text;

    const toolCalls = parseToolCalls(res.text);
    if (toolCalls.length === 0) {
      log.info({ backend: backendName, totalInputTokens, totalOutputTokens, rounds: round + 1 }, 'Chat complete');
      break;
    }

    log.info({ backend: backendName, round: round + 1, toolCount: toolCalls.length, tools: toolCalls.map(t => t.name) }, 'Tool round');
    messages.push({ role: 'assistant', content: res.text });

    const toolResults = [];
    for (const tc of toolCalls) {
      try {
        const result = await executeTool(tc.name, tc.params);
        const output = result.success
          ? JSON.stringify(result.result).slice(0, 3000)
          : `Error: ${result.error}`;
        toolResults.push(`<tool_result name="${tc.name}">${output}</tool_result>`);
        toolLog.push({ tool: tc.name, success: result.success, round: round + 1, path: tc.params?.path });
        log.info({ backend: backendName, tool: tc.name, success: result.success, round: round + 1 }, 'Tool executed');
      } catch (err) {
        toolResults.push(`<tool_result name="${tc.name}">Error: ${err.message}</tool_result>`);
        toolLog.push({ tool: tc.name, success: false, round: round + 1, error: err.message });
        log.warn({ backend: backendName, tool: tc.name, err: err.message, round: round + 1 }, 'Tool failed');
      }
    }

    messages.push({ role: 'user', content: `Tool results:\n${toolResults.join('\n')}\n\nContinue with your analysis. Use more tool calls if needed, or provide your final response with XML action tags.` });
  }

  return { text: finalText, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, toolLog };
}

// ── Health check ────────────────────────────────────────────────────────────

/**
 * Check if a registered backend is available.
 * @param {string} name - Backend name
 * @returns {Promise<boolean>}
 */
export async function isBackendAvailable(name) {
  const cfg = backends.get(name.toLowerCase());
  if (!cfg) return false;

  // Custom health check takes priority
  if (cfg.healthCheck) {
    try { return await cfg.healthCheck(); } catch { return false; }
  }

  // For backends with a health endpoint (like Ollama's /api/tags)
  if (cfg.healthEndpoint) {
    const url = new URL(cfg.healthEndpoint, cfg.baseUrl);
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
      const req = transport.get(url, { timeout: 3000 }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            // For Ollama, check if model is in the list
            if (data.models) {
              const models = data.models.map(m => m.name);
              const available = models.some(m => m === cfg.model || m.startsWith(cfg.model.split(':')[0]));
              resolve(available);
            } else {
              resolve(res.statusCode === 200);
            }
          } catch {
            resolve(res.statusCode === 200);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  // No health check — assume available if it has a baseUrl
  return !!cfg.baseUrl;
}

// ── Unified chat entry point ────────────────────────────────────────────────

/**
 * Unified LLM chat with automatic tool-use loop.
 * Drop-in replacement for ollamaChat() and nimChat().
 *
 * @param {string} prompt - User message content
 * @param {object} opts
 * @param {string} opts.backend - Backend name (e.g. 'ollama', 'nim', 'groq')
 * @param {string} [opts.model] - Override default model
 * @param {string} [opts.systemPrompt] - System message
 * @param {number} [opts.timeout] - Override default timeout
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number, costUsd: number, model: string, backend: string, toolLog: Array}>}
 */
export async function llmChat(prompt, { backend, model, systemPrompt, timeout } = {}) {
  const key = backend.toLowerCase();
  const cfg = backends.get(key);
  if (!cfg) throw new Error(`Unknown LLM backend: ${backend}`);

  const resolvedModel = model || cfg.model;
  const resolvedTimeout = timeout || cfg.timeout;

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  // Use custom requestFn if provided, otherwise use generic openaiRequest
  const requestFn = cfg.requestFn
    ? (msgs) => cfg.requestFn(msgs, resolvedModel, resolvedTimeout)
    : (msgs) => openaiRequest(msgs, {
        baseUrl: cfg.baseUrl,
        model: resolvedModel,
        apiKey: cfg.apiKey,
        timeout: resolvedTimeout,
        maxTokens: cfg.maxTokens,
        stripThinking: cfg.stripThinking,
      });

  const result = await chatWithTools(messages, requestFn, key);

  const costUsd = (result.inputTokens * (cfg.costPerInputToken || 0))
                + (result.outputTokens * (cfg.costPerOutputToken || 0));

  return {
    text: result.text,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd,
    model: resolvedModel,
    backend: key,
    toolLog: result.toolLog,
  };
}

// ── Backend selection ───────────────────────────────────────────────────────

/**
 * Select the cheapest available backend.
 * Checks health of each backend in cost-ascending order.
 *
 * @returns {Promise<string|null>} Backend name or null if none available
 */
export async function selectFreeBackend() {
  // Sort by cost (cheapest first)
  const sorted = [...backends.entries()]
    .sort((a, b) => (a[1].costPerInputToken || 0) - (b[1].costPerInputToken || 0));

  for (const [name, cfg] of sorted) {
    // Skip backends that cost money if there are free ones
    if ((cfg.costPerInputToken || 0) > 0) continue;
    if (await isBackendAvailable(name)) return name;
  }

  // No free backends — try any available
  for (const [name] of sorted) {
    if (await isBackendAvailable(name)) return name;
  }

  return null;
}

// ── Auto-discovery from env vars ────────────────────────────────────────────

/**
 * Scan process.env for LLM_<NAME>_ENABLED=true and register backends.
 * Also registers built-in Ollama and NIM if configured.
 */
export function initBackends() {
  // Built-in: Ollama (from existing config)
  if (config.ollamaEnabled) {
    registerBackend('ollama', {
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaModel,
      healthEndpoint: '/api/tags',
      costPerInputToken: 0,
      costPerOutputToken: 0,
    });
  }

  // Built-in: NVIDIA NIM (from existing config)
  if (config.nimEnabled && config.nimApiKey) {
    registerBackend('nim', {
      baseUrl: 'https://integrate.api.nvidia.com',
      model: config.nimModel,
      apiKey: config.nimApiKey,
      maxTokens: 16384,
      stripThinking: true,
      costPerInputToken: 0,
      costPerOutputToken: 0,
    });
  }

  // Auto-discover: LLM_<NAME>_ENABLED=true
  const envPrefix = 'LLM_';
  const envSuffix = '_ENABLED';
  const discovered = new Set();

  for (const key of Object.keys(process.env)) {
    if (!key.startsWith(envPrefix) || !key.endsWith(envSuffix)) continue;
    if (process.env[key] !== 'true') continue;

    const name = key.slice(envPrefix.length, -envSuffix.length).toLowerCase();
    if (backends.has(name)) continue; // already registered (ollama/nim)
    discovered.add(name);

    const prefix = `LLM_${name.toUpperCase()}_`;
    const baseUrl = process.env[`${prefix}BASE_URL`];
    const apiKey = process.env[`${prefix}API_KEY`];
    const model = process.env[`${prefix}MODEL`];
    const costInput = parseFloat(process.env[`${prefix}COST_INPUT`] || '0');
    const costOutput = parseFloat(process.env[`${prefix}COST_OUTPUT`] || '0');
    const maxTokens = process.env[`${prefix}MAX_TOKENS`] ? parseInt(process.env[`${prefix}MAX_TOKENS`], 10) : undefined;
    const stripThinking = process.env[`${prefix}STRIP_THINKING`] === 'true';

    if (!baseUrl || !model) {
      log.warn({ name, prefix }, 'Skipping backend — missing BASE_URL or MODEL');
      continue;
    }

    registerBackend(name, {
      baseUrl,
      model,
      apiKey,
      costPerInputToken: costInput,
      costPerOutputToken: costOutput,
      maxTokens,
      stripThinking,
    });
  }

  if (discovered.size > 0) {
    log.info({ discovered: [...discovered] }, 'Auto-discovered LLM backends from env');
  }

  log.info({ backends: [...backends.keys()] }, 'LLM router initialized');
}
