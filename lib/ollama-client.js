/**
 * @deprecated Use lib/llm-router.js instead. Ollama is now auto-registered as a backend
 * via initBackends() when OLLAMA_ENABLED=true. This file is kept for backward compatibility
 * but new code should use llmChat() from llm-router.js.
 *
 * Ollama Client — Lightweight HTTP client for local Ollama inference.
 *
 * M1 Research findings:
 *   the user's machine: i9-13900HX, 32GB RAM (no dedicated GPU)
 *   - 4-bit quantized 7B models (~4GB): llama3.2, mistral, qwen2.5-coder → fast, great grunt work
 *   - 4-bit quantized 13B models (~8GB): deepseek-coder-v2-lite, gemma3:12b → good quality
 *   - 4-bit quantized 30B models (~18GB): fits in 32GB but slow on CPU
 *   Recommended default: qwen2.5-coder:7b (4GB, fast, strong at tasks Sela does)
 *
 * Ollama runs on Windows (native installer at ollama.com).
 * Exposes OpenAI-compatible API at http://localhost:11434/v1/
 * Zero cost — runs entirely offline on the user's hardware.
 *
 * Used by agent-loop to handle grunt-work routine cycles at zero API cost,
 * as the lowest tier below NIM and Haiku.
 */

import http from 'node:http';
import config from './config.js';
import { createLogger } from './logger.js';
import { executeTool, parseToolCalls } from './tool-bridge.js';

const log = createLogger('ollama-client');

const DEFAULT_MODEL = 'qwen2.5-coder:7b';
const MAX_TOOL_ROUNDS = 5;

/**
 * Make a single Ollama API call.
 * Uses the OpenAI-compatible /v1/chat/completions endpoint.
 *
 * @param {Array} messages - Chat messages array
 * @param {string} resolvedModel - Ollama model name (e.g. 'qwen2.5-coder:7b')
 * @param {string} baseUrl - Ollama base URL (default: http://localhost:11434)
 * @param {number} timeout - Request timeout in ms
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number}>}
 */
async function ollamaRequest(messages, resolvedModel, baseUrl, timeout) {
  const payload = {
    model: resolvedModel,
    messages,
    stream: false,
  };

  const body = JSON.stringify(payload);
  const url = new URL('/v1/chat/completions', baseUrl);

  const result = await new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode !== 200) {
          reject(new Error(`Ollama API ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`Ollama response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Ollama request timed out (${timeout}ms)`)); });
    req.write(body);
    req.end();
  });

  const choice = result.choices?.[0];
  if (!choice) throw new Error('Ollama response has no choices');

  const text = (choice.message?.content || '').trim();
  const usage = result.usage || {};

  return {
    text,
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
  };
}

/**
 * Check whether Ollama is running and has the configured model available.
 * Uses /api/tags — does NOT load the model, just checks availability.
 *
 * @returns {Promise<boolean>}
 */
export async function isOllamaAvailable() {
  const baseUrl = config.ollamaBaseUrl || 'http://localhost:11434';
  const model = config.ollamaModel || DEFAULT_MODEL;
  const url = new URL('/api/tags', baseUrl);

  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const models = (data.models || []).map(m => m.name);
          // Check if configured model is available (exact match or tag prefix match)
          const available = models.some(m => m === model || m.startsWith(model.split(':')[0]));
          if (!available) {
            log.debug({ model, availableModels: models }, 'Ollama running but model not found');
          }
          resolve(available);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Send a chat completion request to Ollama with tool-use loop.
 * If the model emits <tool_call> tags, executes them and feeds results
 * back for another round (up to MAX_TOOL_ROUNDS iterations).
 *
 * Same interface as nimChat() — drop-in compatible.
 *
 * @param {string} prompt - User message content
 * @param {object} opts
 * @param {string} [opts.model] - Ollama model name
 * @param {string} [opts.systemPrompt] - System message
 * @param {number} [opts.timeout=120000] - Request timeout in ms
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number, model: string}>}
 */
export async function ollamaChat(prompt, { model, systemPrompt, timeout = 120_000 } = {}) {
  const baseUrl = config.ollamaBaseUrl || 'http://localhost:11434';
  const resolvedModel = model || config.ollamaModel || DEFAULT_MODEL;

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalText = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await ollamaRequest(messages, resolvedModel, baseUrl, timeout);
    totalInputTokens += res.inputTokens;
    totalOutputTokens += res.outputTokens;
    finalText = res.text;

    // Check for tool calls
    const toolCalls = parseToolCalls(res.text);
    if (toolCalls.length === 0) {
      log.info({ model: resolvedModel, totalInputTokens, totalOutputTokens, rounds: round + 1 }, 'Ollama chat complete');
      break;
    }

    // Execute tool calls and collect results
    log.info({ round: round + 1, toolCount: toolCalls.length, tools: toolCalls.map(t => t.name) }, 'Ollama tool round');
    messages.push({ role: 'assistant', content: res.text });

    const toolResults = [];
    for (const tc of toolCalls) {
      try {
        const result = await executeTool(tc.name, tc.params);
        const output = result.success
          ? JSON.stringify(result.result).slice(0, 3000)
          : `Error: ${result.error}`;
        toolResults.push(`<tool_result name="${tc.name}">${output}</tool_result>`);
        log.info({ tool: tc.name, success: result.success, round: round + 1 }, 'Ollama tool executed');
      } catch (err) {
        toolResults.push(`<tool_result name="${tc.name}">Error: ${err.message}</tool_result>`);
        log.warn({ tool: tc.name, err: err.message, round: round + 1 }, 'Ollama tool failed');
      }
    }

    messages.push({ role: 'user', content: `Tool results:\n${toolResults.join('\n')}\n\nContinue with your analysis. Use more tool calls if needed, or provide your final response with XML action tags.` });
  }

  return {
    text: finalText,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    model: resolvedModel,
  };
}
