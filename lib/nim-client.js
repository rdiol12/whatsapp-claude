/**
 * @deprecated Use lib/llm-router.js instead. NIM is now auto-registered as a backend
 * via initBackends() when NIM_ENABLED=true. This file is kept for backward compatibility
 * but new code should use llmChat() from llm-router.js.
 *
 * NIM Client — Lightweight HTTP client for NVIDIA NIM API.
 *
 * OpenAI-compatible chat completions format.
 * No SDK dependency — uses node:https directly.
 * Used by agent-loop to route routine (Haiku) cycles through free NIM API.
 *
 * Supports a tool-use loop: if the model emits <tool_call> tags,
 * we execute them locally and feed results back for another round.
 */

import https from 'node:https';
import config from './config.js';
import { createLogger } from './logger.js';
import { executeTool, parseToolCalls } from './tool-bridge.js';

const log = createLogger('nim-client');

const NIM_BASE = 'https://integrate.api.nvidia.com';
const DEFAULT_MODEL = 'stepfun-ai/step-3.5-flash';
const MAX_TOOL_ROUNDS = 5;

/**
 * Make a single NIM API call.
 * @param {Array} messages - Chat messages array
 * @param {string} resolvedModel - Model ID
 * @param {string} apiKey - API key
 * @param {number} timeout - Request timeout in ms
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number}>}
 */
async function nimRequest(messages, resolvedModel, apiKey, timeout) {
  const payload = {
    model: resolvedModel,
    messages,
    max_tokens: 16384,
    temperature: 1,
    top_p: 0.9,
    stream: false,
  };

  const body = JSON.stringify(payload);
  const url = new URL('/v1/chat/completions', NIM_BASE);

  const result = await new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (res.statusCode !== 200) {
          reject(new Error(`NIM API ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`NIM response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`NIM request timed out (${timeout}ms)`)); });
    req.write(body);
    req.end();
  });

  const choice = result.choices?.[0];
  if (!choice) throw new Error('NIM response has no choices');

  // Strip thinking content: <think> tags or reasoning_content field
  const raw = choice.message?.content || '';
  const text = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  const reasoning = choice.message?.reasoning_content;
  if (reasoning) log.debug({ reasoningLen: reasoning.length }, 'NIM reasoning content received');
  const usage = result.usage || {};

  return {
    text,
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
  };
}

/**
 * Send a chat completion request to NVIDIA NIM with tool-use loop.
 * If the model emits <tool_call> tags, executes them and feeds results
 * back for another round (up to MAX_TOOL_ROUNDS iterations).
 *
 * @param {string} prompt - User message content
 * @param {object} opts
 * @param {string} [opts.model] - NIM model ID
 * @param {string} [opts.systemPrompt] - System message
 * @param {number} [opts.timeout=120000] - Request timeout in ms
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number, model: string}>}
 */
export async function nimChat(prompt, { model, systemPrompt, timeout = 120_000 } = {}) {
  const apiKey = config.nimApiKey;
  if (!apiKey) throw new Error('NVIDIA_API_KEY not configured');

  const resolvedModel = model || config.nimModel || DEFAULT_MODEL;

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalText = '';
  const toolLog = []; // Track actual tool executions for audit

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await nimRequest(messages, resolvedModel, apiKey, timeout);
    totalInputTokens += res.inputTokens;
    totalOutputTokens += res.outputTokens;
    finalText = res.text;

    // Check for tool calls
    const toolCalls = parseToolCalls(res.text);
    if (toolCalls.length === 0) {
      // No tool calls — we're done
      log.info({ model: resolvedModel, totalInputTokens, totalOutputTokens, rounds: round + 1 }, 'NIM chat complete');
      break;
    }

    // Execute tool calls and collect results
    log.info({ round: round + 1, toolCount: toolCalls.length, tools: toolCalls.map(t => t.name) }, 'NIM tool round');
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
        log.info({ tool: tc.name, success: result.success, round: round + 1 }, 'NIM tool executed');
      } catch (err) {
        toolResults.push(`<tool_result name="${tc.name}">Error: ${err.message}</tool_result>`);
        toolLog.push({ tool: tc.name, success: false, round: round + 1, error: err.message });
        log.warn({ tool: tc.name, err: err.message, round: round + 1 }, 'NIM tool failed');
      }
    }

    // Feed results back as a user message
    messages.push({ role: 'user', content: `Tool results:\n${toolResults.join('\n')}\n\nContinue with your analysis. Use more tool calls if needed, or provide your final response with XML action tags.` });
  }

  return {
    text: finalText,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    model: resolvedModel,
    toolLog,
  };
}
