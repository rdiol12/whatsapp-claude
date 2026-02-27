/**
 * Agent Loop — Fully autonomous cycle.
 *
 * Runs every 10min. 14 signal types + compound escalation.
 * Always-think: spawns Phase 2 every 2nd cycle even with zero signals.
 * Goal progression: advances milestones, creates goals, tracks effectiveness.
 * Time-aware: morning planning, evening review prompts.
 * Immediate re-cycle: 2min delay after productive cycles (2+ actions).
 * Compound signals: 3+ low signals escalate to medium.
 *
 * Cost controls: Haiku for all cycles except high/critical signals. $1/day hard budget cap. Backoff after 10 consecutive spawns.
 */

import { statSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getContextStats, getRecentCliEvents } from './claude.js';
import { PersistentProcess } from './claude-persistent.js';
import { createLogger } from './logger.js';
import { getState, setState } from './state.js';
import { listGoals, getStaleGoals, getUpcomingDeadlines, addGoal, updateGoal, completeMilestone, getGoalsContext, getJsonMtime, importJsonChanges } from './goals.js';
import { listCrons } from './crons.js';
import { emit as wsEmit } from './ws-events.js';
import config from './config.js';
import { getCostOverview, rollupOldCosts } from './cost-analytics.js';
import { getDetailedMetrics } from './metrics.js';
import { getMessages } from './history.js';
import { getConnectionStats as getMcpStats } from './mcp-gateway.js';
import { getStaleT1Memories } from './memory-tiers.js';
import { getLowEngagementCrons, recordBotReply, captureUserReaction, formatPatternInsights } from './outcome-tracker.js';
import { getLearningContext } from './agent-learning.js';

import { logError } from './db.js';
import { alertCrash, notify } from './notify.js';
import { israelNow, isQuietHours, todayDateKey, detectGoalProgressTriggers, detectAnomalyTriggers, detectIdleTimeTriggers, detectErrorSpikeSQLite, detectChainOpportunities, detectSelfImprovementOpportunities, correlateSignals, detectPatternObserved, detectPlanStuck, detectModuleSignals, detectTransferDeadlineUrgency } from './agent-signals.js';
import { send as waSend, getStatus as getWaStatus } from './channel-wa.js';
import { routeSend } from './channel-router.js';
import { sendToGroup } from './whatsapp.js';
import { quickGenerateSkill } from './skill-generator.js';
import { executeTool, parseToolCalls, listTools } from './tool-bridge.js';
import { pickMilestone, buildMilestoneBrief, runTests, commitAndReport } from './auto-coder.js';
import { summarizeForAgent as summarizeErrorPatterns } from './error-analytics.js';
import { checkMemory as checkMemoryGuardian, buildMemoryBrief } from './memory-guardian.js';
import { getModuleBriefBuilders, getModuleContextProviders, getModuleSonnetSignalTypes, getModuleStateKeyMaps, checkModuleUrgentWork, getModuleMessageCategories } from './module-loader.js';
import { getBehaviorModifiers } from './behavior-adaptor.js';
import { nimChat } from './nim-client.js';
import { formatReasoningContext, addHypothesis, addEvidence, conclude as concludeHypothesis, pruneOld as pruneReasoningJournal } from './reasoning-journal.js';
import { gateAction } from './confidence-gate.js';
import { ollamaChat, isOllamaAvailable } from './ollama-client.js';
import { initBackends, llmChat, selectFreeBackend, isBackendAvailable, getBackend } from './llm-router.js';
import { formatLearningContext as formatLearningContextSync } from './learning-journal.js';
import { runIfDue as runPainPointAnalysis } from './pain-point-analyzer.js';

const log = createLogger('agent-loop');

const PROJECT_PATHS_HINT = `## Project file paths (use these with file_read/file_write):
- Project root: ./ (current working directory)
- Source code: lib/ (*.js modules)
- Goals: data/goals.json
- Crons: data/crons.json
- User notes: data/user-notes.json
- Conversations: data/conversations.json
- Costs: data/costs.jsonl
- SQLite DB: data/sela.db
- Cycle diffs: data/cycle-diffs/
- Logs: logs/app-YYYY-MM-DD.log
- Skills: skills/ (*.md files)
- State: data/state/`;

const INTERVAL_MS = config.agentLoopInterval || 10 * 60_000;
const ROUTINE_MODEL = config.agentLoopRoutineModel;
const SONNET_MODEL = config.agentLoopSonnetModel;
const STATE_KEY = 'agent-loop';
const MAX_FOLLOWUPS = config.agentLoopMaxFollowups;
const BACKOFF_THRESHOLD = config.agentLoopBackoffThreshold;
const ALWAYS_THINK_EVERY = config.agentLoopAlwaysThinkEvery;
const RECYCLE_DELAY_MS = config.agentLoopRecycleDelay;


const CODE_KEYWORDS = /\b(create|build|implement|write|add|refactor|fix|hook|module|lib\/|\.js|endpoint|function|handler|parser|schema)\b/i;

const MAX_CONSECUTIVE_RECYCLES = 3;

// Signal cooldown durations by urgency (ms) — prevents re-signaling the same issue every cycle
const SIGNAL_COOLDOWN_MS = { low: 3 * 3600_000, medium: 1 * 3600_000, high: 0, critical: 0 };

/** Build a unique key for a signal so we can track cooldowns per-instance */
function signalKey(s) {
  if (s.data?.goalId) return `${s.type}:${s.data.goalId}`;
  if (s.data?.cronId) return `${s.type}:${s.data.cronId}`;
  if (s.data?.memoryId) return `${s.type}:${s.data.memoryId}`;
  if (s.data?.cronName) return `${s.type}:${s.data.cronName}`;
  // Followups without a matched goal: discriminate by topic so each followup gets its own cooldown
  if (s.data?.topic) return `${s.type}:topic:${s.data.topic.slice(0, 50)}`;
  return s.type;
}

/** Filter signals through cooldown — returns only signals that haven't fired recently (does NOT stamp) */
function filterCooldowns(signals, state) {
  const now = Date.now();
  const cd = state.signalCooldowns || {};
  const passed = [];
  for (const s of signals) {
    const key = signalKey(s);
    const cooldown = SIGNAL_COOLDOWN_MS[s.urgency] ?? SIGNAL_COOLDOWN_MS.low;
    if (cooldown === 0 || !cd[key] || (now - cd[key]) >= cooldown) {
      passed.push(s);
    }
  }
  return passed;
}

/** Stamp cooldowns for picked signals only — call AFTER pickSignals() */
function stampCooldowns(signals, state) {
  const now = Date.now();
  const cd = state.signalCooldowns || {};
  for (const s of signals) {
    cd[signalKey(s)] = now;
  }
  // Prune stale entries older than 24h
  for (const k of Object.keys(cd)) {
    if (now - cd[k] > 24 * 3600_000) delete cd[k];
  }
  state.signalCooldowns = cd;
}

/**
 * pickSignals — Select top signals for this cycle to prevent overload.
 * Rules:
 *   - Max 2 signals per cycle (keeps prompt focused, limits cost)
 *   - At most 1 Sonnet-requiring signal per cycle
 *   - Age-based urgency escalation: overdue low signals with lastCheckAt → medium
 * Works across ALL signal types including module-provided ones.
 */
const CORE_SONNET_TYPES = new Set(['goal_work', 'followup']);
// Merged lazily with module-provided Sonnet types
let _sonnetTypesCache = null;
function getSonnetSignalTypes() {
  if (!_sonnetTypesCache) {
    _sonnetTypesCache = new Set([...CORE_SONNET_TYPES, ...getModuleSonnetSignalTypes()]);
  }
  return _sonnetTypesCache;
}
const URGENCY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function pickSignals(signals, state) {
  if (signals.length <= 2) return signals;

  const now = Date.now();

  // Age-based escalation: promote overdue low signals with lastCheckAt to medium
  const escalated = signals.map(s => {
    if (s.urgency === 'low' && s.data?.lastCheckAt != null) {
      const age = now - (s.data.lastCheckAt || 0);
      if (age > 4 * 24 * 3600_000) return { ...s, urgency: 'medium' };
    }
    return s;
  });

  // Sort by urgency
  escalated.sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 3) - (URGENCY_ORDER[b.urgency] ?? 3));

  const SONNET_SIGNAL_TYPES = getSonnetSignalTypes();
  const picked = [];
  let sonnetCount = 0;

  for (const s of escalated) {
    if (picked.length >= 2) break;
    const needsSonnet = SONNET_SIGNAL_TYPES.has(s.type);
    if (needsSonnet && sonnetCount >= 1) continue;
    if (needsSonnet) sonnetCount++;
    picked.push(s);
  }

  // Diversity slot: if both picks are same urgency tier and there are lower-tier
  // signals available, swap the 2nd pick for the top lower-tier signal.
  // Prevents perpetual starvation of low-urgency signals.
  if (picked.length === 2) {
    const tier0 = URGENCY_ORDER[picked[0].urgency] ?? 3;
    const tier1 = URGENCY_ORDER[picked[1].urgency] ?? 3;
    if (tier0 === tier1) {
      const lowerTier = escalated.find(s => {
        const t = URGENCY_ORDER[s.urgency] ?? 3;
        if (t <= tier0) return false; // same or higher tier — skip
        const needsSonnet = SONNET_SIGNAL_TYPES.has(s.type);
        if (needsSonnet && sonnetCount >= 1 && !SONNET_SIGNAL_TYPES.has(picked[1].type)) return false;
        return true;
      });
      if (lowerTier) {
        // Adjust sonnet count if swapping
        if (SONNET_SIGNAL_TYPES.has(picked[1].type)) sonnetCount--;
        if (SONNET_SIGNAL_TYPES.has(lowerTier.type)) sonnetCount++;
        picked[1] = lowerTier;
      }
    }
  }

  return picked;
}

// ─── Cross-Cycle Memory: recent actions buffer ─────────────────────────────
const RECENT_ACTIONS_KEY = 'recent-actions';
const MAX_RECENT_ACTIONS = 50;
const RECENT_ACTIONS_MAX_AGE = 24 * 3600_000;

function getRecentActionsBlock() {
  const data = getState(RECENT_ACTIONS_KEY);
  if (!data?.actions?.length) return null;
  const now = Date.now();
  const recent = data.actions.filter(a => (now - a.ts) < RECENT_ACTIONS_MAX_AGE);
  if (!recent.length) return null;
  const lines = recent.slice(-10).map(a => {
    const ago = Math.round((now - a.ts) / 60_000);
    const agoStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
    return `- [${a.type}] ${a.summary} (${agoStr})`;
  });
  return `## Recent actions (avoid duplicating):\n${lines.join('\n')}`;
}

function recordRecentAction(type, summary) {
  try {
    const data = getState(RECENT_ACTIONS_KEY) || { actions: [] };
    const now = Date.now();
    data.actions = data.actions.filter(a => (now - a.ts) < RECENT_ACTIONS_MAX_AGE);
    data.actions.push({ type, summary: (summary || '').slice(0, 200), ts: now });
    while (data.actions.length > MAX_RECENT_ACTIONS) data.actions.shift();
    setState(RECENT_ACTIONS_KEY, data);
  } catch {}
}

// --- Cycle diff capture for review ---
const DIFFS_DIR = join(config.dataDir, 'cycle-diffs');
try { mkdirSync(DIFFS_DIR, { recursive: true }); } catch {}

function saveCycleDiff(cycleNum, model, costUsd, actions, fileTouches) {
  // Get files that were written or edited (not just read)
  const modifiedFiles = fileTouches
    .filter(f => f.tool === 'Write' || f.tool === 'Edit')
    .map(f => f.file);
  const bashCommands = fileTouches
    .filter(f => f.tool === 'Bash')
    .map(f => f.command);
  const uniqueFiles = [...new Set(modifiedFiles)];

  if (uniqueFiles.length === 0 && bashCommands.length === 0) return; // nothing to review

  const cwd = config.projectRoot;
  const gitOpts = { cwd, encoding: 'utf-8', maxBuffer: 50_000 };

  // Get git diff for modified files — try multiple strategies to catch both
  // committed and uncommitted changes (Claude CLI may auto-commit during a cycle)
  const fileDiffs = [];
  for (const fp of uniqueFiles) {
    try {
      const relPath = fp.replace(/\\/g, '/').replace(new RegExp(`^${process.cwd().replace(/\\/g, '/')}/`), '');
      let diff = '';

      // Strategy 1: unstaged working-tree changes (git diff)
      try {
        execFileSync('git', ['ls-files', '--error-unmatch', relPath], { cwd, stdio: 'pipe' });
        diff = execFileSync('git', ['diff', '--', relPath], { ...gitOpts, stdio: 'pipe' });
      } catch {
        // Not tracked — might be a new file
      }

      // Strategy 2: staged but not committed (git diff --cached)
      if (!diff) {
        try {
          const staged = execFileSync('git', ['diff', '--cached', '--', relPath], { ...gitOpts, stdio: 'pipe' });
          if (staged && staged.trim()) diff = staged;
        } catch { /* ignore */ }
      }

      // Strategy 3: already committed — diff latest commit vs parent (git diff HEAD~1..HEAD)
      if (!diff) {
        try {
          const committed = execFileSync('git', ['diff', 'HEAD~1', 'HEAD', '--', relPath], { ...gitOpts, stdio: 'pipe' });
          if (committed && committed.trim()) diff = committed;
        } catch { /* ignore — e.g. no HEAD~1 */ }
      }

      // Strategy 4: file exists but no diff found — check if it's a new untracked file
      if (!diff) {
        try {
          execFileSync('git', ['ls-files', '--error-unmatch', relPath], { cwd, stdio: 'pipe' });
          diff = '[no changes]';
        } catch {
          diff = `[new file: ${relPath}]`;
        }
      }

      fileDiffs.push({ path: relPath, diff });
    } catch (err) {
      fileDiffs.push({ path: fp, diff: `[error: ${err.message}]` });
    }
  }

  const record = {
    cycle: cycleNum,
    ts: Date.now(),
    model,
    cost: costUsd,
    actions,
    bashCommands,
    files: fileDiffs,
    reviewed: false,
  };

  const filePath = join(DIFFS_DIR, `cycle-${cycleNum}.json`);
  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
  log.info({ cycle: cycleNum, files: fileDiffs.length, bash: bashCommands.length }, 'Saved cycle diff for review');
}

export function getCycleDiffs(limit = 10) {
  try {
    const files = readdirSync(DIFFS_DIR).filter(f => f.startsWith('cycle-') && f.endsWith('.json')).sort().reverse().slice(0, limit);
    return files.map(f => {
      try { return JSON.parse(readFileSync(join(DIFFS_DIR, f), 'utf-8')); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

export function markCycleReviewed(cycleNum) {
  try {
    const num = parseInt(cycleNum, 10);
    if (!Number.isFinite(num) || num < 0) return false;
    const filePath = join(DIFFS_DIR, `cycle-${num}.json`);
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    data.reviewed = true;
    data.reviewedAt = Date.now();
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch { return false; }
}

const HAIKU_RESTRICTIONS = `## IMPORTANT — lightweight cycle restrictions:
You are running as a lightweight model. You MUST NOT:
- Create, edit, or delete any source code files (.js, .ts, .mjs, .json config)
- Write new modules or libraries
- Implement features or fix bugs in code
- Run shell commands that modify files (npm, git commit, etc.)

You CAN:
- Read files to investigate signals
- Update goal status/progress via XML tags
- Create/manage goals via XML tags
- Send WhatsApp messages
- Search Vestige memory, clean up stale memories
- Plan what needs to be done (describe it in <action_taken>, a Sonnet cycle will execute)
- Create followups for code work so it gets picked up by a Sonnet cycle
If a milestone requires writing code, use <followup> to defer it — do NOT attempt it yourself.`;

const SONNET_CODE_RULES = `## Code quality rules (Sonnet cycle):
When you write code for a milestone, you MUST follow this checklist:
1. **Check existing modules first**: Before creating a new file, search lib/ for existing code that does something similar. Extend it — don't duplicate.
2. **Wire it up**: Every new file MUST be imported and used by at least one other module. Dead code = failed milestone. After writing a file, add the import and call it from the relevant module.
3. **Verify integration**: After writing code, confirm it's actually imported (grep for the import). If nothing imports your new file, you're not done.
4. **Fit check**: Before implementing, consider whether this milestone makes sense given the current codebase. If the existing code already handles this, or if the approach conflicts with how things work, do NOT force it. Instead, send the user a WhatsApp message explaining why you think it doesn't fit and what you'd suggest instead. Then skip the milestone.
5. **No standalone files**: A .js file that nothing imports is worse than no file at all. Either integrate it fully or don't create it.`;

function buildOutputTags(quiet) {
  // Build available tools list for prompt
  let toolList = '';
  try {
    const tools = listTools();
    if (tools.length > 0) {
      toolList = `\n- <tool_call name="tool_name">{"param": "value"}</tool_call> — call an external tool\n  Available: ${tools.map(t => t.name).join(', ')}`;
    }
  } catch {}

  return `## Output tags (XML, multiple allowed):
- <wa_message>text</wa_message> — message the user${quiet ? ' (SUPPRESSED — quiet hours)' : ''}
- <followup>topic</followup> — check next cycle (max ${MAX_FOLLOWUPS}); add goal="goalId" to inherit urgency from parent goal (e.g. <followup goal="abc123">fix the bug</followup>)
- <next_cycle_minutes>N</next_cycle_minutes> — override interval (5-120, default ${INTERVAL_MS / 60_000})
- <action_taken>what you did</action_taken> — REQUIRED for every action (file created, tool called, goal updated, etc). Without this tag your work is invisible to the event log and future cycles. Emit one per distinct action.
- <goal_create title="Title">description</goal_create> — create a goal (max 1/cycle)
- <goal_update id="goalId" status="in_progress" progress="50">optional note</goal_update> — update a goal's status/progress
- <milestone_complete goal="goalId" milestone="ms_1">evidence or note</milestone_complete> — mark a milestone done${toolList}
- <chain_plan>{"name":"chain name","steps":[...]}</chain_plan> — create a multi-step workflow chain
- <lesson_learned>what you learned from this cycle</lesson_learned> — record a learning for future cycles
- <goal_propose title="Title" rationale="Why">milestone1; milestone2</goal_propose> — propose a goal for user approval (never auto-activated)
- <hypothesis>your hypothesis text</hypothesis> — open a reasoning journal entry for multi-cycle investigation
- <evidence hypothesis_id="N">supporting or refuting evidence</evidence> — add evidence to hypothesis #N
- <conclude hypothesis_id="N">your conclusion</conclude> — close hypothesis #N with a conclusion
- <capability_gap topic="category">description of what I can't do</capability_gap> — record a capability limitation
- <experiment_create>{"name":"...", "hypothesis":"...", "metric":"positive_rate|response_time|cost", "duration_hours":168, "revert_threshold":0.8}</experiment_create> — start an experiment`;
}

let cycleTimer = null;
let startupTimer = null;
let sendFn = null;
let queueRef = null;
let running = false;
let stopped = false;


// ─── Session persistence (avoid duplicate work across cycles) ────────────────
const AGENT_SESSION_SYSTEM_PROMPT = `You are the user's autonomous agent running in a persistent session. You remember previous cycles.
IMPORTANT: Do NOT repeat work you already did in previous messages. Check your conversation history before acting.
If you already completed a task, skip it and move to the next one.`;
const SESSION_TOKEN_LIMIT = 100_000; // reset session when cumulative tokens exceed this
const SESSION_CYCLE_LIMIT = 10;      // reset session every N cycles as safety net

let agentProc = null;                 // PersistentProcess instance for agent-loop Sonnet cycles
let agentSessionCycles = 0;
let agentSessionTokens = 0;

function resetAgentSession(reason) {
  log.info({ reason, cycles: agentSessionCycles, tokens: agentSessionTokens }, 'Agent session reset');
  agentProc?.respawnForCompression(randomUUID(), AGENT_SESSION_SYSTEM_PROMPT);
  agentSessionCycles = 0;
  agentSessionTokens = 0;
}

// ─── Israel time helpers ────────────────────────────────────────────────────

// ─── State management ───────────────────────────────────────────────────────

function loadState() {
  const raw = getState(STATE_KEY) || {};
  // Module signal detectors read their own state directly via getState()
  return {
    lastCycleAt: raw.lastCycleAt || null,
    lastClaudeSpawnAt: raw.lastClaudeSpawnAt || null,
    dailyCost: raw.dailyCost || 0,
    dailyCostDate: raw.dailyCostDate || todayDateKey(),
    dailySonnetCost: raw.dailySonnetCost || 0,
    cycleCount: raw.cycleCount || 0,
    consecutiveSpawns: raw.consecutiveSpawns || 0,
    pendingFollowups: raw.pendingFollowups || [],
    lastSignals: raw.lastSignals || [],
    recentEvents: raw.recentEvents || [],
    lastErrorSpikeAlertAt: raw.lastErrorSpikeAlertAt || 0,
    lastCycleTokens: raw.lastCycleTokens || null,
    lastCycleFileTouches: raw.lastCycleFileTouches || [],
    signalCooldowns: raw.signalCooldowns || {},
    consecutiveRecycles: raw.consecutiveRecycles || 0,
    sonnetCooldownUntil: raw.sonnetCooldownUntil || 0,
  };
}

const MAX_RECENT_EVENTS = 50;

// Module-level live events buffer — always up-to-date, even during a running cycle.
// Solves: REST polls reading persisted state can't see events until saveState() at cycle end.
let liveEvents = [];

function saveState(state) {
  setState(STATE_KEY, state);
  // Sync live buffer with persisted state after save
  liveEvents = [...(state.recentEvents || [])];
}

function recordEvent(state, event, data) {
  const entry = { event, ts: Date.now(), data };
  state.recentEvents.push(entry);
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
  // Also write to module-level buffer for live REST access
  liveEvents.push(entry);
  if (liveEvents.length > MAX_RECENT_EVENTS) {
    liveEvents = liveEvents.slice(-MAX_RECENT_EVENTS);
  }
}

function resetDailyBudgetIfNeeded(state) {
  const today = todayDateKey();
  if (state.dailyCostDate !== today) {
    state.dailyCost = 0;
    state.dailyCostDate = today;
    state.dailySonnetCost = 0;
  }
}

const COSTS_ROLLUP_INTERVAL_MS = 7 * 24 * 60 * 60_000; // weekly
const QMD_CHECK_INTERVAL_MS = 30 * 60_000; // check every 30 min

function qmdSyncIfDue(state) {
  const due = !state.lastQmdCheckAt || (Date.now() - state.lastQmdCheckAt) >= QMD_CHECK_INTERVAL_MS;
  if (!due) return;
  state.lastQmdCheckAt = Date.now();

  // Quick mtime check — skip QMD entirely if no files changed
  const lastSync = state.lastQmdSyncAt || 0;
  if (lastSync && !workspaceFilesChanged(lastSync)) return;

  try {
    const qmdBin = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'qmd.cmd' : 'qmd');
    // `update` re-indexes collections; internally skips unchanged files (SHA-256 hash check)
    execSync(`"${qmdBin}" update`, { timeout: 60_000, stdio: 'ignore' });
    // `embed` only processes hashes that don't have vectors yet
    execSync(`"${qmdBin}" embed`, { timeout: 120_000, stdio: 'ignore' });
    state.lastQmdSyncAt = Date.now();
    log.info('QMD update+embed completed');
  } catch (err) {
    log.warn({ err: err.message }, 'QMD update+embed failed');
    state.lastQmdSyncAt = Date.now();
  }
}

/** Quick pre-filter: recurse dirs up to 4 levels; return true on first newer mtime */
function workspaceFilesChanged(lastSyncMs) {
  const roots = [
    join(process.cwd(), 'data'),
    join(process.cwd(), 'lib'),
    config.workspaceDir,
  ];
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'coverage']);

  function check(dir, depth) {
    if (depth > 4) return false;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      try {
        const full = join(dir, e.name);
        if (statSync(full).mtimeMs > lastSyncMs) return true;
        if (e.isDirectory() && check(full, depth + 1)) return true;
      } catch {}
    }
    return false;
  }

  for (const root of roots) {
    if (existsSync(root) && check(root, 0)) return true;
  }
  return false;
}

function rollupCostsIfDue(state) {
  const due = !state.lastCostsRollupAt || (Date.now() - state.lastCostsRollupAt) >= COSTS_ROLLUP_INTERVAL_MS;
  if (!due) return;
  try {
    const result = rollupOldCosts(7);
    if (result.compressed > 0) {
      log.info(result, 'Weekly costs rollup complete');
    }
    state.lastCostsRollupAt = Date.now();
  } catch (err) {
    log.warn({ err: err.message }, 'Weekly costs rollup failed');
  }
}

// ─── Phase 1: Signal Collection (pure JS, zero cost) ───────────────────────
// detectGoalProgressTriggers, detectAnomalyTriggers, detectIdleTimeTriggers,
// detectErrorSpikeSQLite are imported from ./agent-signals.js

function collectSignals(state) {
  const signals = [];

  // 1. Stale goals (in_progress but no activity for 48h)
  try {
    const stale = getStaleGoals(48);
    for (const g of stale) {
      const hoursSince = Math.round((Date.now() - g.updatedAt) / 3600_000);
      signals.push({
        type: 'stale_goal',
        urgency: hoursSince > 96 ? 'high' : 'medium',
        summary: `Goal "${g.title}" has had no activity for ${hoursSince}h`,
        data: { goalId: g.id, title: g.title, hoursSince },
      });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: stale goals check failed');
  }

  // 2. Blocked goals (status === 'blocked', 3+ days). At 14d+ ask the user if we should drop it.
  try {
    const blocked = listGoals({ status: ['blocked'] });
    for (const g of blocked) {
      const daysSince = Math.round((Date.now() - g.updatedAt) / 86400_000);
      if (daysSince >= 3) {
        const nudge = daysSince >= 14;
        signals.push({
          type: 'blocked_goal',
          urgency: daysSince >= 7 ? 'high' : 'medium',
          summary: nudge
            ? `Goal "${g.title}" has been blocked for ${daysSince} days — ask the user if we should drop or unblock it`
            : `Goal "${g.title}" has been blocked for ${daysSince} days`,
          data: { goalId: g.id, title: g.title, daysSince, nudgeUser: nudge },
        });
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: blocked goals check failed');
  }

  // 3. Approaching deadlines (within 48h)
  try {
    const upcoming = getUpcomingDeadlines(2);
    for (const g of upcoming) {
      const hoursLeft = Math.round((new Date(g.deadline).getTime() - Date.now()) / 3600_000);
      signals.push({
        type: 'deadline_approaching',
        urgency: hoursLeft <= 24 ? 'high' : 'medium',
        summary: `Goal "${g.title}" deadline in ${hoursLeft}h`,
        data: { goalId: g.id, title: g.title, hoursLeft, deadline: g.deadline },
      });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: deadlines check failed');
  }

  // 4. Failing crons (3+ consecutive errors)
  try {
    const crons = listCrons();
    for (const c of crons) {
      if (c.enabled && c.state?.consecutiveErrors >= 3) {
        signals.push({
          type: 'failing_cron',
          urgency: c.state.consecutiveErrors >= 5 ? 'high' : 'medium',
          summary: `Cron "${c.name}" has failed ${c.state.consecutiveErrors} times in a row`,
          data: { cronId: c.id, name: c.name, errors: c.state.consecutiveErrors, lastStatus: c.state.lastStatus },
        });
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: crons check failed');
  }

  // 5. Pending follow-ups from previous cycles (inherit urgency from matching goal)
  try {
    const activeGoals = listGoals({ status: ['active', 'in_progress'] });
    for (const f of state.pendingFollowups) {
      const topic = f.topic || '';
      // Primary: use stored goalId if available (set via <followup goal="id"> syntax)
      // Fallback: fuzzy match by checking if topic mentions goal title or milestone
      const matched = (f.goalId && activeGoals.find(g => g.id === f.goalId))
        || activeGoals.find(g =>
          topic.toLowerCase().includes(g.title.toLowerCase()) ||
          g.milestones?.some(m => topic.toLowerCase().includes(m.title.toLowerCase()))
        );
      const goalPriority = matched?.priority || 'low';
      // Base urgency = goalPriority - 1 tier: critical→high, high→medium, medium/normal/low→low
      const baseUrgency = goalPriority === 'critical' ? 'high'
        : goalPriority === 'high' ? 'medium'
        : goalPriority === 'medium' ? 'low'
        : 'low';
      // Dynamic age-based escalation (goal 125a6ac4): older followups get promoted
      // 24h+ → +1 tier, 48h+ → +2 tiers, capped at 'high'
      const ageHours = f.createdAt ? (Date.now() - f.createdAt) / 3_600_000 : 0;
      const urgencyLevels = ['low', 'medium', 'high'];
      const baseIdx = urgencyLevels.indexOf(baseUrgency);
      const ageBoost = ageHours > 48 ? 2 : ageHours > 24 ? 1 : 0;
      const urgency = urgencyLevels[Math.min(baseIdx + ageBoost, 2)];
      const ageSuffix = ageHours > 24 ? ` [${Math.round(ageHours)}h old → escalated to ${urgency}]` : '';
      signals.push({
        type: 'followup',
        urgency,
        summary: `Follow-up from previous cycle: ${topic}${ageSuffix}`,
        // goalId used by signalKey() for per-goal cooldown tracking; topic is fallback key
        data: { topic, createdAt: f.createdAt, goalId: matched?.id || null, ageHours: Math.round(ageHours) },
      });
    }
  } catch (err) {
    // Fallback: push all but still apply age-based escalation if goal lookup fails
    for (const f of state.pendingFollowups) {
      const ageHoursF = f.createdAt ? (Date.now() - f.createdAt) / 3_600_000 : 0;
      const fallbackUrgency = ageHoursF > 48 ? 'medium' : 'low';
      const ageSuffixF = ageHoursF > 24 ? ` [${Math.round(ageHoursF)}h old]` : '';
      signals.push({ type: 'followup', urgency: fallbackUrgency, summary: `Follow-up from previous cycle: ${f.topic}${ageSuffixF}`, data: { topic: f.topic, createdAt: f.createdAt, ageHours: Math.round(ageHoursF) } });
    }
  }

  // 6. Cost spike — disabled when COST_TRACKING=false (e.g. CLI subscription plan)
  if (!config.costTrackingDisabled) {
    try {
      const SIX_HOURS_MS = 6 * 3600_000;
      const now6 = Date.now();
      if (!state.lastCostSpikeSignalAt || (now6 - state.lastCostSpikeSignalAt) >= SIX_HOURS_MS) {
        const overview = getCostOverview();
        const todayUsd = overview.today?.total || 0;
        const dailyAvg = overview.dailyAvg || 0;
        if (todayUsd > 0.10 && dailyAvg > 0 && todayUsd > dailyAvg * 1.5) {
          signals.push({
            type: 'cost_spike',
            urgency: todayUsd > dailyAvg * 3 ? 'high' : 'medium',
            summary: `Cost spike: $${todayUsd.toFixed(3)} today vs $${dailyAvg.toFixed(3)} daily avg (${Math.round(todayUsd / dailyAvg * 100)}%)`,
            data: { todayUsd, dailyAvg, todayCount: overview.today?.count || 0 },
          });
          state.lastCostSpikeSignalAt = now6;
        }
      }
    } catch (err) {
      log.warn({ err: err.message }, 'Signal collection: cost spike check failed');
    }
  }

  // Cache getDetailedMetrics() for signals 7 + 9
  let detailedMetrics = null;
  try {
    detailedMetrics = getDetailedMetrics();
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: failed to get detailed metrics');
  }

  // 7. Memory pressure — Memory Guardian (replaces inline 420/470MB thresholds)
  // Uses tiered detection: NORMAL → WARN → SHED → CRITICAL → RESTART
  // Also tracks chronic pressure (sustained elevated state) and sheds cache.
  try {
    const memResult = checkMemoryGuardian();
    signals.push(...memResult.signals);
    // Alert on CRITICAL/RESTART if alerted flag was set (respects 30min cooldown)
    if (memResult.alerted) {
      alertCrash('memory-guardian', `Heap ${memResult.heapPct}% (${memResult.tier}) — ${memResult.chronic.chronic ? 'CHRONIC' : 'transient'}`);
    }
    // Log restart recommendation (PM2 will handle actual restart if process exits)
    if (memResult.shouldRestart) {
      log.error({ heapPct: memResult.heapPct }, 'Memory Guardian recommends graceful restart');
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Memory Guardian check failed — falling back');
    // Fallback: RSS-based check if Memory Guardian fails (consistent with guardian's approach)
    const rssMB = Math.round(process.memoryUsage().rss / 1048576);
    const pm2Limit = parseInt(process.env.PM2_MAX_MEMORY_MB || '512', 10);
    const rssPct = Math.round(rssMB / pm2Limit * 100);
    if (rssPct >= 80) {
      signals.push({ type: 'memory_pressure', urgency: rssPct >= 96 ? 'high' : 'medium', summary: `RSS ${rssPct}% of ${pm2Limit}MB (${rssMB}MB) — guardian fallback`, data: { heapMB: rssMB, rssPct } });
    }
  }

  // 8. MCP disconnected
  try {
    const mcpStats = getMcpStats();
    if (!mcpStats.connected) {
      const urgency = mcpStats.consecutiveFailures >= 3 ? 'high' : 'medium';
      signals.push({ type: 'mcp_disconnected', urgency, summary: `Vestige MCP disconnected (${mcpStats.consecutiveFailures} consecutive failures)`, data: { failures: mcpStats.consecutiveFailures } });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: MCP check failed');
  }

  // 9. Error spike — SQLite-based hourly pattern analysis (replaces in-memory check)
  // Uses detectErrorSpikeSQLite() below — compares this hour vs last hour,
  // groups by module, and sends direct Telegram alert for critical spikes.
  signals.push(...detectErrorSpikeSQLite(state));

  // 10. Conversation gap (no messages for 18+ hours, outside quiet hours)
  if (!isQuietHours()) {
    try {
      const jid = config.allowedJid;
      const msgs = getMessages(jid);
      if (msgs.length > 0) {
        const lastMsg = msgs[msgs.length - 1];
        const hoursSince = (Date.now() - (lastMsg.ts || 0)) / 3600_000;
        if (hoursSince >= 18) {
          signals.push({ type: 'conversation_gap', urgency: 'low', summary: `No WhatsApp messages for ${Math.round(hoursSince)}h`, data: { hoursSince: Math.round(hoursSince) } });
        }
      }
    } catch (err) {
      log.warn({ err: err.message }, 'Signal collection: conversation gap check failed');
    }
  }

  // 11. Stale T1 memories (unaccessed 5+ days)
  try {
    const staleMemories = getStaleT1Memories(5, 3);
    for (const m of staleMemories) {
      const daysSince = Math.round((Date.now() - (m.lastAccessed || m.firstSeen)) / 86400_000);
      signals.push({ type: 'stale_memory', urgency: 'low', summary: `T1 memory "${(m.preview || m.id || '?').slice(0, 60)}" unaccessed for ${daysSince}d`, data: { memoryId: m.id, daysSince } });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: stale memory check failed');
  }

  // 12. Low engagement crons
  try {
    const lowCrons = getLowEngagementCrons();
    for (const c of lowCrons) {
      signals.push({ type: 'low_engagement_cron', urgency: 'low', summary: `Cron "${c.cronName}" has ${c.engagementRate}% engagement after ${c.deliveries} deliveries`, data: { cronName: c.cronName, rate: c.engagementRate, deliveries: c.deliveries } });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: low engagement cron check failed');
  }

  // 13a. Stale bot memory — MEMORY.md not updated in 24h+
  try {
    const memPath = config.memoryPath;
    const memMtime = statSync(memPath).mtimeMs;
    const hoursSince = Math.round((Date.now() - memMtime) / 3600_000);
    if (hoursSince >= 24) {
      signals.push({
        type: 'stale_bot_memory',
        urgency: hoursSince >= 72 ? 'medium' : 'low',
        summary: `MEMORY.md hasn't been updated in ${hoursSince}h — review recent conversations and save useful patterns, preferences, or recurring issues`,
        data: { hoursSince, path: memPath },
      });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: bot memory staleness check failed');
  }

  // 13b. Goal work — pick top 2 active goals with pending milestones to advance
  try {
    const prioOrder = { critical: 0, high: 1, medium: 2, normal: 3, low: 4 };
    const workable = listGoals({ status: ['active', 'in_progress'] })
      .filter(g => g.milestones?.some(m => m.status === 'pending'))
      .sort((a, b) => (prioOrder[a.priority] ?? 3) - (prioOrder[b.priority] ?? 3));
    for (const g of workable.slice(0, 3)) {
      const nextMs = g.milestones.find(m => m.status === 'pending');
      const prioLabel = (g.priority || 'normal').toUpperCase();
      signals.push({
        type: 'goal_work',
        urgency: g.priority === 'critical' || g.priority === 'high' ? 'high' : 'medium',
        summary: `[${prioLabel}] Goal "${g.title}" (${g.progress}%) — next milestone: "${nextMs.title}"`,
        data: { goalId: g.id, title: g.title, progress: g.progress, priority: g.priority, nextMilestone: nextMs.title },
      });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'Signal collection: goal work check failed');
  }

  // 15. Proactive triggers: goal progress, anomalies, idle time
  signals.push(...detectGoalProgressTriggers());
  signals.push(...detectAnomalyTriggers(state));
  signals.push(...detectIdleTimeTriggers(state));

  // 16. Module signals (Hattrick, etc.)
  signals.push(...detectModuleSignals(state));

  // Phase 2: detect chain opportunities from multiple related signals
  signals.push(...detectChainOpportunities(signals));

  // Phase 6: detect self-improvement opportunities from recurring errors
  signals.push(...detectSelfImprovementOpportunities());

  // Phase 7: signal correlation — detect combinations that mean more together (goal c758381b)
  signals.push(...correlateSignals(signals));

  // Detect recurring user topic patterns (Phase 2: self-generated goals)
  signals.push(...detectPatternObserved());

  // Detect stalled workflows (Phase 3: persistent plans)
  signals.push(...detectPlanStuck());

  // Transfer auction deadline proximity (HIGH/CRITICAL within 90/30 min)
  signals.push(...detectTransferDeadlineUrgency());

  // 14. Compound signal escalation — 3+ low signals → add a medium compound
  const lowCount = signals.filter(s => s.urgency === 'low').length;
  if (lowCount >= 3) {
    signals.push({
      type: 'compound',
      urgency: 'medium',
      summary: `${lowCount} low-priority signals accumulated — worth investigating together`,
      data: { lowCount },
    });
  }

  return signals;
}

// ─── Phase 2: Claude Reasoning ──────────────────────────────────────────────

function buildAgentPrompt(signals) {
  const now = israelNow();
  const timeStr = now.toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = now.toISOString().slice(0, 10);
  const quiet = isQuietHours();

  const signalBlock = signals.map((s, i) => {
    const urgencyTag = s.urgency === 'high' ? ' [HIGH]' : s.urgency === 'medium' ? ' [MED]' : '';
    return `${i + 1}. [${s.type}]${urgencyTag} ${s.summary}`;
  }).join('\n');

  const patternInsights = formatPatternInsights(30);
  const goalsCtx = getGoalsContext();
  const hour = now.getHours();
  const timeContext = hour >= 8 && hour < 11 ? 'MORNING — good time to plan the day, set priorities, message the user with a brief plan if useful.'
    : hour >= 21 && hour < 23 ? 'EVENING — good time to review what happened today, summarize progress, prep for tomorrow.'
    : '';

  const useSonnet = signals.some(s => s.urgency === 'high' || s.urgency === 'critical') ||
    signals.some(s => s.type === 'goal_work' && CODE_KEYWORDS.test(s.data?.nextMilestone || '')) ||
    signals.some(s => s.type === 'followup' && CODE_KEYWORDS.test(s.data?.topic || ''));

  // Auto-coder: inject pending milestone brief for Sonnet cycles only
  let milestoneBrief = '';
  if (useSonnet) {
    try {
      const picked = pickMilestone(listGoals());
      if (picked) milestoneBrief = '\n\n' + buildMilestoneBrief(picked.goal, picked.milestone);
    } catch (e) {
      // non-fatal — agent still runs without the brief
    }
  }

  // Build <context> block so context-gate can dedup/trim across cycles
  const contextParts = [`## Current context:\n${dateStr} ${timeStr} Israel${quiet ? ' (QUIET HOURS)' : ''}`];
  contextParts.push(`## Detected signals:\n${signalBlock}`);
  if (goalsCtx) contextParts.push(`## Active goals:\n${goalsCtx}`);
  if (patternInsights) contextParts.push(`## Response style insights (from reply_outcomes data):\n${patternInsights}`);

  // Error analytics: inject pattern analysis when an error_spike signal is present
  if (signals.some(s => s.type === 'error_spike')) {
    try {
      const errorSummary = summarizeErrorPatterns();
      if (errorSummary) contextParts.push(errorSummary);
    } catch {}
  }

  // Module context providers (weekly plan, etc.)
  for (const provider of getModuleContextProviders()) {
    try { const ctx = provider(); if (ctx) contextParts.push(ctx); } catch {}
  }

  // Cross-cycle memory: recent actions to prevent duplicates
  try {
    const recentBlock = getRecentActionsBlock();
    if (recentBlock) contextParts.push(recentBlock);
  } catch {}

  // Module signal briefs: inject context for module signal types
  const moduleBriefBuilders = getModuleBriefBuilders();
  // Core brief builders (non-module signals)
  const coreBriefBuilders = { memory_pressure: buildMemoryBrief };
  for (const sig of signals) {
    const builder = moduleBriefBuilders[sig.type] || coreBriefBuilders[sig.type];
    if (builder) {
      try { const b = builder(sig); if (b) contextParts.push(b); } catch {}
    }
  }

  // Phase 6: Inject learning context from past cycles
  try {
    const learningCtx = formatLearningContextSync(5);
    if (learningCtx) contextParts.push(learningCtx);
  } catch {}

  // Reasoning journal: open hypotheses + recent conclusions
  try {
    const reasoningCtx = formatReasoningContext();
    if (reasoningCtx) contextParts.push(reasoningCtx);
  } catch {}
  const contextBlock = `<context>\n${contextParts.join('\n\n')}\n</context>`;

  return `${contextBlock}

AGENT_CYCLE:${quiet ? ' (QUIET HOURS — do NOT send WhatsApp messages)' : ''}${timeContext ? ` [${timeContext}]` : ''}
You are the user's autonomous agent. You have initiative — use it. Don't wait for permission. If something needs doing, do it now.

## Instructions — Investigate → Decide → Act → Verify:
1. **Investigate**: Use tools to understand each signal deeply. Don't just glance — dig in.
2. **Decide**: What needs action NOW vs what can wait? Bias toward action.
3. **Act**: Update goals, advance milestones, create workflows, fix crons, clean up memories. Do multiple things if needed.
4. **Verify**: Confirm your actions worked. Re-check after changing state.

After handling signals: pick an active goal and advance it. Goals are sorted by priority — HIGH goals MUST be worked on before MEDIUM, MEDIUM before LOW. Never skip a higher-priority goal to work on a lower one.
${useSonnet ? '\n' + SONNET_CODE_RULES + '\n' : '\n' + HAIKU_RESTRICTIONS + '\n'}
${buildOutputTags(quiet)}

${PROJECT_PATHS_HINT}

## Rules:
- Be proactive. Take initiative. Do real work, not narration.
- Multiple actions per cycle is good — don't stop after one.
- Message the user when something is useful, not just urgent.
- CYCLE_DONE only if genuinely nothing to do.${milestoneBrief}`;
}

function buildNimPrompt(signals) {
  const now = israelNow();
  const timeStr = now.toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = now.toISOString().slice(0, 10);
  const quiet = isQuietHours();

  const signalBlock = signals.map((s, i) => {
    const urgencyTag = s.urgency === 'high' ? ' [HIGH]' : s.urgency === 'medium' ? ' [MED]' : '';
    return `${i + 1}. [${s.type}]${urgencyTag} ${s.summary}`;
  }).join('\n');

  const goalsCtx = getGoalsContext();

  const contextParts = [`## Current context:\n${dateStr} ${timeStr} Israel${quiet ? ' (QUIET HOURS)' : ''}`];
  contextParts.push(`## Detected signals:\n${signalBlock}`);
  if (goalsCtx) contextParts.push(`## Active goals:\n${goalsCtx}`);
  const contextBlock = `<context>\n${contextParts.join('\n\n')}\n</context>`;

  return `${contextBlock}

AGENT_CYCLE:${quiet ? ' (QUIET HOURS — do NOT send WhatsApp messages)' : ''}
You are the user's autonomous agent. Handle the signals above using XML output tags.
Only reference goals/data you read from files. Do not invent.

${HAIKU_RESTRICTIONS}

## Instructions — Investigate → Decide → Act → Verify:
1. **Investigate**: Use tools to understand each signal deeply.
2. **Decide**: What needs action NOW vs what can wait?
3. **Act**: Update goals, advance milestones, create workflows, fix crons, clean up memories.
4. **Verify**: Confirm your actions worked.

After handling signals: pick an active goal and advance it. Goals are sorted by priority — HIGH goals MUST be worked on before MEDIUM, MEDIUM before LOW. Never skip a higher-priority goal to work on a lower one.

${buildOutputTags(quiet)}

${PROJECT_PATHS_HINT}`;
}

function buildNimReflectionPrompt() {
  const now = israelNow();
  const timeStr = now.toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = now.toISOString().slice(0, 10);
  const quiet = isQuietHours();
  const goalsCtx = getGoalsContext();

  const contextParts = [`## Current context:\n${dateStr} ${timeStr} Israel${quiet ? ' (QUIET HOURS)' : ''}`];
  if (goalsCtx) contextParts.push(`## Active goals:\n${goalsCtx}`);
  const contextBlock = `<context>\n${contextParts.join('\n\n')}\n</context>`;

  return `${contextBlock}

AGENT_REFLECTION:${quiet ? ' (QUIET HOURS — do NOT send WhatsApp messages)' : ''}
You are the user's autonomous agent. No signals fired — use this time to maintain.
Only reference goals/data you read from files. Do not invent.
Check data/goals.json and data/crons.json. Update anything stale.

${HAIKU_RESTRICTIONS}

${buildOutputTags(quiet)}

${PROJECT_PATHS_HINT}`;
}

function buildReflectionPrompt() {
  const now = israelNow();
  const timeStr = now.toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = now.toISOString().slice(0, 10);
  const quiet = isQuietHours();
  const goalsCtx = getGoalsContext();

  const hour = now.getHours();
  const timeContext = hour >= 8 && hour < 11 ? 'MORNING — plan the day, set priorities, give the user a brief heads-up if useful.'
    : hour >= 21 && hour < 23 ? 'EVENING — review today, summarize progress, prep for tomorrow.'
    : '';

  // Build <context> block so context-gate can dedup/trim across cycles
  const contextParts = [`## Current context:\n${dateStr} ${timeStr} Israel${quiet ? ' (QUIET HOURS)' : ''}`];
  if (goalsCtx) contextParts.push(`## Active goals:\n${goalsCtx}`);
  const learningCtx = getLearningContext();
  if (learningCtx) contextParts.push(learningCtx);
  const contextBlock = `<context>\n${contextParts.join('\n\n')}\n</context>`;

  return `${contextBlock}

AGENT_REFLECTION:${quiet ? ' (QUIET HOURS — do NOT send WhatsApp messages)' : ''}${timeContext ? ` [${timeContext}]` : ''}
You are the user's autonomous agent. No signals fired — this is your free time. Use it well. Don't say CYCLE_DONE unless you've actually checked everything.

${HAIKU_RESTRICTIONS}

## Your checklist (do at least 2):
1. **Review & plan goals**: Check goal progress, reprioritize, create followups for code milestones.
2. **Create a goal**: Notice something the user should track? A project with no goal? A recurring issue? Create one.
3. **Update goal status**: Are any goals stale, blocked without reason, or redundant? Update them via XML tags.
4. **Plan ahead**: What will the user need this week? Upcoming deadlines? Create followups.
5. **Memory work**: Search Vestige for stale, contradictory, or duplicate memories. Clean up.
6. **Cron audit**: Any crons with low engagement or repeated failures? Disable or fix them.

${buildOutputTags(quiet)}

${PROJECT_PATHS_HINT}

## Rules:
- Take initiative. You're not waiting for instructions — you ARE the initiative.
- Multiple actions per cycle is expected. Do at least 2 things from the checklist.
- Message the user with useful info, not just emergencies. A morning plan or evening summary is welcome.
- CYCLE_DONE only after genuinely exhausting the checklist.`;
}

function parseAgentResponse(reply) {
  const result = {
    waMessages: [],
    followups: [],
    nextCycleMinutes: null,
    actionsTaken: [],
    goalCreates: [],
  };

  // Extract ALL <wa_message> blocks
  for (const m of reply.matchAll(/<wa_message>([\s\S]*?)<\/wa_message>/g)) {
    const msg = m[1].trim();
    if (msg) result.waMessages.push(msg);
  }

  // Extract follow-ups — supports optional goal attribute for deterministic urgency inheritance
  // e.g. <followup goal="goalId">topic</followup>
  for (const m of reply.matchAll(/<followup([^>]*)>([\s\S]*?)<\/followup>/g)) {
    const attrs = m[1];
    const topic = m[2].trim();
    if (!topic) continue;
    const goalAttr = attrs.match(/goal="([^"]+)"/);
    const entry = { topic, createdAt: Date.now() };
    if (goalAttr?.[1]) entry.goalId = goalAttr[1];
    result.followups.push(entry);
  }

  // Extract adaptive timing
  const timingMatch = reply.match(/<next_cycle_minutes>(\d+)<\/next_cycle_minutes>/);
  if (timingMatch) {
    const mins = parseInt(timingMatch[1], 10);
    if (mins >= 5 && mins <= 120) result.nextCycleMinutes = mins;
  }

  // Extract action descriptions
  for (const m of reply.matchAll(/<action_taken>([\s\S]*?)<\/action_taken>/g)) {
    const action = m[1].trim();
    if (action) result.actionsTaken.push(action);
  }

  // Extract goal creation requests
  for (const m of reply.matchAll(/<goal_create\s+title="([^"]*)">([\s\S]*?)<\/goal_create>/g)) {
    const title = m[1].trim();
    const description = m[2].trim();
    if (title) result.goalCreates.push({ title, description });
  }

  // Extract goal updates (attributes can appear in any order)
  result.goalUpdates = [];
  for (const m of reply.matchAll(/<goal_update\s([^>]*)>([\s\S]*?)<\/goal_update>/g)) {
    const attrs = m[1];
    const idMatch = attrs.match(/id="([^"]*)"/);
    if (!idMatch) continue;
    const update = { id: idMatch[1].trim() };
    const statusMatch = attrs.match(/status="([^"]*)"/);
    if (statusMatch) update.status = statusMatch[1].trim();
    const progressMatch = attrs.match(/progress="([^"]*)"/);
    if (progressMatch) update.progress = parseInt(progressMatch[1], 10);
    update.note = (m[2] || '').trim();
    result.goalUpdates.push(update);
  }

  // Extract milestone completions (attributes can appear in any order)
  result.milestoneCompletes = [];
  for (const m of reply.matchAll(/<milestone_complete\s([^>]*)>([\s\S]*?)<\/milestone_complete>/g)) {
    const attrs = m[1];
    const goalMatch = attrs.match(/goal="([^"]*)"/);
    if (!goalMatch) continue;
    const msMatch = attrs.match(/milestone="([^"]*)"/);
    result.milestoneCompletes.push({
      goalId: goalMatch[1].trim(),
      milestoneId: msMatch ? msMatch[1].trim() : '',
      evidence: (m[2] || '').trim(),
    });
  }

  // Extract dynamic skill generation requests
  // Format: <skill_generate name="Skill Name" category="productivity">One-sentence description</skill_generate>
  result.skillGenerates = [];
  for (const m of reply.matchAll(/<skill_generate\s([^>]*)>([\s\S]*?)<\/skill_generate>/g)) {
    const attrs = m[1];
    const nameMatch = attrs.match(/name="([^"]*)"/);
    if (!nameMatch) continue;
    const catMatch = attrs.match(/category="([^"]*)"/);
    result.skillGenerates.push({
      name: nameMatch[1].trim(),
      description: (m[2] || '').trim(),
      category: catMatch ? catMatch[1].trim() : 'utility',
    });
  }

  // Extract tool calls: <tool_call name="tool_name">{"param": "value"}</tool_call>
  result.toolCalls = parseToolCalls(reply);

  // Extract chain plans: <chain_plan>JSON workflow definition</chain_plan>
  result.chainPlans = [];
  for (const m of reply.matchAll(/<chain_plan>([\s\S]*?)<\/chain_plan>/g)) {
    try {
      const plan = JSON.parse(m[1].trim());
      result.chainPlans.push(plan);
    } catch {
      // Try to extract name and steps from non-JSON format
      result.chainPlans.push({ raw: m[1].trim() });
    }
  }

  // Extract lessons learned: <lesson_learned>text</lesson_learned>
  result.lessonsLearned = [];
  for (const m of reply.matchAll(/<lesson_learned>([\s\S]*?)<\/lesson_learned>/g)) {
    const lesson = m[1].trim();
    if (lesson) result.lessonsLearned.push(lesson);
  }

  // Extract capability gaps: <capability_gap topic="...">description</capability_gap>
  result.capabilityGaps = [];
  for (const m of reply.matchAll(/<capability_gap\s+topic="([^"]*)">([\s\S]*?)<\/capability_gap>/g)) {
    const topic = m[1].trim();
    const description = m[2].trim();
    if (topic && description) result.capabilityGaps.push({ topic, description });
  }

  // Extract experiment creation: <experiment_create>JSON</experiment_create>
  result.experimentCreates = [];
  for (const m of reply.matchAll(/<experiment_create>([\s\S]*?)<\/experiment_create>/g)) {
    try {
      const exp = JSON.parse(m[1].trim());
      if (exp.name && exp.hypothesis && exp.metric) result.experimentCreates.push(exp);
    } catch {}
  }

  // Extract goal proposals: <goal_propose title="..." rationale="...">milestones</goal_propose>
  result.goalProposals = [];
  for (const m of reply.matchAll(/<goal_propose\s+([^>]*)>([\s\S]*?)<\/goal_propose>/g)) {
    const attrs = m[1];
    const titleMatch = attrs.match(/title="([^"]*)"/);
    if (!titleMatch) continue;
    const rationaleMatch = attrs.match(/rationale="([^"]*)"/);
    const milestonesText = (m[2] || '').trim();
    const milestones = milestonesText ? milestonesText.split(/[;\n]/).map(s => s.trim()).filter(Boolean) : [];
    result.goalProposals.push({
      title: titleMatch[1].trim(),
      rationale: rationaleMatch ? rationaleMatch[1].trim() : '',
      milestones,
    });
  }

  // Extract reasoning journal entries
  result.hypotheses = [];
  for (const m of reply.matchAll(/<hypothesis>([\s\S]*?)<\/hypothesis>/g)) {
    const text = m[1].trim();
    if (text) result.hypotheses.push(text);
  }

  result.evidences = [];
  for (const m of reply.matchAll(/<evidence\s+hypothesis_id="(\d+)">([\s\S]*?)<\/evidence>/g)) {
    const hid = parseInt(m[1], 10);
    const text = m[2].trim();
    if (text && !isNaN(hid)) result.evidences.push({ hypothesisId: hid, text });
  }

  result.conclusions = [];
  for (const m of reply.matchAll(/<conclude\s+hypothesis_id="(\d+)">([\s\S]*?)<\/conclude>/g)) {
    const hid = parseInt(m[1], 10);
    const text = m[2].trim();
    if (text && !isNaN(hid)) result.conclusions.push({ hypothesisId: hid, text });
  }

  return result;
}

// ─── Run one cycle ──────────────────────────────────────────────────────────

async function runAgentCycle() {
  if (running) {
    log.warn('Agent cycle skipped — previous cycle still running');
    return;
  }
  if (stopped) return;

  running = true;
  const state = loadState();
  resetDailyBudgetIfNeeded(state);
  rollupCostsIfDue(state);
  qmdSyncIfDue(state);
  runPainPointAnalysis();          // detect chronic errors, WA instability, transfer deadlines
  state.cycleCount++;

  let nextIntervalMs = INTERVAL_MS;
  let parsed = null;

  try {
    wsEmit('agent:cycle:start', { cycleCount: state.cycleCount });
    recordEvent(state, 'agent:cycle:start', { cycleCount: state.cycleCount });

    // ── Phase 1: Signal Collection ──
    const rawSignals = collectSignals(state);
    const cooled = filterCooldowns(rawSignals, state);
    const signals = pickSignals(cooled, state);
    stampCooldowns(signals, state);
    state.lastSignals = signals.map(s => ({ type: s.type, urgency: s.urgency, summary: s.summary }));
    state.lastCycleAt = Date.now();

    wsEmit('agent:cycle:signals', { signalCount: signals.length, signals: state.lastSignals });
    recordEvent(state, 'agent:cycle:signals', { signalCount: signals.length });

    // Always-think: every Nth cycle, spawn Phase 2 even with zero signals
    const isReflectionCycle = signals.length === 0 && (state.cycleCount % ALWAYS_THINK_EVERY === 0);

    if (signals.length === 0 && !isReflectionCycle) {
      state.consecutiveSpawns = 0;
      recordEvent(state, 'agent:cycle:skip', { reason: 'no_signals' });
      saveState(state);
      wsEmit('agent:cycle:skip', { reason: 'no_signals' });
      log.info({ cycleCount: state.cycleCount }, 'Agent cycle: no signals, skipping Phase 2');
      return;
    }

    if (isReflectionCycle) {
      log.info({ cycleCount: state.cycleCount }, 'Agent cycle: reflection cycle (always-think), entering Phase 2');
    } else {
      log.info({ signals: signals.length, types: signals.map(s => s.type) }, 'Agent cycle: signals detected, entering Phase 2');
    }

    // ── Guards before Phase 2 ──

    // No daily budget cap — cost tracked but never blocks Phase 2

    // Consecutive spawn backoff
    if (state.consecutiveSpawns >= BACKOFF_THRESHOLD) {
      log.warn({ consecutiveSpawns: state.consecutiveSpawns }, 'Agent cycle: backoff — skipping one cycle');
      wsEmit('agent:cycle:skip', { reason: 'backoff' });
      recordEvent(state, 'agent:cycle:skip', { reason: 'backoff' });
      state.consecutiveSpawns = 0;
      saveState(state);
      return;
    }

    // ── Phase 2: Claude Reasoning ──

    let reply, costUsd;
    const hasHighOrCriticalSignal = signals.some(s => s.urgency === 'high' || s.urgency === 'critical');
    const hasCodeGoalWork = signals.some(s => s.type === 'goal_work' && CODE_KEYWORDS.test(s.data?.nextMilestone || ''));
    const hasCodeFollowup = signals.some(s => s.type === 'followup' && CODE_KEYWORDS.test(s.data?.topic || ''));
    // Sonnet for: high/critical signals, code goal work, code followups. Haiku for: reflection, low signals, non-code goals.
    // Cost self-awareness: skip Sonnet if agent is in cooldown from self-caused cost spike
    const sonnetCoolingDown = state.sonnetCooldownUntil > state.cycleCount;
    const useSonnet = !isReflectionCycle && !sonnetCoolingDown && (hasHighOrCriticalSignal || hasCodeGoalWork || hasCodeFollowup);
    if (sonnetCoolingDown && (hasHighOrCriticalSignal || hasCodeGoalWork || hasCodeFollowup)) {
      log.info({ cyclesLeft: state.sonnetCooldownUntil - state.cycleCount }, 'Sonnet cooldown active — using Haiku to reduce cost');
    }
    const model = useSonnet ? SONNET_MODEL : ROUTINE_MODEL;
    // Select free backend from router (checks all registered: ollama, nim, env-discovered)
    const freeBackend = !useSonnet ? await selectFreeBackend() : null;
    const backend = freeBackend || 'claude';
    const activeBackendModel = freeBackend ? (getBackend(freeBackend)?.model || model) : model;

    let slotAcquired = false;
    if (freeBackend) {
      log.info({ backend: freeBackend, model: activeBackendModel }, `Agent cycle: ${freeBackend} path`);
    }
    const goalsJsonMtimeBefore = getJsonMtime();
    try {
      // NIM uses a simpler prompt format (no MCP tool descriptions)
      const isNimLike = backend === 'nim';
      const prompt = isNimLike
        ? (isReflectionCycle ? buildNimReflectionPrompt() : buildNimPrompt(signals))
        : (isReflectionCycle ? buildReflectionPrompt() : buildAgentPrompt(signals));
      // Save prompt to file for inspection
      const promptFile = join(DIFFS_DIR, `cycle-${state.cycleCount}-prompt.txt`);
      try { writeFileSync(promptFile, prompt, 'utf-8'); } catch {}
      wsEmit('agent:cycle:phase2', { signalCount: signals.length, promptLen: prompt.length, reflection: isReflectionCycle, model, promptFile, backend });
      recordEvent(state, 'agent:cycle:phase2', { signalCount: signals.length, promptLen: prompt.length, reflection: isReflectionCycle, model, promptFile, backend });
      log.info({ cycle: state.cycleCount, promptLen: prompt.length, promptFile, backend }, 'Cycle prompt saved');

      let inputTokens, outputTokens, cacheRead, fileTouches;

      if (freeBackend) {
        // Route through LLM router (any registered free backend)
        try {
          const routerResult = await llmChat(prompt, {
            backend: freeBackend,
            systemPrompt: AGENT_SESSION_SYSTEM_PROMPT,
          });
          reply = routerResult.text;
          costUsd = routerResult.costUsd;
          inputTokens = routerResult.inputTokens;
          outputTokens = routerResult.outputTokens;
          cacheRead = 0;
          // Build fileTouches from tool log so cycle-diffs can audit
          const tools = routerResult.toolLog || [];
          fileTouches = tools.map(t => ({
            tool: t.tool === 'file_write' ? 'Write' : t.tool === 'file_read' ? 'Read' : 'Bash',
            file: t.path || '',
            command: t.tool === 'shell_exec' ? t.path : undefined,
          }));
          // Tool audit for diagnostics
          const writeCount = tools.filter(t => t.tool === 'file_write' && t.success).length;
          const shellCount = tools.filter(t => t.tool === 'shell_exec' && t.success).length;
          state.lastNimAudit = { toolCalls: tools.length, reads: tools.filter(t => t.tool === 'file_read').length, writes: writeCount, shells: shellCount };
          log.info({ backend: freeBackend, model: routerResult.model, inputTokens, outputTokens, toolCalls: tools.length, writes: writeCount, shells: shellCount }, 'Router cycle complete');
        } catch (routerErr) {
          log.warn({ err: routerErr.message, backend: freeBackend }, 'Free backend failed, falling back to persistent Claude');
          if (agentSessionTokens > SESSION_TOKEN_LIMIT) resetAgentSession('token_limit');
          else if (agentSessionCycles >= SESSION_CYCLE_LIMIT) resetAgentSession('cycle_limit');
          const result = await agentProc.send(prompt);
          reply = result.text;
          costUsd = result.costUsd || 0;
          inputTokens = result.inputTokens;
          outputTokens = result.outputTokens;
          cacheRead = result.cacheRead;
          fileTouches = [];
          agentSessionCycles++;
          agentSessionTokens += (inputTokens || 0) + (outputTokens || 0);
        }
      } else {
        // Sonnet cycle or all free backends unavailable — use persistent Claude process
        if (agentSessionTokens > SESSION_TOKEN_LIMIT) resetAgentSession('token_limit');
        else if (agentSessionCycles >= SESSION_CYCLE_LIMIT) resetAgentSession('cycle_limit');
        const result = await agentProc.send(prompt);
        reply = result.text;
        costUsd = result.costUsd || 0;
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        cacheRead = result.cacheRead;
        fileTouches = [];
        agentSessionCycles++;
        agentSessionTokens += (inputTokens || 0) + (outputTokens || 0);
      }

      state.lastCycleTokens = { input: inputTokens || 0, output: outputTokens || 0, cache: cacheRead || 0, model: activeBackendModel };
      state.lastCycleFileTouches = fileTouches || [];
    } finally {
      if (slotAcquired && queueRef) queueRef.releaseSlot();
    }

    // If Claude CLI wrote to goals.json directly (bypassing XML tags), import those changes
    // (skip for free backend cycles — these backends can't write files directly)
    if (backend === 'claude') try {
      const goalsJsonMtimeAfter = getJsonMtime();
      if (goalsJsonMtimeAfter > goalsJsonMtimeBefore) {
        const imported = importJsonChanges();
        if (imported > 0) log.info({ imported }, 'Agent cycle: imported direct goals.json edits from CLI');
      }
    } catch (err) {
      log.warn({ err: err.message }, 'Agent cycle: failed to check goals.json changes');
    }

    // Update state
    state.lastClaudeSpawnAt = Date.now();
    state.dailyCost += costUsd;
    if (useSonnet) state.dailySonnetCost += costUsd;
    state.consecutiveSpawns++;

    log.info({ replyLen: reply.length, costUsd: costUsd.toFixed(4), dailyCost: state.dailyCost.toFixed(2), dailySonnetCost: (state.dailySonnetCost || 0).toFixed(2), model: activeBackendModel, backend, tokens: state.lastCycleTokens }, 'Agent cycle Phase 2 complete');

    // Save response to file for inspection
    const replyFile = join(DIFFS_DIR, `cycle-${state.cycleCount}-reply.txt`);
    try { writeFileSync(replyFile, reply, 'utf-8'); } catch {}

    // Parse response
    parsed = parseAgentResponse(reply);

    // Post-cycle bid validation: detect if LLM placed bids exceeding financial limits
    if (signals.some(s => s.type === 'hattrick_autonomous_bid')) {
      try {
        const { validateBidCycleOutput } = await import('../modules/hattrick/hattrick.js');
        const { violations } = validateBidCycleOutput(reply);
        if (violations.length > 0) {
          const msg = violations.map(v => v.reason).join('; ');
          log.warn({ violations }, 'Bid cycle violation detected');
          try { notify(`⚠️ *BID VIOLATION* (cycle ${state.cycleCount}): ${msg}`); } catch {}
        }
      } catch (err) {
        // Module not loaded or missing — skip silently
      }
    }

    // NIM hallucination audit: if model claims actions but did no actual mutations, flag it
    if (backend === 'nim' && state.lastNimAudit) {
      const audit = state.lastNimAudit;
      const claimedActions = parsed.actionsTaken.length;
      const actualMutations = audit.writes + audit.shells;
      if (claimedActions > 0 && actualMutations === 0) {
        log.warn({ claimedActions, toolCalls: audit.toolCalls, reads: audit.reads, writes: audit.writes, shells: audit.shells },
          'NIM hallucination detected: model claimed actions but performed zero mutations');
        // Strip the fake actions — only keep ones that reference reading/investigating
        const readVerbs = /\b(read|check|inspect|review|investigat|analyz|look|scan|examin|view|pull|fetch|diagnos)\b/i;
        parsed.actionsTaken = parsed.actionsTaken.filter(a => readVerbs.test(a));
        // Suppress WhatsApp messages that reference non-existent work
        if (parsed.waMessages.length > 0) {
          log.warn({ msgCount: parsed.waMessages.length }, 'NIM hallucination: suppressing WhatsApp messages with unverified claims');
          parsed.waMessages = [];
        }
      }
    }

    // Route outbound messages by category to WhatsApp groups (or DM fallback)
    // Critical module signals (match lineup, bid deadline) bypass quiet hours
    const moduleCats = getModuleMessageCategories();
    const hasCriticalModule = signals.some(s =>
      Object.keys(moduleCats).some(prefix => s.type.startsWith(prefix)) &&
      (s.urgency === 'high' || s.urgency === 'critical')
    );
    const quiet = isQuietHours() && !hasCriticalModule;
    const msgCategory = getMessageCategory(signals);
    for (const msg of parsed.waMessages) {
      if (quiet) {
        log.info({ msgLen: msg.length }, 'Agent cycle: WhatsApp message suppressed (quiet hours)');
      } else {
        const sent = await sendToGroup(msgCategory, msg);
        if (sent) {
          recordBotReply('agent_cycle');
          log.info({ msgLen: msg.length, category: msgCategory }, 'Agent cycle: message sent via group routing');
        } else {
          log.error({ msgLen: msg.length }, 'Agent cycle: WhatsApp message FAILED to send — all adapters failed');
          try { notify(`⚠️ Agent cycle ${state.cycleCount}: WhatsApp message failed to deliver (${msg.length} chars)`); } catch {}
        }
      }
    }

    // Store follow-ups (cap at MAX_FOLLOWUPS, newest first)
    state.pendingFollowups = parsed.followups.slice(0, MAX_FOLLOWUPS);

    // Log actions taken + always notify via Telegram when work was done
    if (parsed.actionsTaken.length > 0) {
      log.info({ actions: parsed.actionsTaken }, 'Agent cycle: actions taken');
      wsEmit('agent:cycle:actions', { actions: parsed.actionsTaken });
      recordEvent(state, 'agent:cycle:actions', { actions: parsed.actionsTaken });

      // Always send a Telegram summary when actions are taken (regardless of quiet hours)
      const summary = parsed.actionsTaken.map((a, i) => `${i + 1}. ${a.slice(0, 200)}`).join('\n');
      try {
        const { notify: tgNotify } = await import('./notify.js');
        tgNotify(`*[Agent cycle ${state.cycleCount}]*\n${summary.slice(0, 4000)}`);
      } catch {}
    }

    // Cross-cycle memory: record actions for dedup in future cycles
    for (const sig of signals) {
      recordRecentAction(sig.type, sig.summary || sig.type);
    }
    if (parsed.actionsTaken?.length) {
      for (const a of parsed.actionsTaken) recordRecentAction('action', a);
    }

    // Module state writeback: update timestamps for module signals handled this cycle
    for (const { stateKey, map } of getModuleStateKeyMaps()) {
      const handled = signals.filter(s => map[s.type]).map(s => s.type);
      if (handled.length > 0) {
        const update = { lastCycleAt: Date.now() };
        for (const t of handled) update[map[t]] = Date.now();
        setState(stateKey, update);
        log.info({ stateKey, handled }, 'Module signal timestamps updated');
      }
    }

    // Create goal from first <goal_create> tag (max 1 per cycle, max 5 agent goals active, no duplicates)
    let goalCreatedTitle = null;
    if (parsed.goalCreates.length > 0) {
      try {
        const gc = parsed.goalCreates[0];
        // Check for duplicate: does a goal with similar title already exist?
        const allGoals = listGoals({});
        const titleLower = gc.title.toLowerCase();
        const duplicate = allGoals.find(g => {
          const t = g.title.toLowerCase();
          return t === titleLower || t.includes(titleLower) || titleLower.includes(t);
        });
        if (duplicate) {
          log.info({ existingId: duplicate.id, title: gc.title }, 'Agent cycle: skipped goal creation — similar goal already exists');
        } else {
          const agentGoals = allGoals.filter(g => g.source === 'agent' && (g.status === 'active' || g.status === 'in_progress'));
          if (agentGoals.length < 5) {
            const newGoal = addGoal(gc.title, { description: gc.description, source: 'agent' });
            goalCreatedTitle = gc.title;
            log.info({ goalId: newGoal.id, title: gc.title }, 'Agent cycle: goal created');
            wsEmit('agent:cycle:goal_created', { goalId: newGoal.id, title: gc.title });
            recordEvent(state, 'agent:cycle:goal_created', { goalId: newGoal.id, title: gc.title });
          } else {
            log.info('Agent cycle: skipped goal creation — 5 agent goals already active');
          }
        }
      } catch (err) {
        log.warn({ err: err.message }, 'Agent cycle: goal creation failed');
      }
    }

    // Process goal proposals from <goal_propose> tags (Phase 2: self-generated goals)
    for (const gp of parsed.goalProposals || []) {
      try {
        const { proposeGoal } = await import('./goals.js');
        const proposed = proposeGoal(gp.title, {
          rationale: gp.rationale,
          milestones: gp.milestones,
        });
        log.info({ goalId: proposed.id, title: gp.title }, 'Agent cycle: goal proposed');
        // Notify user via WhatsApp for approval
        if (!isQuietHours()) {
          const msText = gp.milestones.length > 0 ? `\nMilestones: ${gp.milestones.join(', ')}` : '';
          await sendToGroup('daily', `I'd like to create a goal: *${gp.title}*\n${gp.rationale}${msText}\n\nReply: Yes / No / Snooze`);
        }
        recordEvent(state, 'agent:cycle:goal_proposed', { goalId: proposed.id, title: gp.title });
      } catch (err) {
        log.warn({ err: err.message }, 'Agent cycle: goal proposal failed');
      }
    }

    // Process goal updates from <goal_update> tags
    for (const gu of parsed.goalUpdates || []) {
      try {
        const fields = {};
        if (gu.status) fields.status = gu.status;
        if (gu.progress !== undefined && !isNaN(gu.progress)) fields.progress = gu.progress;
        const updated = updateGoal(gu.id, fields);
        if (updated) {
          log.info({ goalId: gu.id, status: gu.status, progress: gu.progress }, 'Agent cycle: goal updated');
          wsEmit('agent:cycle:goal_updated', { goalId: gu.id });
        } else {
          log.warn({ goalId: gu.id }, 'Agent cycle: goal update failed — not found or invalid transition');
        }
      } catch (err) {
        log.warn({ err: err.message, goalId: gu.id }, 'Agent cycle: goal update error');
      }
    }

    // Process milestone completions from <milestone_complete> tags
    for (const mc of parsed.milestoneCompletes || []) {
      try {
        const ms = completeMilestone(mc.goalId, mc.milestoneId, mc.evidence || null, model);
        if (ms) {
          log.info({ goalId: mc.goalId, milestone: mc.milestoneId }, 'Agent cycle: milestone completed');
          wsEmit('agent:cycle:milestone_completed', { goalId: mc.goalId, milestoneId: mc.milestoneId });

          // Auto-coder: run tests + commit on Sonnet cycles (code was likely written)
          if (useSonnet) {
            try {
              const goal = listGoals().find(g => g.id === mc.goalId);
              const milestone = goal?.milestones?.find(m => m.id === mc.milestoneId);
              if (goal && milestone) {
                const testResult = await runTests();
                log.info({ passed: testResult.passed }, 'Auto-coder: post-milestone test run');
                if (testResult.passed) {
                  await commitAndReport(goal, milestone, mc.evidence || '', sendFn);
                } else {
                  log.warn({ output: testResult.output.slice(0, 300) }, 'Auto-coder: tests failed — not committing');
                  notify(`⚠️ *Auto-coder: tests failed after ${mc.milestoneId}*\n${testResult.output.slice(0, 300)}`);
                }
              }
            } catch (autoErr) {
              log.warn({ err: autoErr.message }, 'Auto-coder: post-milestone hook failed (non-fatal)');
            }
          }
        } else {
          log.warn({ goalId: mc.goalId, milestone: mc.milestoneId }, 'Agent cycle: milestone completion failed');
        }
      } catch (err) {
        log.warn({ err: err.message, goalId: mc.goalId }, 'Agent cycle: milestone completion error');
      }
    }

    // Process dynamic skill generation from <skill_generate> tags
    for (const sg of parsed.skillGenerates || []) {
      try {
        const slug = quickGenerateSkill(sg.name, sg.description, sg.category);
        log.info({ slug, name: sg.name }, 'Agent cycle: skill generated');
        wsEmit('agent:cycle:skill_generated', { slug, name: sg.name });
      } catch (err) {
        log.warn({ err: err.message, name: sg.name }, 'Agent cycle: skill generation failed');
      }
    }

    // Execute tool calls from <tool_call> tags (Phase 1: Tool Bridge)
    // Skip for NIM/Ollama — their client loops already execute tools during multi-round chat
    if (backend === 'claude') {
      for (const tc of parsed.toolCalls || []) {
        try {
          // Confidence gate check before execution
          const gate = gateAction('execute_tool', { targetExists: true, intentClarity: 0.7 });
          if (gate.action === 'ask') {
            log.info({ tool: tc.name, score: gate.score }, 'Agent cycle: tool blocked by confidence gate');
            if (!isQuietHours()) {
              await sendToGroup('daily', `I want to run tool *${tc.name}* but confidence is low (${gate.score}/10). Should I proceed?`);
            }
            continue;
          }
          const result = await executeTool(tc.name, tc.params);
          log.info({ tool: tc.name, success: result.success }, 'Agent cycle: tool executed');
          wsEmit('agent:cycle:tool_executed', { tool: tc.name, success: result.success });
          recordEvent(state, 'agent:cycle:tool_executed', { tool: tc.name, success: result.success });
        } catch (err) {
          log.warn({ err: err.message, tool: tc.name }, 'Agent cycle: tool execution error');
        }
      }
    }

    // Execute chain plans from <chain_plan> tags (Phase 2: Chain Planner)
    for (const cp of parsed.chainPlans || []) {
      try {
        // Confidence gate check before chain execution
        const gate = gateAction('run_chain', { targetExists: true, intentClarity: 0.6, reversible: false });
        if (gate.action === 'ask') {
          log.info({ plan: (cp.name || cp.raw || '').slice(0, 60), score: gate.score }, 'Agent cycle: chain blocked by confidence gate');
          if (!isQuietHours()) {
            await sendToGroup('daily', `I planned a workflow *${cp.name || '(unnamed)'}* but confidence is low (${gate.score}/10). Should I proceed?`);
          }
          continue;
        }
        if (cp.raw) {
          // Non-JSON chain plan — use chain-planner to decompose
          const { planChain, executeChain } = await import('./chain-planner.js');
          const plan = await planChain(cp.raw);
          if (plan) {
            const wf = executeChain(plan);
            log.info({ wfId: wf.id, name: plan.name, source: plan.source }, 'Agent cycle: chain started from raw plan');
            recordEvent(state, 'agent:cycle:chain_started', { wfId: wf.id, name: plan.name });
          }
        } else if (cp.name && cp.steps) {
          // Structured chain plan — create workflow directly
          const { executeChain } = await import('./chain-planner.js');
          const wf = executeChain(cp);
          log.info({ wfId: wf.id, name: cp.name, steps: cp.steps.length }, 'Agent cycle: chain started from structured plan');
          recordEvent(state, 'agent:cycle:chain_started', { wfId: wf.id, name: cp.name });
        }
      } catch (err) {
        log.warn({ err: err.message }, 'Agent cycle: chain plan execution error');
      }
    }

    // Process lessons learned from <lesson_learned> tags (Phase 6)
    for (const lesson of parsed.lessonsLearned || []) {
      try {
        const { recordLesson } = await import('./learning-journal.js');
        recordLesson(lesson, { action: 'agent_cycle', outcome: 'observed', cycle: state.cycleCount });
        log.info({ lesson: lesson.slice(0, 80) }, 'Agent cycle: lesson recorded');
      } catch (err) {
        log.warn({ err: err.message }, 'Agent cycle: lesson recording failed');
      }
    }

    // Process reasoning journal entries
    for (const hyp of parsed.hypotheses || []) {
      try {
        const result = addHypothesis(state.cycleCount, hyp, null, 0.5);
        log.info({ id: result.id, hyp: hyp.slice(0, 80) }, 'Agent cycle: hypothesis recorded');
      } catch (err) {
        log.warn({ err: err.message }, 'Agent cycle: hypothesis recording failed');
      }
    }
    for (const ev of parsed.evidences || []) {
      try {
        addEvidence(ev.hypothesisId, ev.text);
        log.info({ hid: ev.hypothesisId, ev: ev.text.slice(0, 80) }, 'Agent cycle: evidence recorded');
      } catch (err) {
        log.warn({ err: err.message }, 'Agent cycle: evidence recording failed');
      }
    }
    for (const conc of parsed.conclusions || []) {
      try {
        concludeHypothesis(conc.hypothesisId, conc.text);
        log.info({ hid: conc.hypothesisId, conc: conc.text.slice(0, 80) }, 'Agent cycle: conclusion recorded');
      } catch (err) {
        log.warn({ err: err.message }, 'Agent cycle: conclusion recording failed');
      }
    }

    // Process capability gaps from <capability_gap> tags (Phase 6)
    for (const gap of parsed.capabilityGaps || []) {
      try {
        const { recordGap } = await import('./capability-gaps.js');
        const result = recordGap(gap.description, gap.topic);
        log.info({ id: result.id, topic: gap.topic, occurrences: result.occurrences }, 'Agent cycle: capability gap recorded');
      } catch (err) {
        log.warn({ err: err.message }, 'Agent cycle: capability gap recording failed');
      }
    }

    // Process experiment creations from <experiment_create> tags (Phase 7)
    for (const exp of parsed.experimentCreates || []) {
      try {
        const { createExperiment, startExperiment } = await import('./experiments.js');
        const created = createExperiment(exp);
        startExperiment(created.id);
        log.info({ id: created.id, name: exp.name }, 'Agent cycle: experiment started');
      } catch (err) {
        log.warn({ err: err.message }, 'Agent cycle: experiment creation failed');
      }
    }

    // Save cycle diff for review
    try {
      saveCycleDiff(state.cycleCount, activeBackendModel, costUsd, parsed.actionsTaken, state.lastCycleFileTouches || []);
    } catch (err) {
      log.warn({ err: err.message }, 'Agent cycle: failed to save cycle diff');
    }

    // Adaptive timing
    if (parsed.nextCycleMinutes) {
      nextIntervalMs = parsed.nextCycleMinutes * 60_000;
      state.consecutiveRecycles = 0;
      log.info({ nextCycleMinutes: parsed.nextCycleMinutes }, 'Agent cycle: adaptive timing');
    } else if ((parsed.actionsTaken.length >= 2 || parsed.goalCreates.length > 0) && state.consecutiveRecycles < MAX_CONSECUTIVE_RECYCLES) {
      // Productive cycle — re-cycle quickly to verify and continue
      nextIntervalMs = RECYCLE_DELAY_MS;
      state.consecutiveRecycles++;
      log.info({ actionCount: parsed.actionsTaken.length, recycle: state.consecutiveRecycles, max: MAX_CONSECUTIVE_RECYCLES }, 'Agent cycle: productive — re-cycling in 2min');
    } else {
      if (state.consecutiveRecycles >= MAX_CONSECUTIVE_RECYCLES) {
        log.info({ consecutiveRecycles: state.consecutiveRecycles }, 'Agent cycle: re-cycle cap reached, returning to normal interval');
      }
      state.consecutiveRecycles = 0;
    }

    recordEvent(state, 'agent:cycle:complete', {
      costUsd, actionCount: parsed.actionsTaken.length,
      followupCount: parsed.followups.length,
    });
    saveState(state);
    wsEmit('agent:cycle:complete', {
      costUsd, waMessageCount: parsed.waMessages.length,
      followupCount: parsed.followups.length,
      actionCount: parsed.actionsTaken.length,
      goalCreated: goalCreatedTitle,
      nextCycleMinutes: parsed.nextCycleMinutes || INTERVAL_MS / 60_000,
    });
    log.info('Agent cycle complete');
  } catch (err) {
    wsEmit('agent:cycle:error', { error: err.message });
    recordEvent(state, 'agent:cycle:error', { error: err.message });
    log.warn({ err: err.message }, 'Agent cycle failed');

    // Phase 6: Route through error-recovery before giving up
    try {
      const { attemptRecovery } = await import('./error-recovery.js');
      const recovery = await attemptRecovery(err, null, {
        source: 'agent-loop',
        action: 'runAgentCycle',
        actionType: 'agent_cycle',
      });
      if (recovery.escalated) {
        log.warn({ rootCause: err.message.slice(0, 50) }, 'Agent cycle error escalated to user');
      }
    } catch (recErr) {
      log.warn({ err: recErr.message }, 'Error recovery itself failed');
    }

    // Reset session on error so next cycle starts fresh
    resetAgentSession('cycle_error');
    try {
      logError('error', 'agent-loop', `Cycle failed: ${err.message}`, err.stack, { cycleCount: state.cycleCount });
    } catch {}
    saveState(state);
  } finally {
    running = false;
    // Overnight throttling: extend interval to 60min during quiet hours (if not explicitly set)
    // Exception: keep 10min interval if a module has urgent work (e.g. match imminent)
    if (isQuietHours() && !parsed?.nextCycleMinutes && nextIntervalMs === INTERVAL_MS) {
      if (checkModuleUrgentWork()) {
        log.info('Agent cycle: quiet hours but module has urgent work — keeping 10min interval');
      } else {
        nextIntervalMs = 60 * 60_000;
        log.info('Agent cycle: overnight throttling enabled (60min interval)');
      }
    }
    scheduleNext(nextIntervalMs);
  }
}

// ─── Scheduling (chained setTimeout, not setInterval) ───────────────────────

let nextCycleAt = null;

function scheduleNext(delayMs) {
  if (stopped) return;
  nextCycleAt = Date.now() + delayMs;
  cycleTimer = setTimeout(() => {
    cycleTimer = null;
    runAgentCycle().catch(err => {
      log.error({ err: err.message }, 'Agent cycle unhandled error');
      try {
        logError('critical', 'agent-loop', `Unhandled error: ${err.message}`, err.stack);
        alertCrash('agent-loop', err);
      } catch {}
    });
  }, delayMs);
  cycleTimer.unref();
}

// ─── Message Category Routing ──────────────────────────────────────────────

function getMessageCategory(signals) {
  const moduleCats = getModuleMessageCategories();
  for (const s of signals) {
    for (const [prefix, category] of Object.entries(moduleCats)) {
      if (s.type.startsWith(prefix)) return category;
    }
  }
  if (signals.some(s => s.type === 'daily_digest' || s.type === 'reflection')) return 'daily';
  return 'daily';
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function startAgentLoop(send, queue) {
  sendFn = send;
  queueRef = queue || null;
  stopped = false;

  // Initialize pluggable LLM backends (Ollama, NIM, env-discovered)
  initBackends();

  // Spawn persistent Claude process for agent-loop Sonnet cycles
  agentProc = new PersistentProcess('agent', randomUUID(), AGENT_SESSION_SYSTEM_PROMPT, {
    model: SONNET_MODEL,
    timeout: config.cliTimeoutHattrick,         // 30 min (Hattrick MCP can be slow)
    activityTimeout: config.cliActivityTimeout,
    cacheKeepAlive: true,
  });

  // First cycle after 2 minutes (let the bot stabilize)
  nextCycleAt = Date.now() + 2 * 60_000;
  startupTimer = setTimeout(() => {
    startupTimer = null;
    runAgentCycle().catch(err => {
      log.error({ err: err.message }, 'Agent cycle startup error');
      try { logError('warning', 'agent-loop', `Startup error: ${err.message}`, err.stack); } catch {}
    });
  }, 2 * 60_000);
  startupTimer.unref();

  log.info({ intervalMin: INTERVAL_MS / 60_000, routineModel: ROUTINE_MODEL, sonnetModel: SONNET_MODEL, alwaysThinkEvery: ALWAYS_THINK_EVERY }, 'Agent loop started (autonomous)');
}

export function triggerCycleNow() {
  if (stopped) return { triggered: false, reason: 'loop_stopped' };
  if (running) return { triggered: false, reason: 'cycle_already_running' };
  // Clear existing timers
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (cycleTimer) { clearTimeout(cycleTimer); cycleTimer = null; }
  // Run immediately
  nextCycleAt = Date.now();
  runAgentCycle().catch(err => {
    log.error({ err: err.message }, 'Agent cycle manual trigger error');
    try { logError('warning', 'agent-loop', `Manual trigger error: ${err.message}`, err.stack); } catch {}
  });
  log.info('Agent cycle manually triggered');
  return { triggered: true };
}

export function stopAgentLoop() {
  stopped = true;
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (cycleTimer) {
    clearTimeout(cycleTimer);
    cycleTimer = null;
  }
  agentProc?.shutdown();
  agentProc = null;
  log.info('Agent loop stopped');
}

export function getAgentLoopStatus() {
  const state = loadState();
  const ctx = getContextStats();
  return {
    running: !stopped && (startupTimer !== null || cycleTimer !== null || running),
    cycleRunning: running,
    nextCycleAt: nextCycleAt ? new Date(nextCycleAt).toISOString() : null,
    lastCycleAt: state.lastCycleAt ? new Date(state.lastCycleAt).toISOString() : null,
    lastClaudeSpawnAt: state.lastClaudeSpawnAt ? new Date(state.lastClaudeSpawnAt).toISOString() : null,
    intervalMin: INTERVAL_MS / 60_000,
    dailyCost: state.dailyCost?.toFixed(2) || '0.00',
    dailySonnetCost: state.dailySonnetCost?.toFixed(2) || '0.00',
    routineModel: ROUTINE_MODEL,
    sonnetModel: SONNET_MODEL,
    cycleCount: state.cycleCount || 0,
    consecutiveSpawns: state.consecutiveSpawns || 0,
    pendingFollowups: state.pendingFollowups?.length || 0,
    lastSignals: state.lastSignals || [],
    lastCycleTokens: state.lastCycleTokens || null,
    lastCycleFileTouches: state.lastCycleFileTouches || [],
    context: {
      sessionTokens: ctx.sessionTokens,
      tokenLimit: ctx.tokenLimit,
      pct: ctx.pct,
      msgCount: ctx.sessionMsgCount,
    },
    mode: 'autonomous',
    agentSession: {
      alive: agentProc?.getStats()?.alive || false,
      cycles: agentSessionCycles,
      tokens: agentSessionTokens,
      limit: SESSION_TOKEN_LIMIT,
      messageCount: agentProc?.getStats()?.messageCount || 0,
    },
  };
}

export function getAgentLoopDetail() {
  const state = loadState();
  // Merge persisted events with live buffer (dedup by event+ts key)
  const persisted = state.recentEvents || [];
  const seen = new Set(persisted.map(e => e.event + ':' + e.ts));
  const merged = [...persisted];
  for (const le of liveEvents) {
    const key = le.event + ':' + le.ts;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(le);
    }
  }
  // Also merge CLI spawn events from claude.js (not persisted in agent-loop state)
  for (const ce of getRecentCliEvents()) {
    const key = ce.event + ':' + ce.ts;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(ce);
    }
  }
  merged.sort((a, b) => a.ts - b.ts);
  const trimmed = merged.slice(-MAX_RECENT_EVENTS);
  return {
    ...getAgentLoopStatus(),
    pendingFollowups: state.pendingFollowups || [],
    lastSignals: state.lastSignals || [],
    recentEvents: trimmed,
  };
}

/**
 * Parse agent response XML tags. Exported for testing.
 * @param {string} reply - Raw LLM response string
 * @returns {{ waMessages, followups, nextCycleMinutes, actionsTaken, goalCreates, goalUpdates, milestoneCompletes }}
 */
export { parseAgentResponse };

/**
 * Call when user sends a message — captures user reaction for outcome tracking.
 * Also feeds trust engine with positive/negative signal (Phase 3).
 */
export function trackUserEngagement(userText = '') {
  if (userText) {
    try { captureUserReaction(userText); } catch {}
    // Phase 3: Feed trust engine with feedback
    try {
      import('./trust-engine.js').then(({ recordOutcome }) => {
        // Simple heuristic: short positive/negative replies after agent actions
        const posRe = /^[\s\W]*(perfect|great|excellent|exactly|works|done|love it|👍|✅|💯|🔥|תותח|מעולה|אחלה)[\s\W]*$/i;
        const negRe = /^[\s\W]*(wrong|broken|useless|failed|not what|👎|❌|לא עובד|שגוי)[\s\W]*$/i;
        const trimmed = userText.trim();
        if (trimmed.length <= 50) {
          if (posRe.test(trimmed)) recordOutcome('send_message', true, { reason: 'user_positive_feedback' });
          else if (negRe.test(trimmed)) recordOutcome('send_message', false, { reason: 'user_negative_feedback' });
        }
      }).catch(() => {});
    } catch {}
  }
}
