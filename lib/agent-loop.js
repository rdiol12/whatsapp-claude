/**
 * Agent Loop — autonomous cycle using Claude CLI (OAuth, no API key required).
 *
 * Uses chatOneShot() which spawns the Claude CLI exactly like regular chat does.
 * Claude has access to all bot MCP tools (bot_list_crons, bot_goal_list, vestige, etc.)
 * and built-in tools (Bash, Read, WebSearch, etc.)
 *
 * If Claude decides to notify Ron, it wraps the message in <wa_message>...</wa_message>.
 *
 * NOTE: cron failures and intentions are already handled by proactive.js (natively, no CLI spawn).
 * This loop focuses only on goals — things that require AI judgment.
 */

import { chatOneShot } from './claude.js';
import { createLogger } from './logger.js';
import { getState, setState } from './state.js';
import { listGoals } from './goals.js';
import config from './config.js';

const log = createLogger('agent-loop');

const INTERVAL_MS = config.agentLoopInterval || 30 * 60_000; // 30 min default
const STATE_KEY = 'agent-loop';

let intervalTimer = null;  // stores the setInterval handle
let startupTimer = null;   // stores the initial setTimeout handle
let sendFn = null;         // WhatsApp send function — set by startAgentLoop()
let running = false;       // concurrency guard — only one cycle at a time

// ─── Agent prompt ─────────────────────────────────────────────────────────────

function buildAgentPrompt() {
  const now = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  return `AGENT_CYCLE: ${now}

You are running as an autonomous background agent for Ron. This is NOT a conversation — Ron is not watching. Use your tools silently.

Tasks for this cycle:
1. Use bot_goal_list to check active goals — are any overdue, blocked, or stuck?
2. For any concerning goal, use bot_goal_detail to investigate further if needed.
3. Take note of anything that genuinely needs Ron's attention.

Note: cron failures and reminders are handled by a separate system. Do NOT check those here.

Rules:
- Act silently. Don't narrate your steps in the final output.
- Only message Ron if there is something genuinely important (overdue goal, blocked goal with no activity in 72h+).
- Do NOT message for routine status — only for things Ron needs to act on.
- If you want to send Ron a WhatsApp message, wrap it exactly like this:
  <wa_message>your message here</wa_message>
- Multiple messages are allowed — each in its own <wa_message> block.
- If nothing needs reporting, respond with exactly: CYCLE_DONE

Use your tools now.`;
}

// ─── Quiet hours ─────────────────────────────────────────────────────────────

function isQuietHours() {
  const hour = parseInt(new Date().toLocaleTimeString('en-US', {
    timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false,
  }));
  return hour >= config.quietStart || hour < config.quietEnd;
}

// ─── Run one cycle ────────────────────────────────────────────────────────────

async function runAgentCycle() {
  // Concurrency guard — don't stack cycles
  if (running) {
    log.warn('Agent cycle skipped — previous cycle still running');
    return;
  }

  // Skip if no active goals — no point spawning CLI just to get CYCLE_DONE
  const activeGoals = listGoals({ status: ['active', 'in_progress', 'blocked'] });
  if (activeGoals.length === 0) {
    log.debug('Agent cycle skipped — no active goals');
    return;
  }

  running = true;
  log.info({ activeGoals: activeGoals.length }, 'Agent cycle starting');

  try {
    const prompt = buildAgentPrompt();

    // chatOneShot uses the Claude CLI (OAuth) — no API key needed.
    // Claude gets all bot MCP tools + built-in tools via --mcp-config + bypassPermissions.
    const { reply } = await chatOneShot(prompt, null);

    log.debug({ replyLen: reply.length, preview: reply.slice(0, 120) }, 'Agent cycle response');

    // Extract all <wa_message> blocks (fix: matchAll not match)
    const waMatches = [...reply.matchAll(/<wa_message>([\s\S]*?)<\/wa_message>/g)];
    for (const waMatch of waMatches) {
      const msg = waMatch[1].trim();
      if (msg && sendFn) {
        await sendFn(msg);
        log.info({ msgLen: msg.length }, 'Agent cycle sent WhatsApp message');
      }
    }

    // Record last cycle
    const agentState = getState(STATE_KEY) || {};
    agentState.lastCycleAt = Date.now();
    setState(STATE_KEY, agentState);

    log.info('Agent cycle complete');
  } finally {
    running = false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startAgentLoop(send) {
  sendFn = send;

  // First cycle after 2 minutes (let the bot stabilize first)
  startupTimer = setTimeout(() => {
    startupTimer = null; // clear reference once fired
    if (!isQuietHours()) runAgentCycle().catch(err => log.warn({ err: err.message }, 'Agent cycle failed'));
    intervalTimer = setInterval(() => {
      if (!isQuietHours()) runAgentCycle().catch(err => log.warn({ err: err.message }, 'Agent cycle failed'));
    }, INTERVAL_MS);
    intervalTimer.unref();
  }, 2 * 60_000);

  log.info({ intervalMin: INTERVAL_MS / 60_000 }, 'Agent loop started (CLI/OAuth mode)');
}

export function stopAgentLoop() {
  // Cancel startup timeout if it hasn't fired yet
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  // Cancel the running interval
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

export function getAgentLoopStatus() {
  const state = getState(STATE_KEY) || {};
  return {
    running: intervalTimer !== null || startupTimer !== null,
    cycleRunning: running,
    lastCycleAt: state.lastCycleAt ? new Date(state.lastCycleAt).toISOString() : null,
    intervalMin: INTERVAL_MS / 60_000,
    mode: 'cli-oauth',
  };
}
