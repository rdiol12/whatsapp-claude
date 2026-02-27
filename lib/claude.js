import { spawn } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import config from './config.js';
import { sendToPersistentProcess, respawnForCompression } from './claude-persistent.js';
import { getSkill, listSkills } from './skills.js';
import { autoDetect as registryAutoDetect, reload as reloadRegistry } from './skill-registry.js';
import { createLogger } from './logger.js';
import { search as memorySearch } from './memory-index.js';
import { getCronSummary, addCron, deleteCron, toggleCron, runCronNow, listCrons } from './crons.js';
import { getGoalsContext, listGoals } from './goals.js';
import { retry, classifyError } from './resilience.js';
import { recordCostEntry } from './cost-analytics.js';
import { insertCost } from './db.js';
import { getState as getSessionState, setState as setSessionState } from './state.js';
import { getRecentTopics } from './history.js';
import { detectActionFeedback, recordActionFeedback, getRecentDeliveredCron } from './outcome-tracker.js';
import { gate, computeBudget, resetGateState } from './context-gate.js';
import { emit as wsEmit } from './ws-events.js';
import { executeToolCallsFromText, listTools } from './tool-bridge.js';
import { selectTier, assemblePrompt } from './prompt-assembler.js';

const log = createLogger('claude');
const CLI_PROMPTS_DIR = join(config.dataDir, 'cli-prompts');
try { mkdirSync(CLI_PROMPTS_DIR, { recursive: true }); } catch {}

// --- Mem0-style per-conversation fact extraction ---
// After every user exchange, extract key facts and ingest into Vestige.
// Fire-and-forget (non-blocking), Haiku model for minimal cost (~$0.001/call).

async function extractFactsFromExchange(userMsg, botReply) {
  if (!userMsg || userMsg.length < 20) return; // skip trivial messages
  if (userMsg.startsWith('/')) return;          // skip commands

  try {
    const prompt = `Extract key facts about the user from this exchange as JSON.
Only include facts about the USER — preferences, decisions, context, schedule, habits, opinions.
Do NOT include facts about what the assistant did.
Return: { "facts": ["fact1", "fact2"] }
Return { "facts": [] } if no useful user facts.

User: ${userMsg.slice(0, 500)}
Assistant: ${botReply.slice(0, 500)}`;

    const { reply } = await chatOneShot(prompt, null, 'haiku');
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) return;

    let parsed;
    try { parsed = JSON.parse(match[0]); } catch { return; }
    if (!Array.isArray(parsed.facts) || parsed.facts.length === 0) return;

    const { smartIngest } = await import('./mcp-gateway.js');
    let ingested = 0;
    for (const fact of parsed.facts.slice(0, 5)) {
      if (fact && fact.length > 10) {
        await smartIngest(fact, ['auto-extracted', 'conversation'], 'fact', 'fact-extraction');
        ingested++;
      }
    }

    if (ingested > 0) {
      log.info({ factCount: ingested, userMsgLen: userMsg.length }, 'Facts extracted from exchange');
    }
  } catch (err) {
    log.debug({ err: err.message }, 'Fact extraction failed (non-critical)');
  }
}

// Recent CLI spawn events buffer (for REST polling — WS is real-time)
const MAX_CLI_EVENTS = 30;
const recentCliEvents = [];
export function getRecentCliEvents() { return recentCliEvents; }
// Claude Code stores project memory at ~/.claude/projects/<encoded-project-path>/memory/MEMORY.md
const PROJECT_DIR = config.projectRoot;
const ENCODED_PROJECT = PROJECT_DIR.replace(/[:/\\]/g, '-').replace(/^-/, '');
const MEMORY_PATH = join(homedir(), '.claude', 'projects', ENCODED_PROJECT, 'memory', 'MEMORY.md');
const SOUL_PATH = config.soulPath;
const BOT_MEMORY_PATH = config.memoryPath;
const MCP_CONFIG = config.mcpConfigPath;
const CLI_TIMEOUT = config.cliTimeout;

// --- Cost tracking ---

const COSTS_FILE = config.costsFile;
mkdirSync(config.dataDir, { recursive: true });

function logCost(entry) {
  if (config.costTrackingDisabled) return;
  const ts = Date.now();
  try {
    appendFileSync(COSTS_FILE, JSON.stringify({ ...entry, ts }) + '\n');
  } catch {}
  try {
    insertCost({ ...entry, ts }); // dual-write to SQLite (costs.jsonl rotation ms_4)
  } catch {}
  try {
    recordCostEntry(entry.costUsd);
  } catch {}
}

// --- Persistent session with compression ---

const SESSION_TOKEN_LIMIT = config.claudeSessionTokenLimit; // Compress at 75% of 200K context
let sessionId = randomUUID();
let sessionStarted = false;
let sessionTokens = 0;
let sessionMsgCount = 0; // messages in current session (for conditional context injection)

// Load persisted session summary (survives restarts)
const persistedSummary = getSessionState('session-summary');
let sessionSummary = persistedSummary?.summary || '';
let prevTurnWasAction = false; // true if last bot turn involved a cron/proposal/tool execution

export function resetSession() {
  sessionId = randomUUID();
  sessionStarted = false;
  sessionTokens = 0;
  sessionMsgCount = 0;
  resetGateState();
  log.info({ sessionId }, 'Session reset');
}

export function getSessionId() { return sessionId; }
export function getContextStats() {
  return {
    sessionTokens,
    tokenLimit: SESSION_TOKEN_LIMIT,
    pct: SESSION_TOKEN_LIMIT > 0 ? Math.round((sessionTokens / SESSION_TOKEN_LIMIT) * 100) : 0,
    sessionMsgCount,
  };
}
export function getSystemPrompt() { return currentSystemPrompt; }

// --- SOUL.md + MEMORY.md ---

function loadFile(path, label) {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn({ err: err.message }, `Failed to load ${label}`);
    return '';
  }
}

let soul = loadFile(SOUL_PATH, 'SOUL.md');
let memory = loadFile(MEMORY_PATH, 'MEMORY.md');
let botMemory = loadFile(BOT_MEMORY_PATH, 'Bot MEMORY.md');
let soulMtime = 0;
let memoryMtime = 0;
let botMemoryMtime = 0;

// Refresh both every 5 minutes — only reload if file actually changed
setInterval(() => {
  let anyChanged = false;
  try {
    const sm = statSync(SOUL_PATH).mtimeMs;
    if (sm !== soulMtime) { soul = loadFile(SOUL_PATH, 'SOUL.md') || soul; soulMtime = sm; anyChanged = true; }
  } catch {}
  try {
    const mm = statSync(MEMORY_PATH).mtimeMs;
    if (mm !== memoryMtime) { memory = loadFile(MEMORY_PATH, 'MEMORY.md') || memory; memoryMtime = mm; anyChanged = true; }
  } catch {}
  try {
    const bm = statSync(BOT_MEMORY_PATH).mtimeMs;
    if (bm !== botMemoryMtime) { botMemory = loadFile(BOT_MEMORY_PATH, 'Bot MEMORY.md') || botMemory; botMemoryMtime = bm; anyChanged = true; }
  } catch {}
  // Rebuild static context (goals/crons/skills) if changed
  const staticChanged = refreshStaticContextIfNeeded();
  // Only rebuild system prompt if source files actually changed — avoids flushing
  // the persistent session cache every 5min due to dynamic content (timestamps)
  if (anyChanged || staticChanged) {
    refreshSystemPromptIfNeeded();
  }
}, 5 * 60_000);

export function reloadSkills() {
  reloadRegistry();
  log.info('Skills reloaded from disk (registry re-indexed)');
}

log.info({ soulChars: soul.length, memoryChars: memory.length, botMemoryChars: botMemory.length, sessionId }, 'Loaded SOUL.md + MEMORY.md + Bot MEMORY.md');
log.info({ skillCount: listSkills().length }, 'Skills available (keyword matching)');

// --- Skill keyword matching ---

const SKILL_KEYWORDS = {
  'business-briefing': ['business briefing', 'market analysis', 'business signal', 'competitor analysis'],
  'content-pipeline': ['content pipeline', 'content idea', 'blog post', 'article idea', 'content brief'],
  'context-manager': ['context manager', 'session context', 'manage context'],
  'cost-tracker': ['cost track', 'api cost', 'token usage', 'spending', 'ai cost', 'usage track'],
  'db-backup': ['db backup', 'database backup', 'sqlite backup', 'backup database'],
  'frontend-design': ['frontend', 'ui design', 'css', 'component design', 'layout design', 'web design', 'interface design'],
  'git-sync': ['git sync', 'auto commit', 'git auto', 'git push auto'],
  'health-monitor': ['health monitor', 'health check', 'system health', 'monitoring'],
  'humanizer': ['humanize', 'humanizer', 'sound human', 'rewrite human', 'ai detection', 'remove ai'],
  'image-gen': ['image', 'picture', 'photo', 'generate image', 'dall-e', 'dalle', 'draw', 'illustration', 'תמונה', 'צייר'],
  'knowledge-base': ['knowledge base', 'save knowledge', 'recall knowledge', 'rag'],
  'personal-crm': ['crm', 'contacts', 'contact list', 'people track', 'gmail contact'],
  'prompt-engineering': ['prompt engineer', 'write prompt', 'prompting', 'prompt guide', 'prompt tip'],
  'regex-patterns': ['regex', 'regular expression', 'regexp', 'pattern match', 'ביטוי רגולרי'],
  'social-research': ['twitter', 'social media research', 'x.com', 'what are people saying', 'social research', 'טוויטר'],
  'task-extractor': ['extract task', 'action item', 'meeting notes', 'transcript', 'extract action'],
  'youtube-analytics': ['youtube', 'channel analytics', 'subscriber', 'video stats', 'יוטיוב'],
  'code-council': ['code council', 'audit the code', 'review the codebase', 'security audit', 'code review', 'codebase audit'],
};

function matchSkills(userMessage) {
  const lower = userMessage.toLowerCase();
  const matched = new Set();
  for (const [skill, keywords] of Object.entries(SKILL_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) matched.add(skill);
  }
  for (const name of listSkills()) {
    if (matched.has(name)) continue;
    const nameSpaced = name.toLowerCase().split('-').join(' ');
    if (lower.includes(name.toLowerCase()) || lower.includes(nameSpaced)) matched.add(name);
  }
  // Also check skill-registry (YAML frontmatter keywords)
  for (const skill of registryAutoDetect(userMessage, 3)) {
    matched.add(skill.id);
  }
  return [...matched];
}

// --- Skill usage history ---
// Maps content words → skill names, learned from actual usage.

let skillUsageHistory = {};
try { skillUsageHistory = getSessionState('skill-usage-history') || {}; } catch {}

function recordSkillUsage(skillNames, userText) {
  if (skillNames.length === 0) return;
  const words = userText.toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 4 && !['about', 'please', 'could', 'would', 'should', 'their', 'there', 'these', 'those'].includes(w))
    .slice(0, 3);

  for (const word of words) {
    if (!skillUsageHistory[word]) skillUsageHistory[word] = [];
    for (const skill of skillNames) {
      if (!skillUsageHistory[word].includes(skill)) {
        skillUsageHistory[word].push(skill);
        if (skillUsageHistory[word].length > 5) skillUsageHistory[word].shift();
      }
    }
  }

  const totalEntries = Object.keys(skillUsageHistory).length;
  if (totalEntries % 10 === 0) {
    try { setSessionState('skill-usage-history', skillUsageHistory); } catch {}
  }
}

function matchSkillsEnhanced(userMessage) {
  const fromKeywords = new Set(matchSkills(userMessage));

  const words = userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 4);
  for (const word of words) {
    const historical = skillUsageHistory[word] || [];
    for (const skill of historical) fromKeywords.add(skill);
  }

  return [...fromKeywords];
}

// --- Marker parsing & execution ---

const ALL_MARKERS_RE = /\[(CRON_ADD|CRON_DELETE|CRON_TOGGLE|CRON_RUN|SEND_FILE|TOOL_CALL):[^\]]*\]/gs;
const LOCAL_MARKERS_RE = /\[(BOT_STATUS|CLEAR_HISTORY|LIST_CRONS|TODAY_NOTES|LIST_SKILLS|LIST_FILES)\]|\[SEARCH_NOTES:[^\]]*\]/g;

async function executeMarkers(text) {
  const filesToSend = [];
  const actions = [];
  let m;

  // Memory and intention operations are now handled natively via MCP tools.
  // Only cron and file markers remain as text-based actions.

  // CRON_ADD: name | cron-expr | prompt  OR  name | cron-expr | prompt | delivery | model
  for (m of text.matchAll(/\[CRON_ADD:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([\s\S]+?)(?:\s*\|\s*(announce|silent))?(?:\s*\|\s*(\S+))?\]/g)) {
    const name = m[1].trim(), schedule = m[2].trim(), prompt = m[3].trim();
    const delivery = m[4]?.trim() || 'announce';
    const model = m[5]?.trim() || null;
    actions.push({ type: 'create_cron', fn: () => addCron(name, schedule, prompt, null, delivery, model) });
  }
  for (m of text.matchAll(/\[CRON_DELETE:\s*(.+?)\]/g)) {
    actions.push({ type: 'delete_cron', fn: () => deleteCron(m[1].trim()) });
  }
  for (m of text.matchAll(/\[CRON_TOGGLE:\s*(.+?)\]/g)) {
    actions.push({ type: 'toggle_cron', fn: () => toggleCron(m[1].trim()) });
  }
  for (m of text.matchAll(/\[CRON_RUN:\s*(.+?)\]/g)) {
    actions.push({ type: 'run_cron', fn: () => runCronNow(m[1].trim()) });
  }
  for (m of text.matchAll(/\[SEND_FILE:\s*(.+?)\]/g)) {
    filesToSend.push(m[1].trim());
  }

  // TOOL_CALL markers: [TOOL_CALL: name | params_json] and <tool_call> XML tags
  const toolResultMessages = [];
  if (config.toolBridgeEnabled) {
    try {
      const toolResults = await executeToolCallsFromText(text);
      for (const tr of toolResults) {
        actions.push({ type: `tool:${tr.name}`, fn: async () => tr }); // already executed
        log.info({ tool: tr.name, success: tr.success }, 'TOOL_CALL executed');
        if (tr.success && tr.result) {
          const content = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result, null, 2);
          toolResultMessages.push(content.slice(0, 15000));
        }
      }
    } catch (err) {
      log.warn({ err: err.message }, 'TOOL_CALL execution failed');
    }
  }

  for (const action of actions) {
    try {
      log.info({ type: action.type }, 'MARKER_EXEC: Executing');
      await action.fn();
      log.info({ type: action.type }, 'MARKER_EXEC: Done');
    } catch (err) {
      log.error({ type: action.type, err: err.message }, 'MARKER_EXEC: Failed');
    }
  }

  return { filesToSend, actionCount: actions.length, toolResultMessages };
}

function stripMarkers(text) {
  return text.replace(ALL_MARKERS_RE, '').replace(LOCAL_MARKERS_RE, '').replace(/<tool_call\s+name="[^"]*">[\s\S]*?<\/tool_call>/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Execute local data-returning markers ([BOT_STATUS], [LIST_CRONS], etc.)
 * Returns data messages to send as follow-ups and side-effect flags.
 */
function executeLocalMarkers(text, botContext = {}) {
  const dataMessages = [];
  let shouldClearHistory = false;

  if (/\[BOT_STATUS\]/.test(text)) {
    const upSec = process.uptime();
    const upStr = upSec < 3600 ? `${(upSec / 60).toFixed(0)}m` : `${(upSec / 3600).toFixed(1)}h`;
    const mem = process.memoryUsage();
    const memStr = `${(mem.rss / 1048576).toFixed(0)}MB`;
    const mcp = botContext.isMcpConnected?.() ? 'connected' : 'disconnected';
    const qStats = botContext.queueStats?.() || { running: '?', waiting: '?' };
    const cronCount = listCrons().length;
    dataMessages.push(`*Bot Status*\nUptime: ${upStr}\nMemory: ${memStr}\nModel: ${config.claudeModel}\nQueue: ${qStats.running} running, ${qStats.waiting} waiting\nVestige MCP: ${mcp}\nCrons: ${cronCount} jobs\nSession tokens: ~${sessionTokens}`);
  }

  if (/\[CLEAR_HISTORY\]/.test(text)) {
    shouldClearHistory = true;
  }

  if (/\[LIST_CRONS\]/.test(text)) {
    const summary = getCronSummary();
    dataMessages.push(`*Cron Jobs:*\n${summary || 'No cron jobs configured.'}`);
  }

  if (/\[TODAY_NOTES\]/.test(text)) {
    const notes = botContext.getTodayNotes?.();
    dataMessages.push(notes || 'No notes yet today.');
  }

  for (const m of text.matchAll(/\[SEARCH_NOTES:([^\]]+)\]/g)) {
    const dateStr = m[1].trim();
    const notes = botContext.getNotesForDate?.(dateStr);
    dataMessages.push(notes || `No notes found for ${dateStr}.`);
  }

  if (/\[LIST_SKILLS\]/.test(text)) {
    const names = botContext.listSkills?.() || [];
    dataMessages.push(names.length
      ? `*Skills (${names.length}):*\n${names.map(n => `• ${n}`).join('\n')}`
      : 'No skills loaded.');
  }

  if (/\[LIST_FILES\]/.test(text)) {
    try {
      const files = readdirSync(config.workspaceDir);
      if (files.length === 0) {
        dataMessages.push('Workspace is empty.');
      } else {
        const listing = files.map(f => {
          try {
            const st = statSync(join(config.workspaceDir, f));
            const size = st.size < 1024 ? `${st.size}B`
              : st.size < 1048576 ? `${(st.size / 1024).toFixed(1)}KB`
              : `${(st.size / 1048576).toFixed(1)}MB`;
            return `• ${f} (${size})`;
          } catch { return `• ${f}`; }
        }).join('\n');
        dataMessages.push(`*Workspace files (${files.length}):*\n${listing}`);
      }
    } catch (err) {
      dataMessages.push(`Error listing files: ${err.message}`);
    }
  }

  return { dataMessages, shouldClearHistory };
}

// --- Chunking ---

/**
 * Find a natural break point in the text buffer for chunked delivery.
 * Buffers at least 3500 chars before breaking — this ensures short responses
 * (< 3500 chars) are sent as a single message, reducing notification spam.
 * Only starts streaming when the buffer exceeds one WhatsApp message worth.
 */
function findChunkBreak(buffer) {
  // Don't break until we have a full message's worth of text
  if (buffer.length < 3500) return -1;

  // Try to break at a paragraph boundary
  const paraIdx = buffer.indexOf('\n\n');
  if (paraIdx > 0 && paraIdx < 3800) return paraIdx + 2;

  // Try newline
  const nlIdx = buffer.lastIndexOf('\n', 3800);
  if (nlIdx > 200) return nlIdx + 1;

  // Try space
  const spaceIdx = buffer.lastIndexOf(' ', 3800);
  if (spaceIdx > 200) return spaceIdx + 1;

  // Hard break
  return 3800;
}

// --- Static context cache ---
// Goals, crons, skill names — rebuilt only when they change, not every turn.

let staticContextBlock = '';
let staticContextHash = '';

function buildStaticContext() {
  const parts = [];

  // Goals and crons are in the DB — Claude can query via bot_goal_list / bot_list_crons
  // MCP tools on demand. No need to bake them into the system prompt.

  // Skill names (content injected per-turn only when matched)
  try {
    const names = listSkills();
    if (names.length > 0) {
      parts.push(`## Available skills (use get_skill MCP tool or ask to load one):\n${names.join(', ')}`);
    }
  } catch {}

  return parts.join('\n\n');
}

function getStaticContextHash() {
  try {
    const skillCount = listSkills().length;
    return `${skillCount}`;
  } catch { return '0'; }
}

export function refreshStaticContextIfNeeded() {
  const newHash = getStaticContextHash();
  if (newHash !== staticContextHash) {
    staticContextBlock = buildStaticContext();
    staticContextHash = newHash;
    log.info({ hash: newHash, len: staticContextBlock.length }, 'Static context rebuilt');
    return true;
  }
  return false;
}

// Build on startup
staticContextBlock = buildStaticContext();
staticContextHash = getStaticContextHash();

// --- System prompt (static, set once on session creation) ---

// Dynamic system prompt: base + SOUL.md + MEMORY.md + static context (cached by API)
// Phase 4: Dynamic system prompt via prompt-assembler with tier selection.
// The system prompt is set once per persistent process session.
// For startup (no user message yet), we use 'standard' tier.
// Legacy monolithic prompt is fallback only on assembler error.
function buildSystemPrompt(opts = {}) {
  try {
    const tier = opts.tier || selectTier({
      userMessage: opts.userMessage || '',
      contextPressure: opts.contextPressure || 0,
      moodState: opts.moodState || null,
      costBudgetPct: opts.costBudgetPct || 0,
    });
    const { prompt, tokens, tier: usedTier } = assemblePrompt(tier, {
      userMessage: opts.userMessage || '',
      matchedSkills: opts.matchedSkills || [],
      relevantMemories: opts.relevantMemories || '',
    });
    log.info({ tier: usedTier, tokens, chars: prompt.length }, 'System prompt built via prompt-assembler');
    return prompt;
  } catch (err) {
    log.warn({ err: err.message }, 'Prompt assembler failed, using legacy prompt');
  }

  // Legacy fallback: full monolithic prompt
  const parts = [BASE_SYSTEM_PROMPT];
  if (soul) parts.push(`\n\n## Soul (personality & rules)\n${soul}`);
  if (memory) parts.push(`\n\n## Memory (MEMORY.md)\n${memory}`);
  if (botMemory) parts.push(`\n\n## Bot Memory (self-updating)\nUpdate ~/sela/MEMORY.md when you discover preferences, patterns, or solutions worth remembering.\n${botMemory}`);
  if (staticContextBlock) parts.push(`\n\n${staticContextBlock}`);
  return parts.join('');
}

let currentSystemPrompt = '';

const BASE_SYSTEM_PROMPT = `You are Claude, the user's personal AI agent on WhatsApp. Your personality and communication style are defined in the Soul section below.

## Capabilities

### Direct tools (Claude Code built-in)
FULL access to the user's machine:
- *Bash*: any shell command (git, npm, python, docker, pm2, curl, etc.)
- *Read/Write/Edit*: files anywhere in ~/
- *Glob/Grep*: search across the entire filesystem
- *WebSearch/WebFetch*: look up anything on the internet
- *Vestige MCP*: persistent memory with semantic search, intentions, and session checkpoints

### Bot Operations (MCP tools — PREFERRED)
Native MCP tools for bot operations. Return structured JSON. ALWAYS prefer over text markers.
- *bot_status* -- uptime, memory, model, queue, MCP connection, cron count
- *bot_list_crons*, *bot_cron_add*, *bot_cron_delete*, *bot_cron_toggle*, *bot_cron_run*
- *bot_list_files*, *bot_list_skills*
- *bot_today_notes*, *bot_search_notes*

CRITICAL: When the user asks about bot status, crons, notes, goals -- use bot_* MCP tools. For files, skills, costs, history -- use built-in tools (Glob, Read, Bash). Never say "I can't check that."

### Scrapling MCP (web scraping)
You have a *scrapling* MCP server with 6 tools. When the user asks to scrape/fetch/check a URL — use scrapling MCP tools:
- *get* — fast HTTP (try first), *fetch* — Playwright browser, *stealthy_fetch* — Cloudflare bypass

### Hattrick MCP (team management)
You have a *hattrick* MCP server for managing the user's Hattrick team (configured via HATTRICK_TEAM_ID). CRITICAL: When the user asks about Hattrick — use hattrick MCP tools:
- *hattrick_get_team*, *hattrick_get_players*, *hattrick_get_matches*, *hattrick_get_training*, *hattrick_get_economy*, *hattrick_get_league*
- *hattrick_scrape* — any hattrick page, *hattrick_action* — browser automation (lineups, training changes)
- All tools auto-login. Each call takes ~10-15s (browser launch + login + scrape).

### Text markers (legacy fallback)
Prefer MCP tools. Markers are parsed from text output and executed by the bot.
- [SEND_FILE: path] -- send a file to WhatsApp
- [CRON_ADD: name | cron-expr | prompt], [CRON_DELETE: id], [CRON_TOGGLE: id], [CRON_RUN: id]

## Vestige memory
Memories and intentions are pre-fetched into context, but they may be incomplete.
CRITICAL: When the user asks about personal preferences, facts about themselves, past decisions, or anything you're not 100% sure about — ALWAYS use Vestige *search* BEFORE answering. Never guess or make up personal information. If search returns nothing, say you don't know.
- *search* -- ALWAYS search before answering personal/preference questions
- *smart_ingest* -- save facts, decisions, preferences (DO THIS PROACTIVELY)
- *intention* -- set/check/list/update goals and reminders
- *session_checkpoint* -- batch save up to 20 items

### Goals (long-running objectives)
Native MCP tools for managing multi-day/week goals:
- *bot_goal_list* -- list active goals with progress
- *bot_goal_add* -- create a new goal (title, description, priority, category, deadline, milestones, linkedTopics)
- *bot_goal_update* -- update status, progress, fields
- *bot_goal_complete* -- mark a goal as completed
- *bot_goal_milestone_add* -- add a milestone to a goal
- *bot_goal_milestone_complete* -- mark a milestone done
- *bot_goal_detail* -- get full goal details with milestones and activity log

**You must actively manage goals:**
- When the user mentions a new project, multi-day task, or objective that doesn't already have a goal — create one with bot_goal_add. Don't ask permission, just do it.
- When work relates to an existing goal (shown in context), update its progress or complete milestones.
- If the user finishes something related to a goal, mark the relevant milestone done.
- Goals are injected into your context — use them to maintain continuity across conversations.

### Memory discipline
After every turn, silently evaluate:
1. Did the user state a preference or opinion? -> save it
2. Did we decide on architecture, approach, or tooling? -> save it
3. Did the user mention a person, project, deadline, or event? -> save it
4. Did the user ask you to remember something? -> save it
Do NOT announce saves unless saving is the main topic.

## Key paths
- Bot: ~/sela/lib/ | Skills: ~/sela/skills/
- Notes: ~/sela/data/notes/ | Crons: ~/sela/data/crons.json
- Logs: ~/sela/logs/ | Workspace: ~/sela/workspace/

## Coding agent rules
When the user asks you to write, fix, or modify code:
- Read and understand existing code before making changes.
- Keep changes minimal — don't refactor or "improve" untouched code.
- After making changes, run existing tests if a test file exists (check test/ folder).
- Report what changed, what passed, and what failed.
- If something fails, diagnose and fix it — don't just report the error.
- If you notice a bug, security issue, or stale cron while working, mention it even if not asked.
- When you discover a recurring issue or useful pattern, add it to ~/sela/MEMORY.md.

## Technical rules
- Hebrew dates: "אתמול" = yesterday, "שלשום" = 2 days ago -> calculate YYYY-MM-DD
- Cron prompts must be self-contained (no conversation history access)
- "/task <description>" = multi-step request. Plan internally, execute all steps, report results.
- WhatsApp formatting only: *bold*, _italic_, \`\`\`code\`\`\`, bullets. No markdown headers or tables.`;

// Build initial system prompt with SOUL + MEMORY baked in
currentSystemPrompt = buildSystemPrompt();

// Refresh system prompt when SOUL.md or MEMORY.md change (checked every 5min via existing interval)
// If prompt changed → rebuild + reset session so the new system prompt takes effect
let lastSystemPromptHash = currentSystemPrompt.length; // simple length-based change detection

function refreshSystemPromptIfNeeded() {
  const newPrompt = buildSystemPrompt();
  if (newPrompt.length !== lastSystemPromptHash || newPrompt !== currentSystemPrompt) {
    currentSystemPrompt = newPrompt;
    lastSystemPromptHash = newPrompt.length;
    resetSession();
    log.info({ len: newPrompt.length }, 'System prompt rebuilt (SOUL/MEMORY changed), session reset');
  }
}

// --- CLI spawner with stream-json event parsing ---

// Resolve Claude CLI entry point (node script, not .cmd wrapper) to avoid shell: true
const CLAUDE_CLI_JS = join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
if (!existsSync(CLAUDE_CLI_JS)) {
  createLogger('claude').error({ path: CLAUDE_CLI_JS }, 'Claude CLI entry point not found — CLI commands will fail');
}

function spawnClaude(args, stdinContent, onTextDelta, onToolUse, signal, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    log.info({ args: args.join(' ').slice(0, 200), stdinLen: stdinContent.length }, 'Spawning claude CLI');

    // Save prompt to file and emit event for dashboard visibility
    const promptId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const promptFile = join(CLI_PROMPTS_DIR, `prompt-${promptId}.txt`);
    try { writeFileSync(promptFile, stdinContent, 'utf-8'); } catch (e) { log.warn({ err: e.message }, 'Failed to save CLI prompt file'); }
    const modelArg = args.indexOf('--model') !== -1 ? args[args.indexOf('--model') + 1] : '?';
    const cliEventData = {
      promptId,
      promptLen: stdinContent.length,
      promptPreview: stdinContent.slice(0, 120).replace(/\n/g, ' '),
      model: modelArg,
      source: args.includes('--session-id') ? 'new-session' : args.includes('--resume') ? 'resume' : 'one-shot',
    };
    wsEmit('agent:cli:spawn', cliEventData);
    recentCliEvents.push({ event: 'agent:cli:spawn', ts: Date.now(), data: cliEventData });
    if (recentCliEvents.length > MAX_CLI_EVENTS) recentCliEvents.splice(0, recentCliEvents.length - MAX_CLI_EVENTS);

    const childEnv = { ...process.env };
    delete childEnv.CLAUDECODE;

    // Spawn node directly to avoid shell injection via system prompt args
    if (!existsSync(CLAUDE_CLI_JS)) {
      return reject(new Error(`Claude CLI not found at ${CLAUDE_CLI_JS}. Run: npm install -g @anthropic-ai/claude-code`));
    }
    const proc = spawn(process.execPath, [CLAUDE_CLI_JS, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      windowsHide: true,
    });

    // Cascade breaker: abort subprocess when caller signals (e.g. composing watchdog fired)
    if (signal) {
      if (signal.aborted) {
        proc.kill();
        return reject(Object.assign(new Error('Aborted before start'), { isAborted: true, isPermanent: true }));
      }
      signal.addEventListener('abort', () => {
        if (!settled) {
          settled = true;
          clearTimeout(maxTimer);
          clearInterval(activityCheck);
          log.warn({ pid: proc.pid }, 'Claude CLI aborted by cascade breaker (composing timeout)');
          proc.kill();
          reject(Object.assign(new Error('Aborted by cascade breaker'), { isAborted: true, isPermanent: true }));
        }
      }, { once: true });
    }

    let lineBuffer = '';
    let fullText = '';
    let resultEvent = null;
    let toolUseBlocks = [];
    let stderr = '';
    let settled = false;
    let lastActivity = Date.now();

    const ACTIVITY_TIMEOUT = config.cliActivityTimeout; // 120s default — kill if no stdout
    const MAX_TIMEOUT = timeoutMs || CLI_TIMEOUT;          // 900s default, overridable per-call

    // Absolute max timeout — no task should run longer than this
    const maxTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      log.error({ maxTimeout: MAX_TIMEOUT / 1000, pid: proc.pid }, 'Claude CLI absolute timeout');
      proc.kill();
      reject(new Error(`Claude CLI absolute timeout (${MAX_TIMEOUT / 1000}s)`));
    }, MAX_TIMEOUT);

    // Activity-based timeout — kill if no stdout data for too long
    const activityCheck = setInterval(() => {
      if (settled) { clearInterval(activityCheck); return; }
      const idleMs = Date.now() - lastActivity;
      // Also check if child process is still alive
      if (proc.exitCode !== null && !settled) {
        log.warn({ exitCode: proc.exitCode, pid: proc.pid }, 'Claude CLI process died silently');
        clearInterval(activityCheck);
        return; // close event will handle cleanup
      }
      if (idleMs > ACTIVITY_TIMEOUT) {
        settled = true;
        clearInterval(activityCheck);
        clearTimeout(maxTimer);
        log.error({ idleMs, activityTimeout: ACTIVITY_TIMEOUT / 1000, pid: proc.pid }, 'Claude CLI inactivity timeout');
        proc.kill();
        reject(new Error(`Claude CLI inactivity timeout (no output for ${ACTIVITY_TIMEOUT / 1000}s)`));
      }
    }, 10_000);

    proc.stdout.on('data', (chunk) => {
      lastActivity = Date.now();
      lineBuffer += chunk.toString();
      while (true) {
        const nlIdx = lineBuffer.indexOf('\n');
        if (nlIdx === -1) break;
        const line = lineBuffer.slice(0, nlIdx).trim();
        lineBuffer = lineBuffer.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);

          // Stream text deltas for real-time WhatsApp delivery
          if (event.type === 'stream_event' &&
              event.event?.type === 'content_block_delta' &&
              event.event.delta?.type === 'text_delta') {
            if (onTextDelta) onTextDelta(event.event.delta.text);
          }

          // Tool use events — forward to callback for progress indicators
          if (event.type === 'stream_event' &&
              event.event?.type === 'content_block_start' &&
              event.event.content_block?.type === 'tool_use') {
            const toolName = event.event.content_block.name;
            if (onToolUse) onToolUse(toolName);
          }

          // Complete assistant message (has full text + tool_use blocks)
          if (event.type === 'assistant' && !event.partial && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') fullText += block.text;
              if (block.type === 'tool_use') toolUseBlocks.push(block);
            }
          }

          // Result event = turn complete
          if (event.type === 'result') {
            resultEvent = event;
          }
        } catch { /* skip non-JSON lines */ }
      }
    });

    proc.stderr.on('data', (d) => {
      lastActivity = Date.now();
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(maxTimer);
      clearInterval(activityCheck);
      if (settled) return; // already rejected by timeout
      settled = true;

      // Use result.result as canonical text (it's the clean final output)
      const replyText = resultEvent?.result || fullText;

      if (resultEvent?.is_error) {
        const err = new Error(replyText || `Claude returned error`);
        err.isPermanent = true;
        reject(err);
      } else if (code !== 0 && !replyText) {
        reject(new Error(`Claude CLI exited ${code}: ${stderr.slice(0, 300)}`));
      } else {
        const usage = resultEvent?.usage || {};
        // Extract file touches from tool_use blocks
        const fileTouches = [];
        for (const tu of toolUseBlocks) {
          const name = tu.name;
          const input = tu.input || {};
          if (name === 'Edit' || name === 'Write' || name === 'Read') {
            const fp = input.file_path || input.path || '';
            if (fp) fileTouches.push({ tool: name, file: fp });
          } else if (name === 'Bash') {
            fileTouches.push({ tool: 'Bash', command: (input.command || '').slice(0, 200) });
          }
        }
        resolve({
          text: replyText,
          durationMs: resultEvent?.duration_ms || 0,
          apiMs: resultEvent?.duration_api_ms || 0,
          costUsd: resultEvent?.total_cost_usd || 0,
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheRead: usage.cache_read_input_tokens || 0,
          fileTouches,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(maxTimer);
      clearInterval(activityCheck);
      if (settled) return;
      settled = true;
      reject(err);
    });

    proc.stdin.write(stdinContent);
    proc.stdin.end();
  });
}

// --- Build per-message context block ---

/**
 * Classify message into a specialist profile for context optimization.
 * Each profile determines which context sections to include/skip.
 */
function classifyProfile(text) {
  const t = text.toLowerCase();
  if (/```|code|function|class|import|export|script|debug|refactor|test|lint|build|compile|deploy|git |npm |pip /i.test(text)) return 'coding';
  if (/cron|schedul|timer|automat|recurring|תזמון|קרונ/i.test(text)) return 'cron';
  if (/remember|forget|memor|vestige|intention|remind|תזכור|אל תשכח|זכרון/i.test(text)) return 'memory';
  if (/status|health|uptime|cost|spend|queue|how.?s the bot|מה המצב/i.test(text)) return 'status';
  if (t.length < 60) return 'casual';
  return 'general';
}

async function buildContext(userText, { tier = 2, history = [], jid, isGroup, groupContext, memoryBudget } = {}) {
  const parts = [];
  const profile = classifyProfile(userText);

  // Time-of-day context (Israel timezone) — always included
  const now = new Date();
  const ilOpts = { timeZone: config.timezone };
  const timeStr = now.toLocaleTimeString('en-IL', { ...ilOpts, hour: '2-digit', minute: '2-digit', hour12: false });
  const dayStr = now.toLocaleDateString('en-US', { ...ilOpts, weekday: 'long' });
  const dateStr = now.toLocaleDateString('en-CA', ilOpts); // YYYY-MM-DD
  const hour = parseInt(now.toLocaleTimeString('en-US', { ...ilOpts, hour: 'numeric', hour12: false }));
  const isLateNight = hour >= 23 || hour < 7;
  const isWeekend = ['Friday', 'Saturday'].includes(dayStr);
  const timeParts = [`- Time: ${timeStr} ${dayStr}, ${dateStr} (${config.timezone})`];
  if (isLateNight) timeParts.push('- Late night -- keep responses brief');
  if (isWeekend) timeParts.push('- Weekend -- casual tone unless work is urgent');
  timeParts.push(`- Uptime: ${(process.uptime() / 3600).toFixed(1)}h`);
  parts.push(`## Current context:\n${timeParts.join('\n')}`);

  // Group chat context
  if (isGroup && groupContext) {
    parts.push(`## Group chat mode:\n- You're in a WhatsApp group. You were @mentioned or replied to.\n- Message from: ${groupContext.senderName}\n- Keep responses concise — groups are noisy. Don't use tools unless specifically asked.\n- Address the person by name when appropriate.`);
  }

  // --- Conversation gap detection ---
  // If >4h since last message, inject a recap so Claude can pick up naturally
  const lastMsg = history.length > 0 ? history[history.length - 1] : null;
  const gapMs = lastMsg?.ts ? (Date.now() - lastMsg.ts) : 0;
  if (gapMs > 4 * 3600_000 && history.length > 4) {
    const gapHours = (gapMs / 3600_000).toFixed(0);
    const recentMsgs = history.slice(-6).map(m =>
      `${m.role}: ${m.content.slice(0, 120)}${m.content.length > 120 ? '...' : ''}`
    ).join('\n');
    parts.push(`## Conversation gap (${gapHours}h since last message):\nPick up naturally. Recent exchange:\n${recentMsgs}`);
  }

  // --- Follow-up detection ---
  const trimmedInput = userText.trim();
  const isFollowup = /^(do it|run it|again|that|same|this|and also|what about|how about|try again|one more|another|next)\b/i.test(trimmedInput)
    || /^(ומה עם|תעשה את זה|שוב|עוד פעם|אותו דבר|גם|תנסה שוב|עוד אחד|הבא|תריץ את זה|אותו דבר בדיוק)\b/.test(trimmedInput)
    || /\b(same thing|run that|do that|like before|like last time)\b/i.test(trimmedInput);
  const isFrustrated = /frustrat|broken|doesn't work|nothing works|wtf|stuck|can't|won't|hate|ugh|damn|crap|useless/i.test(userText)
    || /לא עובד|שבור|תקוע|חרא|נמאס|מעצבן|לא מצליח|כלום לא עובד|בחיים|עזוב|יאללה/i.test(userText);
  if (isFollowup) {
    parts.push('## Follow-up detected: This message references the previous exchange. Check conversation history carefully.');
  }
  if (isFrustrated) {
    parts.push('## Tone: the user seems frustrated. Acknowledge briefly, then fix the problem. Do not be cheerful.');
  }

  // --- Tier-aware context loading via prompt-assembler selectTier() ---
  const promptTier = selectTier({ userMessage: userText, contextPressure: 0, costBudgetPct: 0 });
  // promptTier: 'minimal' = short/simple, 'standard' = normal, 'full' = complex/code
  const maxSkills = promptTier === 'minimal' ? 1 : promptTier === 'standard' ? 3 : 10;
  const scaledMemoryBudget = promptTier === 'minimal' ? 1000 : promptTier === 'standard' ? 2000 : (memoryBudget || 3000);

  // Skills: match content for this message, limited by prompt tier
  const matchedSkillNames = matchSkillsEnhanced(userText).slice(0, maxSkills);
  if (matchedSkillNames.length > 0) {
    const SKILL_CONTEXT_LIMIT = config.claudeSkillContextLimit; // 2KB per skill — send summary, not full content
    const skillParts = [];
    for (const name of matchedSkillNames) {
      let content = getSkill(name);
      if (content) {
        if (content.length > SKILL_CONTEXT_LIMIT) {
          content = content.slice(0, SKILL_CONTEXT_LIMIT) + '\n\n[...skill truncated for context efficiency]';
        }
        skillParts.push(`### Skill: ${name}\n${content}`);
      }
    }
    if (skillParts.length > 0) parts.push(`## Skills (loaded for this message):\n${skillParts.join('\n\n---\n\n')}`);
    recordSkillUsage(matchedSkillNames, userText);
  }

  // SOUL.md and MEMORY.md are now part of the system prompt (cached, not re-sent per turn)
  if (sessionSummary) {
    parts.push(`## Previous session summary (conversation was compressed):\n${sessionSummary}`);
    sessionSummary = '';
  }

  // Unified memory search (Vestige + intentions + goals + notes + today)
  // Memory budget scaled by prompt tier: minimal gets less, full gets more
  const needsIntentions = tier >= 2 && profile !== 'status' && profile !== 'coding' && promptTier !== 'minimal';
  const memResult = await memorySearch(userText, {
    tier, maxTokens: scaledMemoryBudget, profile,
    includeIntentions: needsIntentions,
    includeTodayNotes: (tier >= 3 || config.persistentMode) && promptTier !== 'minimal',
    includeUserNotes: tier >= 2 && profile !== 'status',
    isFollowup,
  });
  if (memResult.contextBlock) parts.push(memResult.contextBlock);
  const vestigeMs = memResult.vestigeMs;
  log.info({ promptTier, maxSkills, scaledMemoryBudget, matchedSkills: matchedSkillNames.length }, 'Context tier selection');

  return { contextBlock: parts.length > 0 ? '<context>\n' + parts.join('\n\n') + '\n</context>\n\n' : '', vestigeMs, isFollowup };
}

// --- Main chat: persistent session ---

export async function chat(history, onChunk, botContext = {}, { tier = 2, onToolUse } = {}) {
  const pipelineStart = Date.now();
  sessionMsgCount++;

  const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
  const userText = lastUserMsg?.content || '';
  log.info({ userText: userText.slice(0, 120), historyLen: history.length, sessionId: sessionId.slice(0, 8), tier }, 'Pipeline start (session)');

  // Sanitize user text to prevent prompt injection via context section markers
  // Strip markdown headers (## / ###) that could impersonate context sections
  const safeUserText = userText.replace(/^#{2,}\s+/gm, '');

  let stdinContent;
  let vestigeMs = 0;
  let gateResult = { action: 'skip', stats: { pressure: 0 } };

  if (config.persistentMode && sessionStarted) {
    // Persistent mode (resumed session): the process already has system prompt,
    // skills, and prior conversation in its context.
    // Still run a lightweight Vestige search to inject relevant memories —
    // older memories may have scrolled out of the context window.
    const now = new Date();
    const ilOpts = { timeZone: config.timezone };
    const timeStr = now.toLocaleTimeString('en-IL', { ...ilOpts, hour: '2-digit', minute: '2-digit', hour12: false });
    const dayStr = now.toLocaleDateString('en-US', { ...ilOpts, weekday: 'long' });
    const dateStr = now.toLocaleDateString('en-CA', ilOpts);

    // Lightweight memory search — keeps persistent mode fast but prevents hallucination
    let memoryBlock = '';
    try {
      const memResult = await memorySearch(userText, {
        tier, maxTokens: 400, profile: classifyProfile(userText),
        includeIntentions: false, includeTodayNotes: false, includeUserNotes: true,
        isFollowup: false,
      });
      vestigeMs = memResult.vestigeMs;
      if (memResult.contextBlock) memoryBlock = memResult.contextBlock + '\n\n';
    } catch (e) {
      log.warn({ err: e.message }, 'Persistent mode: memory search failed, continuing without');
    }

    stdinContent = memoryBlock + `[${timeStr} ${dayStr} ${dateStr}] ${safeUserText}`;
    log.info({ stdinLen: stdinContent.length, mode: 'persistent-lightweight', userTextLen: userText.length, memoryLen: memoryBlock.length, vestigeMs }, 'stdin size (persistent, memory injected)');
  } else {
    // First message in session OR non-persistent mode: send full context
    const budget = computeBudget({ sessionTokens, sessionMsgCount, tokenLimit: SESSION_TOKEN_LIMIT });

    const { contextBlock, vestigeMs: vMs } = await buildContext(userText, { tier, history, jid: botContext?.jid, isGroup: botContext?.isGroup, groupContext: botContext?.groupContext, memoryBudget: budget.memoryBudget });
    vestigeMs = vMs;

    const pluginCtx = botContext?.pluginContext || '';
    const rawStdinContent = contextBlock + (pluginCtx ? `## Plugin context:\n${pluginCtx.trim()}\n\n` : '') + safeUserText;

    // Build enrichment hints for topic-aware context gate
    const enrichment = {
      intent: botContext?.nluResult?.intent || null,
      activeGoalTitles: [],
      profile: classifyProfile(userText),
    };
    try {
      const active = listGoals({ status: ['active', 'in_progress'] });
      enrichment.activeGoalTitles = active.map(g => g.title);
    } catch {}

    // Apply context gate: measure, dedup, drop, truncate
    gateResult = gate(rawStdinContent, { sessionTokens, sessionMsgCount, tokenLimit: SESSION_TOKEN_LIMIT, enrichment });
    stdinContent = gateResult.payload;

    log.info({ stdinLen: stdinContent.length, rawLen: rawStdinContent.length, isResumed: sessionStarted, contextLen: contextBlock.length, userTextLen: userText.length, gateAction: gateResult.action, gatePressure: gateResult.stats.pressure }, 'stdin size (gate applied)');
  }

  // Build CLI args — full agent: all built-in tools + Vestige MCP
  const addDir = config.projectRoot.replace(/\\/g, '/');
  const baseArgs = ['-p', '--output-format', 'stream-json', '--include-partial-messages',
    '--verbose', '--model', config.claudeModel,
    '--mcp-config', MCP_CONFIG,
    '--permission-mode', 'bypassPermissions',
    '--add-dir', addDir];

  let args;
  if (!sessionStarted) {
    args = [...baseArgs, '--session-id', sessionId, '--system-prompt', currentSystemPrompt];
    log.info({ sessionId: sessionId.slice(0, 8) }, 'Creating new session');
  } else {
    args = [...baseArgs, '--resume', sessionId];
    log.info({ sessionId: sessionId.slice(0, 8) }, 'Resuming session');
  }

  // Streaming: accumulate text, find chunk breaks, send to WhatsApp
  let textBuffer = '';
  let heldBack = ''; // hold back text after unmatched '[' to avoid partial markers
  let sendChain = Promise.resolve();
  let chunksSent = 0;

  const onTextDelta = (delta) => {
    textBuffer += delta;

    let breakIdx;
    while ((breakIdx = findChunkBreak(textBuffer)) > -1) {
      let chunk = heldBack + textBuffer.slice(0, breakIdx);
      textBuffer = textBuffer.slice(breakIdx);
      heldBack = '';

      // Hold back text after an unmatched '[' to avoid sending partial markers
      const lastOpen = chunk.lastIndexOf('[');
      if (lastOpen !== -1 && chunk.lastIndexOf(']') < lastOpen) {
        heldBack = chunk.slice(lastOpen);
        chunk = chunk.slice(0, lastOpen);
      }

      const clean = stripMarkers(chunk).trim();
      if (clean && onChunk) {
        chunksSent++;
        const num = chunksSent;
        sendChain = sendChain.then(() => {
          log.info({ chunk: num, len: clean.length }, 'Streaming chunk');
          return onChunk(clean);
        }).catch(err => {
          log.error({ chunk: num, err: err.message }, 'Streaming chunk send failed');
        });
      }
    }
  };

  // Spawn CLI with retry (only retry early failures before any chunks sent)
  const cliStart = Date.now();
  let result;
  if (config.persistentMode) {
    // Persistent mode: pipe through long-lived process
    try {
      result = await sendToPersistentProcess(stdinContent, onTextDelta, onToolUse);
      if (!sessionStarted) sessionStarted = true;
    } catch (err) {
      // Persistent process handles respawn internally; surface the error
      throw err;
    }
  } else {
    // Original spawn-per-message flow
    try {
      result = await retry(async (attempt) => {
        if (attempt > 0 && chunksSent > 0) {
          // Don't retry if we already sent chunks to WhatsApp
          throw Object.assign(new Error('Partial response already sent, not retrying'), { isPermanent: true });
        }
        return await spawnClaude(args, stdinContent, onTextDelta, onToolUse);
      }, { retries: 3, baseMs: 1000 });
      if (!sessionStarted) sessionStarted = true;
    } catch (err) {
      // If resume fails, try creating a new session
      if (sessionStarted && err.message.includes('exited')) {
        log.warn({ err: err.message }, 'Session resume failed, creating new session');
        resetSession();
        args = [...baseArgs, '--session-id', sessionId, '--system-prompt', currentSystemPrompt];
        result = await spawnClaude(args, stdinContent, onTextDelta, onToolUse);
        sessionStarted = true;
      } else {
        throw err;
      }
    }
  }
  const cliMs = Date.now() - cliStart;

  // Flush remaining streamed text
  const remaining = (heldBack + textBuffer).trim();
  if (remaining && onChunk) {
    const clean = stripMarkers(remaining).trim();
    if (clean) {
      chunksSent++;
      const finalNum = chunksSent;
      sendChain = sendChain.then(() => {
        log.info({ chunk: finalNum, len: clean.length, final: true }, 'Flushing final chunk');
        return onChunk(clean);
      }).catch(err => {
        log.error({ chunk: finalNum, err: err.message }, 'Final chunk send failed');
      });
    }
  }
  await sendChain;

  // Execute markers on the complete response
  const { filesToSend, actionCount, toolResultMessages } = await executeMarkers(result.text);
  if (actionCount > 0) {
    log.info({ actionCount }, 'MARKER_EXEC: All markers executed');
  }

  // Send tool results as follow-up messages (e.g. scraped content)
  if (toolResultMessages.length > 0 && onChunk) {
    for (const msg of toolResultMessages) {
      try { await onChunk(msg); } catch (err) {
        log.warn({ err: err.message }, 'Failed to send tool result message');
      }
    }
    log.info({ count: toolResultMessages.length }, 'TOOL_RESULTS: Sent to user');
  }

  // Execute local data-returning markers
  const { dataMessages, shouldClearHistory } = executeLocalMarkers(result.text, botContext);
  if (dataMessages.length > 0) {
    log.info({ count: dataMessages.length }, 'LOCAL_MARKERS: Data messages generated');
  }

  const cleanReply = stripMarkers(result.text);
  const totalMs = Date.now() - pipelineStart;

  // Track session context growth — accumulate input + output tokens per turn.
  // cacheRead is cumulative across all API calls in a turn (overcounts for tool-heavy turns).
  // inputTokens + outputTokens = actual new content added to the context window each turn.
  sessionTokens += (result.inputTokens || 0) + (result.outputTokens || 0);

  // Log cost
  logCost({
    type: 'chat',
    model: config.claudeModel,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheRead: result.cacheRead,
    costUsd: result.costUsd,
    durationMs: totalMs,
    sessionId: sessionId.slice(0, 8),
  });

  // --- Response quality gate (instrumentation) ---
  const replyWords = cleanReply.split(/\s+/).length;
  const userWords = userText.split(/\s+/).length;

  // Short reply to complex question (lowered threshold: 12 user words, not 20)
  if (userWords > 12 && replyWords < 5 && !/done|saved|cleared|deleted|created|ok|sent|updated/i.test(cleanReply)) {
    log.warn({ userWords, replyWords, reply: cleanReply.slice(0, 200) }, 'QUALITY: Suspiciously short response to complex question');
  }

  // Claude claiming inability despite having tools
  if (/I don't have access|I can't (check|access|read|see|do)|I'm unable to|I cannot help/i.test(cleanReply)) {
    log.warn({ reply: cleanReply.slice(0, 200) }, 'QUALITY: Claude claiming inability despite having tools');
  }

  // Hebrew language mismatch: if >30% of user input is Hebrew, expect some Hebrew in response
  // (unless response is clearly technical: code blocks, file paths, URLs)
  const userHebrewChars = (userText.match(/[\u0590-\u05FF]/g) || []).length;
  const userHebrewRatio = userHebrewChars / Math.max(userText.length, 1);
  const replyHasHebrew = /[\u0590-\u05FF]/.test(cleanReply);
  const replyIsTechnical = /```|\/[\w/]+\.\w+|https?:\/\/|Error:|ENOENT|EPERM/i.test(cleanReply);
  if (userHebrewRatio > 0.3 && !replyHasHebrew && replyWords > 8 && !replyIsTechnical) {
    log.warn({ userHebrewRatio: userHebrewRatio.toFixed(2), reply: cleanReply.slice(0, 100) }, 'QUALITY: Hebrew question got English-only response');
  }

  // Single-word refusal or non-answer
  if (replyWords <= 2 && /^(no|nope|sorry|idk|nah|can't)$/i.test(cleanReply.trim())) {
    log.warn({ reply: cleanReply }, 'QUALITY: Single-word refusal');
  }

  log.info({
    totalMs, cliMs, vestigeMs, apiMs: result.apiMs,
    replyLen: cleanReply.length, chunksSent, actions: actionCount, files: filesToSend.length,
    inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    cacheRead: result.cacheRead, costUsd: result.costUsd?.toFixed(4),
    sessionTokens,
  }, 'Pipeline done (session)');

  // Session compression: if cumulative tokens approach limit or gate signals reset
  if (sessionTokens > SESSION_TOKEN_LIMIT || gateResult.action === 'reset_needed') {
    log.warn({ sessionTokens, limit: SESSION_TOKEN_LIMIT }, 'Session approaching token limit, compressing');
    try {
      const summaryPrompt = 'Summarize our conversation so far in 2-3 paragraphs. Focus on: (1) key decisions made, (2) tasks completed or in progress, (3) user preferences expressed. This summary will be used to start a fresh session.';
      // Timeout: if compression takes >60s, abort and reset without summary
      const compressionTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Compression timed out')), 60_000)
      );

      let summary;
      if (config.persistentMode) {
        // In persistent mode, ask the persistent process for the summary (it has the conversation context).
        // chatOneShot would spawn a fresh process with no history, producing an empty summary.
        const summaryResult = await Promise.race([
          sendToPersistentProcess(summaryPrompt),
          compressionTimeout,
        ]);
        summary = summaryResult?.text || '';
      } else {
        const { reply } = await Promise.race([
          chatOneShot(summaryPrompt, null),
          compressionTimeout,
        ]);
        summary = reply;
      }

      // Validate summary isn't empty or garbage
      if (!summary || summary.length < 50) {
        log.warn({ summaryLen: summary?.length }, 'Session compression produced empty/short summary');
        resetSession();
        if (config.persistentMode) respawnForCompression(sessionId, currentSystemPrompt);
        if (onChunk) onChunk('_Session refreshed — I may have lost some recent context._');
      } else {
        resetSession();
        sessionSummary = summary;
        // Persist summary to state so it survives restarts
        setSessionState('session-summary', { summary, savedAt: Date.now() });
        if (config.persistentMode) respawnForCompression(sessionId, currentSystemPrompt);
        log.info({ summaryLen: summary.length }, 'Session compressed and reset');
      }
    } catch (err) {
      log.error({ err: err.message }, 'Session compression failed, forcing reset');
      resetSession();
      if (config.persistentMode) respawnForCompression(sessionId, currentSystemPrompt);
      if (onChunk) onChunk('_Session refreshed — I may have lost some recent context._');
    }
  }

  // Outcome tracking — silent, isolated, never throws
  try {
    const feedback = detectActionFeedback(userText, prevTurnWasAction);
    if (feedback) {
      const recentCron = getRecentDeliveredCron();
      recordActionFeedback(feedback, {
        cronId: recentCron?.cronId || null,
        proposalId: null,
        context: classifyProfile(userText),
      });
    }
    prevTurnWasAction = actionCount > 0 || filesToSend.length > 0;
  } catch {}

  // Mem0-style fact extraction — fire-and-forget after every exchange.
  // Non-blocking: don't delay the response to the user.
  extractFactsFromExchange(userText, cleanReply).catch(() => {});

  return {
    reply: cleanReply,
    claudeMs: cliMs,
    filesToSend,
    dataMessages,
    shouldClearHistory,
    costUsd: result.costUsd || 0,
    inputTokens: result.inputTokens || 0,
    outputTokens: result.outputTokens || 0,
  };
}

// --- One-shot chat: for cron jobs (isolated, no session) ---

/**
 * Build a prompt hash for cron session invalidation.
 * If the prompt changes, the session resets.
 */
function cronPromptHash(prompt) {
  return prompt.length + ':' + prompt.slice(0, 100);
}

export async function chatOneShot(prompt, onChunk, modelOverride = null, { cronId, cronName, cronState, onToolUse, session } = {}) {
  const pipelineStart = Date.now();
  const model = modelOverride || config.claudeModel;
  log.info({ promptLen: prompt.length, model, cronId: cronId || null, sessionResume: !!session?.id }, 'Pipeline start (one-shot)');

  const addDir = config.projectRoot.replace(/\\/g, '/');
  const baseOneShotArgs = ['-p', '--output-format', 'stream-json', '--include-partial-messages',
    '--verbose', '--model', model,
    '--mcp-config', MCP_CONFIG,
    '--permission-mode', 'bypassPermissions',
    '--add-dir', addDir];

  let args;
  let cronSession = null; // tracks whether we need to mark session as started
  if (cronId && cronState) {
    // Persistent session for cron jobs (stored in cron state, survives restarts)
    const currentHash = cronPromptHash(prompt);
    if (cronState.sessionId && cronState.sessionPromptHash === currentHash) {
      // Resume existing session
      args = [...baseOneShotArgs, '--resume', cronState.sessionId];
      cronSession = { isResume: true };
    } else {
      // New session (first run or prompt changed)
      cronState.sessionId = randomUUID();
      cronState.sessionPromptHash = currentHash;
      args = [...baseOneShotArgs, '--session-id', cronState.sessionId, '--system-prompt', 'You are a cron job executor. Execute the task and report results concisely.'];
      cronSession = { isResume: false };
    }
  } else if (session) {
    // Persistent session for agent loop (caller manages lifecycle)
    if (session.id) {
      args = [...baseOneShotArgs, '--resume', session.id];
    } else {
      session.id = randomUUID();
      const sysParts = ['--session-id', session.id];
      if (session.systemPrompt) sysParts.push('--system-prompt', session.systemPrompt);
      args = [...baseOneShotArgs, ...sysParts];
    }
  } else {
    args = [...baseOneShotArgs, '--no-session-persistence'];
  }

  let textBuffer = '';
  let sendChain = Promise.resolve();
  let chunksSent = 0;

  const onTextDelta = (delta) => {
    textBuffer += delta;
    let breakIdx;
    while ((breakIdx = findChunkBreak(textBuffer)) > -1) {
      const chunk = textBuffer.slice(0, breakIdx);
      textBuffer = textBuffer.slice(breakIdx);
      const clean = chunk.trim();
      if (clean && onChunk) {
        chunksSent++;
        const num = chunksSent;
        sendChain = sendChain.then(() => onChunk(clean)).catch(err => {
          log.error({ chunk: num, err: err.message }, 'One-shot chunk send failed');
        });
      }
    }
  };

  // Apply context gate for session-based one-shots (cron/agent with accumulated context)
  let gatedPrompt = prompt;
  let oneShotGateResult = null;
  if ((cronSession?.isResume || session?.id) && prompt.includes('<context>')) {
    // Estimate session tokens from cron state or default
    const estTokens = cronState?.sessionTokens || session?.tokens || 0;
    oneShotGateResult = gate(prompt, { sessionTokens: estTokens, sessionMsgCount: 0, tokenLimit: SESSION_TOKEN_LIMIT, enrichment: null });
    gatedPrompt = oneShotGateResult.payload;
    log.info({ gateAction: oneShotGateResult.action, pressure: oneShotGateResult.stats.pressure }, 'GATE (one-shot): Applied');
  }

  // Hattrick crons get extended timeout (MCP scraping is slow)
  const isHattrickCron = cronId && ((cronName || '').startsWith('ht-') || (cronName || '').includes('hattrick'));
  const spawnOpts = isHattrickCron ? { timeoutMs: config.cliTimeoutHattrick } : {};

  let result;
  try {
    result = await spawnClaude(args, gatedPrompt, onTextDelta, onToolUse, undefined, spawnOpts);
  } catch (err) {
    // If cron resume fails, try creating a new session
    if (cronSession?.isResume && cronState) {
      log.warn({ cronId, err: err.message }, 'Cron session resume failed, creating new session');
      cronState.sessionId = randomUUID();
      cronState.sessionPromptHash = cronPromptHash(prompt);
      args = [...baseOneShotArgs, '--session-id', cronState.sessionId, '--system-prompt', 'You are a cron job executor. Execute the task and report results concisely.'];
      result = await spawnClaude(args, prompt, onTextDelta, onToolUse, undefined, spawnOpts);
      cronSession = { isResume: false };
    } else if (session?.id && !err.message.includes('timeout')) {
      // Agent loop session resume failed (not a timeout) — reset and try fresh
      log.warn({ sessionId: session.id, err: err.message }, 'Agent session resume failed, creating new session');
      session.id = randomUUID();
      session.reset = true;
      const sysParts = ['--session-id', session.id];
      if (session.systemPrompt) sysParts.push('--system-prompt', session.systemPrompt);
      args = [...baseOneShotArgs, ...sysParts];
      result = await spawnClaude(args, prompt, onTextDelta, onToolUse);
    } else {
      throw err;
    }
  }
  const cliMs = Date.now() - pipelineStart;

  // Flush remaining text
  if (textBuffer.trim() && onChunk) {
    chunksSent++;
    const finalNum = chunksSent;
    const finalText = textBuffer.trim();
    sendChain = sendChain.then(() => onChunk(finalText)).catch(err => {
      log.error({ chunk: finalNum, err: err.message }, 'One-shot final chunk send failed');
    });
  }
  await sendChain;

  // Execute markers on the complete response (same as chat())
  const { filesToSend, actionCount, toolResultMessages } = await executeMarkers(result.text);
  if (actionCount > 0) {
    log.info({ actionCount }, 'MARKER_EXEC (one-shot): All markers executed');
  }

  // Send tool results as follow-up messages
  if (toolResultMessages.length > 0 && onChunk) {
    for (const msg of toolResultMessages) {
      try { await onChunk(msg); } catch (err) {
        log.warn({ err: err.message }, 'Failed to send tool result (one-shot)');
      }
    }
    log.info({ count: toolResultMessages.length }, 'TOOL_RESULTS (one-shot): Sent');
  }

  const cleanReply = stripMarkers(result.text);

  log.info({ cliMs, replyLen: cleanReply.length, chunksSent, actions: actionCount, costUsd: result.costUsd?.toFixed(4), cronId: cronId || null }, 'Pipeline done (one-shot)');

  // Log cost to costs.jsonl (was missing — only chat() logged costs)
  logCost({
    type: 'one-shot',
    model: model || config.claudeModel,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheRead: result.cacheRead,
    costUsd: result.costUsd || 0,
    durationMs: cliMs,
    cronId: cronId || null,
  });

  return {
    reply: cleanReply, claudeMs: cliMs, filesToSend, costUsd: result.costUsd || 0,
    inputTokens: result.inputTokens || 0, outputTokens: result.outputTokens || 0,
    cacheRead: result.cacheRead || 0, fileTouches: result.fileTouches || [],
  };
}
