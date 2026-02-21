import { spawn } from 'child_process';
import { readFileSync, appendFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join, resolve } from 'path';
import config from './config.js';
import { sendToPersistentProcess, respawnForCompression } from './claude-persistent.js';
import { getSkill, listSkills } from './skills.js';
import { createLogger } from './logger.js';
import { searchMemories, checkIntentions, listIntentions } from './mcp-gateway.js';
import { getCronSummary, addCron, deleteCron, toggleCron, runCronNow, listCrons } from './crons.js';
import { getGoalsContext, matchGoalByTopic } from './goals.js';
import { retry, classifyError } from './resilience.js';
import { recordCostEntry } from './cost-analytics.js';
import { getState as getSessionState, setState as setSessionState } from './state.js';
import { getTodayNotes } from './daily-notes.js';
import { getRecentTopics } from './history.js';
import { getNotesContext as getUserNotesContext } from './user-notes.js';
import { detectActionFeedback, recordActionFeedback, getRecentDeliveredCron } from './outcome-tracker.js';
import { rankResults, getCoreMemories } from './memory-tiers.js';

const log = createLogger('claude');
// Claude Code stores project memory at ~/.claude/projects/<encoded-project-path>/memory/MEMORY.md
const PROJECT_DIR = resolve(homedir(), 'whatsapp-claude');
const ENCODED_PROJECT = PROJECT_DIR.replace(/[:/\\]/g, '-').replace(/^-/, '');
const MEMORY_PATH = join(homedir(), '.claude', 'projects', ENCODED_PROJECT, 'memory', 'MEMORY.md');
const SOUL_PATH = join(homedir(), 'whatsapp-claude', 'SOUL.md');
const BOT_MEMORY_PATH = join(homedir(), 'whatsapp-claude', 'MEMORY.md');
const MCP_CONFIG = join(homedir(), 'whatsapp-claude', 'mcp-config.json');
const CLI_TIMEOUT = config.cliTimeout;

// --- Vestige result truncation (token optimization) ---
const MAX_RESULT_CHARS = 150;

function truncateResults(raw) {
  if (!raw) return '';
  return raw.split('\n').map(line => {
    if (line.length > MAX_RESULT_CHARS) return line.slice(0, MAX_RESULT_CHARS) + '\u2026';
    return line;
  }).join('\n');
}

// --- Intention cache (5-minute TTL, token optimization) ---
let _intentionCache = { data: null, ts: 0 };
const INTENTION_CACHE_TTL = 5 * 60_000; // 5 minutes

async function getCachedIntentions() {
  if (_intentionCache.data && Date.now() - _intentionCache.ts < INTENTION_CACHE_TTL) {
    return _intentionCache.data;
  }
  const data = await listIntentions('active', 10);
  _intentionCache = { data, ts: Date.now() };
  return data;
}

// --- Cost tracking ---

const COSTS_FILE = join(homedir(), 'whatsapp-claude', 'data', 'costs.jsonl');
mkdirSync(join(homedir(), 'whatsapp-claude', 'data'), { recursive: true });

function logCost(entry) {
  try {
    appendFileSync(COSTS_FILE, JSON.stringify({ ...entry, ts: Date.now() }) + '\n');
    recordCostEntry(entry.costUsd);
  } catch {}
}

// --- Persistent session with compression ---

const SESSION_TOKEN_LIMIT = 150_000; // Compress at 75% of 200K context
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
  log.info({ sessionId }, 'Session reset');
}

export function getSessionId() { return sessionId; }
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
  try {
    const sm = statSync(SOUL_PATH).mtimeMs;
    if (sm !== soulMtime) { soul = loadFile(SOUL_PATH, 'SOUL.md') || soul; soulMtime = sm; }
  } catch {}
  try {
    const mm = statSync(MEMORY_PATH).mtimeMs;
    if (mm !== memoryMtime) { memory = loadFile(MEMORY_PATH, 'MEMORY.md') || memory; memoryMtime = mm; }
  } catch {}
  try {
    const bm = statSync(BOT_MEMORY_PATH).mtimeMs;
    if (bm !== botMemoryMtime) { botMemory = loadFile(BOT_MEMORY_PATH, 'Bot MEMORY.md') || botMemory; botMemoryMtime = bm; }
  } catch {}
  // Rebuild static context (goals/crons/skills) if changed
  refreshStaticContextIfNeeded();
  // Rebuild system prompt if SOUL/MEMORY/static-context changed
  refreshSystemPromptIfNeeded();
}, 5 * 60_000);

export function reloadSkills() {
  log.info('Skills reloaded from disk');
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

const ALL_MARKERS_RE = /\[(CRON_ADD|CRON_DELETE|CRON_TOGGLE|CRON_RUN|SEND_FILE):[^\]]*\]/gs;
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

  for (const action of actions) {
    try {
      log.info({ type: action.type }, 'MARKER_EXEC: Executing');
      await action.fn();
      log.info({ type: action.type }, 'MARKER_EXEC: Done');
    } catch (err) {
      log.error({ type: action.type, err: err.message }, 'MARKER_EXEC: Failed');
    }
  }

  return { filesToSend, actionCount: actions.length };
}

function stripMarkers(text) {
  return text.replace(ALL_MARKERS_RE, '').replace(LOCAL_MARKERS_RE, '').replace(/\n{3,}/g, '\n\n').trim();
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

  // Goals
  try {
    const goalsCtx = getGoalsContext();
    if (goalsCtx) parts.push(`## Active goals:\n${goalsCtx}`);
  } catch {}

  // Cron summary
  try {
    const cronJobs = listCrons();
    if (cronJobs.length > 0) {
      parts.push(`## Cron jobs:\n${getCronSummary()}`);
    }
  } catch {}

  // Skill names (content injected per-turn only when matched)
  try {
    const names = listSkills();
    if (names.length > 0) {
      parts.push(`## Available skills (use get_skill MCP tool or ask to load one):\n${names.join(', ')}`);
    }
  } catch {}

  // Recent topics (slow-changing, not per-turn)
  // Note: getRecentTopics needs a jid, but for system prompt we skip it.
  // It's cheap enough to include per-turn if needed, but rarely changes.

  return parts.join('\n\n');
}

function getStaticContextHash() {
  try {
    const goalLen = getGoalsContext()?.length || 0;
    const cronLen = getCronSummary()?.length || 0;
    const skillCount = listSkills().length;
    return `${goalLen}:${cronLen}:${skillCount}`;
  } catch { return '0:0:0'; }
}

export function refreshStaticContextIfNeeded() {
  const newHash = getStaticContextHash();
  if (newHash !== staticContextHash) {
    staticContextBlock = buildStaticContext();
    staticContextHash = newHash;
    log.info({ hash: newHash, len: staticContextBlock.length }, 'Static context rebuilt');
  }
}

// Build on startup
staticContextBlock = buildStaticContext();
staticContextHash = getStaticContextHash();

// --- System prompt (static, set once on session creation) ---

// Dynamic system prompt: base + SOUL.md + MEMORY.md + static context (cached by API)
function buildSystemPrompt() {
  const parts = [BASE_SYSTEM_PROMPT];
  if (soul) parts.push(`\n\n## Soul (personality & rules)\n${soul}`);
  if (memory) parts.push(`\n\n## Memory (MEMORY.md)\n${memory}`);
  if (botMemory) parts.push(`\n\n## Bot Memory (self-updating)\nUpdate ~/whatsapp-claude/MEMORY.md when you discover preferences, patterns, or solutions worth remembering.\n${botMemory}`);
  if (staticContextBlock) parts.push(`\n\n${staticContextBlock}`);
  return parts.join('');
}

let currentSystemPrompt = '';

const BASE_SYSTEM_PROMPT = `You are Claude, Ron's personal AI agent on WhatsApp. Your personality and communication style are defined in the Soul section below.

## Capabilities

### Direct tools (Claude Code built-in)
FULL access to Ron's machine:
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
- *bot_clear_history*, *bot_costs*, *bot_export*

CRITICAL: When Ron asks about bot status, crons, notes, files, skills, costs -- use bot_* MCP tools. Never say "I can't check that."

### Text markers (legacy fallback)
Prefer MCP tools. Markers are parsed from text output and executed by the bot.
- [SEND_FILE: path] -- send a file to WhatsApp
- [CRON_ADD: name | cron-expr | prompt], [CRON_DELETE: id], [CRON_TOGGLE: id], [CRON_RUN: id]
- [BOT_STATUS], [LIST_CRONS], [TODAY_NOTES], [LIST_FILES], [LIST_SKILLS]
- [SEARCH_NOTES:YYYY-MM-DD], [CLEAR_HISTORY]

## Vestige memory
Memories and intentions are pre-fetched into context. For more:
- *search* -- find additional memories
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

When Ron mentions a new project or multi-day objective, consider creating a goal.
When work relates to an existing goal (shown in context), update its progress or milestones.
Goals are injected into your context — use them to maintain continuity across conversations.

### Memory discipline
After every turn, silently evaluate:
1. Did Ron state a preference or opinion? -> save it
2. Did we decide on architecture, approach, or tooling? -> save it
3. Did Ron mention a person, project, deadline, or event? -> save it
4. Did Ron ask you to remember something? -> save it
Do NOT announce saves unless saving is the main topic.

## Key paths
- Bot: ~/whatsapp-claude/lib/ | Skills: ~/whatsapp-claude/skills/
- Notes: ~/whatsapp-claude/data/notes/ | Crons: ~/whatsapp-claude/data/crons.json
- Logs: ~/whatsapp-claude/logs/ | Workspace: ~/whatsapp-claude/workspace/

## Coding agent rules
When Ron asks you to write, fix, or modify code:
- Read and understand existing code before making changes.
- Keep changes minimal — don't refactor or "improve" untouched code.
- After making changes, run existing tests if a test file exists (check test/ folder).
- Report what changed, what passed, and what failed.
- If something fails, diagnose and fix it — don't just report the error.
- If you notice a bug, security issue, or stale cron while working, mention it even if not asked.
- When you discover a recurring issue or useful pattern, add it to ~/whatsapp-claude/MEMORY.md.

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

function spawnClaude(args, stdinContent, onTextDelta, onToolUse) {
  return new Promise((resolve, reject) => {
    log.info({ args: args.join(' ').slice(0, 200), stdinLen: stdinContent.length }, 'Spawning claude CLI');

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

    let lineBuffer = '';
    let fullText = '';
    let resultEvent = null;
    let stderr = '';

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Claude CLI timeout (${CLI_TIMEOUT / 1000}s)`));
    }, CLI_TIMEOUT);

    proc.stdout.on('data', (chunk) => {
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

          // Complete assistant message (has full text)
          if (event.type === 'assistant' && !event.partial && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') fullText += block.text;
            }
          }

          // Result event = turn complete
          if (event.type === 'result') {
            resultEvent = event;
          }
        } catch { /* skip non-JSON lines */ }
      }
    });

    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timeout);

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
        resolve({
          text: replyText,
          durationMs: resultEvent?.duration_ms || 0,
          apiMs: resultEvent?.duration_api_ms || 0,
          costUsd: resultEvent?.total_cost_usd || 0,
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheRead: usage.cache_read_input_tokens || 0,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
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

async function buildContext(userText, { tier = 2, history = [], jid, isGroup, groupContext } = {}) {
  const parts = [];
  const profile = classifyProfile(userText);

  // Time-of-day context (Israel timezone) — always included
  const now = new Date();
  const ilOpts = { timeZone: 'Asia/Jerusalem' };
  const timeStr = now.toLocaleTimeString('en-IL', { ...ilOpts, hour: '2-digit', minute: '2-digit', hour12: false });
  const dayStr = now.toLocaleDateString('en-US', { ...ilOpts, weekday: 'long' });
  const dateStr = now.toLocaleDateString('en-CA', ilOpts); // YYYY-MM-DD
  const hour = parseInt(now.toLocaleTimeString('en-US', { ...ilOpts, hour: 'numeric', hour12: false }));
  const isLateNight = hour >= 23 || hour < 7;
  const isWeekend = ['Friday', 'Saturday'].includes(dayStr);
  const timeParts = [`- Time: ${timeStr} ${dayStr}, ${dateStr} (Asia/Jerusalem)`];
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
    parts.push('## Tone: Ron seems frustrated. Acknowledge briefly, then fix the problem. Do not be cheerful.');
  }

  // --- Tier-aware context loading ---

  // Skills: match content for this message (names are in system prompt)
  const matchedSkillNames = matchSkillsEnhanced(userText);
  if (matchedSkillNames.length > 0) {
    const skillParts = [];
    for (const name of matchedSkillNames) {
      const content = getSkill(name);
      if (content) skillParts.push(`### Skill: ${name}\n${content}`);
    }
    if (skillParts.length > 0) parts.push(`## Skills (loaded for this message):\n${skillParts.join('\n\n---\n\n')}`);
    recordSkillUsage(matchedSkillNames, userText);
  }

  // Vestige: search depth based on tier AND profile
  const vestigeStart = Date.now();
  const skipVestige = profile === 'status' || profile === 'casual' || userText.length < 40;
  const searchLimit = tier >= 3 ? 15 : tier >= 2 ? 10 : 5;
  const needsIntentions = tier >= 2 && profile !== 'status' && profile !== 'coding';
  const [vestigeResults, triggeredIntentions, activeIntentions] = await Promise.all([
    skipVestige ? Promise.resolve('') : searchMemories(userText, { limit: searchLimit }),
    needsIntentions ? checkIntentions({ topics: [userText.slice(0, 200)], current_time: new Date().toISOString() }) : Promise.resolve(''),
    needsIntentions ? getCachedIntentions() : Promise.resolve(''),
  ]);
  const vestigeMs = Date.now() - vestigeStart;
  log.info({ vestigeMs, tier, profile }, 'Context built');

  // SOUL.md and MEMORY.md are now part of the system prompt (cached, not re-sent per turn)
  if (sessionSummary) {
    parts.push(`## Previous session summary (conversation was compressed):\n${sessionSummary}`);
    sessionSummary = '';
  }

  if (vestigeResults) {
    const ranked = rankResults(vestigeResults);
    const coreLines = ranked.t1.map(m => truncateResults(m.text));
    const activeLines = ranked.t2.map(m => truncateResults(m.text));
    if (coreLines.length) parts.push(`## Core memories:\n${coreLines.join('\n')}`);
    if (activeLines.length) parts.push(`## Relevant memories:\n${activeLines.join('\n')}`);
    // T3 archive — omitted from context
  } else {
    const core = getCoreMemories();
    if (core.length) parts.push(`## Core memories:\n${core.join('\n')}`);
  }
  if (triggeredIntentions) parts.push(`## Triggered intentions (act on these):\n${triggeredIntentions}`);
  if (activeIntentions) parts.push(`## Active intentions:\n${activeIntentions}`);

  // Relevant goal for THIS message (general goals list is in system prompt)
  if (tier >= 2 && profile !== 'status' && !isFollowup) {
    try {
      const relevantGoal = matchGoalByTopic(userText);
      if (relevantGoal) {
        const dl = relevantGoal.deadline ? `, deadline: ${new Date(relevantGoal.deadline).toLocaleDateString('en-CA')}` : '';
        const nextMs = relevantGoal.milestones?.find(m => m.status === 'pending');
        parts.push(`## Relevant goal: *${relevantGoal.title}* (${relevantGoal.progress}%${dl})${nextMs ? `\nNext milestone: "${nextMs.title}"` : ''}`);
      }
    } catch {}
  }

  // NOTE: Goals, crons, skill names are now in the system prompt (static context).
  // Only dynamic/per-message content remains here.

  // User notes: tier 2+ and non-status profiles (lightweight — ~1-2K chars max)
  if (tier >= 2 && profile !== 'status') {
    try {
      const userNotes = getUserNotesContext();
      if (userNotes) {
        parts.push(`## Ron's notes:\n${userNotes}`);
      }
    } catch {}
  }

  // Today's notes reference: Tier 3 only (gives Claude context for complex tasks)
  if (tier >= 3) {
    const todayNotes = getTodayNotes();
    if (todayNotes && todayNotes.length > 100) {
      const preview = todayNotes.slice(-500); // last 500 chars of today's notes
      parts.push(`## Today's activity (recent):\n${preview}`);
    }
  }

  return { contextBlock: parts.length > 0 ? '<context>\n' + parts.join('\n\n') + '\n</context>\n\n' : '', vestigeMs, isFollowup };
}

// --- Main chat: persistent session ---

export async function chat(history, onChunk, botContext = {}, { tier = 2, onToolUse } = {}) {
  const pipelineStart = Date.now();
  sessionMsgCount++;

  const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
  const userText = lastUserMsg?.content || '';
  log.info({ userText: userText.slice(0, 120), historyLen: history.length, sessionId: sessionId.slice(0, 8), tier }, 'Pipeline start (session)');

  // Build dynamic context (tier-aware: lighter for simple messages, richer for complex)
  const { contextBlock, vestigeMs } = await buildContext(userText, { tier, history, jid: botContext?.jid, isGroup: botContext?.isGroup, groupContext: botContext?.groupContext });

  // Plugin-injected context (from preChat pipeline)
  const pluginCtx = botContext?.pluginContext || '';

  // Sanitize user text to prevent prompt injection via context section markers
  // Strip markdown headers (## / ###) that could impersonate context sections
  const safeUserText = userText.replace(/^#{2,}\s+/gm, '');

  // Format the message: context + plugin context + user text
  const stdinContent = contextBlock + (pluginCtx ? `## Plugin context:\n${pluginCtx.trim()}\n\n` : '') + safeUserText;

  // Token optimization instrumentation: log stdinContent size for resumed vs new sessions
  log.info({ stdinLen: stdinContent.length, isResumed: sessionStarted, contextLen: contextBlock.length, userTextLen: userText.length }, 'stdin size (double-send check)');

  // Build CLI args — full agent: all built-in tools + Vestige MCP
  const homeDir = homedir().replace(/\\/g, '/');
  const baseArgs = ['-p', '--output-format', 'stream-json', '--include-partial-messages',
    '--verbose', '--model', config.claudeModel,
    '--mcp-config', MCP_CONFIG,
    '--permission-mode', 'bypassPermissions',
    '--add-dir', homeDir];

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
  const { filesToSend, actionCount } = await executeMarkers(result.text);
  if (actionCount > 0) {
    log.info({ actionCount }, 'MARKER_EXEC: All markers executed');
  }

  // Execute local data-returning markers
  const { dataMessages, shouldClearHistory } = executeLocalMarkers(result.text, botContext);
  if (dataMessages.length > 0) {
    log.info({ count: dataMessages.length }, 'LOCAL_MARKERS: Data messages generated');
  }

  const cleanReply = stripMarkers(result.text);
  const totalMs = Date.now() - pipelineStart;

  // Track cumulative session tokens
  sessionTokens += (result.inputTokens || 0) + (result.cacheRead || 0);

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

  // Session compression: if cumulative tokens approach limit, reset session
  if (sessionTokens > SESSION_TOKEN_LIMIT) {
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

export async function chatOneShot(prompt, onChunk, modelOverride = null, { cronId, cronState } = {}) {
  const pipelineStart = Date.now();
  const model = modelOverride || config.claudeModel;
  log.info({ promptLen: prompt.length, model, cronId: cronId || null }, 'Pipeline start (one-shot)');

  const homeDir = homedir().replace(/\\/g, '/');
  const baseOneShotArgs = ['-p', '--output-format', 'stream-json', '--include-partial-messages',
    '--verbose', '--model', model,
    '--mcp-config', MCP_CONFIG,
    '--permission-mode', 'bypassPermissions',
    '--add-dir', homeDir];

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

  let result;
  try {
    result = await spawnClaude(args, prompt, onTextDelta);
  } catch (err) {
    // If cron resume fails, try creating a new session
    if (cronSession?.isResume && cronState) {
      log.warn({ cronId, err: err.message }, 'Cron session resume failed, creating new session');
      cronState.sessionId = randomUUID();
      cronState.sessionPromptHash = cronPromptHash(prompt);
      args = [...baseOneShotArgs, '--session-id', cronState.sessionId, '--system-prompt', 'You are a cron job executor. Execute the task and report results concisely.'];
      result = await spawnClaude(args, prompt, onTextDelta);
      cronSession = { isResume: false };
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
  const { filesToSend, actionCount } = await executeMarkers(result.text);
  if (actionCount > 0) {
    log.info({ actionCount }, 'MARKER_EXEC (one-shot): All markers executed');
  }

  const cleanReply = stripMarkers(result.text);

  log.info({ cliMs, replyLen: cleanReply.length, chunksSent, actions: actionCount, costUsd: result.costUsd?.toFixed(4), cronId: cronId || null }, 'Pipeline done (one-shot)');

  return { reply: cleanReply, claudeMs: cliMs, filesToSend, costUsd: result.costUsd || 0 };
}
