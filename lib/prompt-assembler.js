/**
 * Prompt Assembler — Dynamic system prompt construction with tiered assembly.
 *
 * Replaces monolithic buildSystemPrompt() in claude.js with 3 tiers:
 * - Minimal (~2KB): SOUL core (30 lines), time context, active topic
 * - Standard (~5KB): Minimal + top 3 relevant skills, active goals summary, recent memory
 * - Full (~12KB): Standard + all skills, all goals, daily notes, plugin context
 *
 * Tier auto-selected by: message complexity, context-gate pressure, cost budget.
 * Also supports mood-aware tier selection (Phase 5 integration).
 */

import { readFileSync } from 'fs';
import { createLogger } from './logger.js';
import { listSkills, getSkill } from './skills.js';
import { autoDetect as registryAutoDetect } from './skill-registry.js';
import { getGoalsContext, listGoals } from './goals.js';
import { getCronSummary } from './crons.js';
import { listTools } from './tool-bridge.js';
import config from './config.js';
import { formatReasoningContext } from './reasoning-journal.js';
import { formatUserModelContext } from './user-model.js';

const log = createLogger('prompt-assembler');

const SOUL_PATH = config.soulPath;
const BOT_MEMORY_PATH = config.memoryPath;

// --- SOUL Core (minimal, ~30 lines) ---
// Extracted essential personality lines from SOUL.md

function loadSoulCore() {
  try {
    const full = readFileSync(SOUL_PATH, 'utf-8');
    // Take first ~30 lines (core personality + communication style)
    const lines = full.split('\n');
    const coreLines = lines.slice(0, 30).join('\n');
    return coreLines;
  } catch {
    return 'You are the user\'s personal AI agent. Be concise, proactive, and helpful.';
  }
}

function loadFullSoul() {
  try {
    return readFileSync(SOUL_PATH, 'utf-8');
  } catch {
    return '';
  }
}

function loadBotMemory() {
  try {
    return readFileSync(BOT_MEMORY_PATH, 'utf-8');
  } catch {
    return '';
  }
}

// --- Base system prompt (capabilities) ---
// Stripped-down version of what's in claude.js

const CAPABILITIES_MINIMAL = `You are Claude, the user's personal AI agent on WhatsApp.

## Capabilities
- Bash, Read/Write/Edit, Glob/Grep, WebSearch/WebFetch, Vestige MCP
- Bot MCP tools: bot_status, bot_list_crons, bot_cron_*, bot_goal_*, bot_*_notes
- External tools via [TOOL_CALL: name | params] or <tool_call name="...">params</tool_call>

## Rules
- Hebrew dates: "אתמול" = yesterday, "שלשום" = 2 days ago
- Cron prompts must be self-contained
- WhatsApp formatting only: *bold*, _italic_, \`\`\`code\`\`\`, bullets`;

const CAPABILITIES_STANDARD = `### Direct tools (Claude Code built-in)
FULL access to the user's machine:
- *Bash*: any shell command (git, npm, python, docker, pm2, curl, etc.)
- *Read/Write/Edit*: files anywhere in ~/
- *Glob/Grep*: search across the entire filesystem
- *WebSearch/WebFetch*: look up anything on the internet
- *Vestige MCP*: persistent memory with semantic search

### Bot Operations (MCP tools)
- bot_status, bot_list_crons, bot_cron_add/delete/toggle/run
- bot_list_files, bot_list_skills, bot_today_notes, bot_search_notes
- bot_goal_list/add/update/complete/milestone_add/milestone_complete/detail`;

const CODING_RULES = `## Coding agent rules
When writing/fixing code:
- Read and understand existing code first
- Keep changes minimal
- Run existing tests if available
- Report what changed, passed, and failed
- If something fails, diagnose and fix it`;

/**
 * Estimate token count from text (rough: ~4 chars/token for English, ~2 for Hebrew).
 */
function estimateTokens(text) {
  if (!text) return 0;
  // Hebrew characters are roughly 2 chars per token, ASCII ~4 chars per token
  const hebrewCount = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const otherCount = text.length - hebrewCount;
  return Math.ceil(hebrewCount / 2 + otherCount / 4);
}

/**
 * Determine the appropriate tier based on message context.
 * @param {object} opts - { userMessage, contextPressure, moodState, costBudgetPct }
 * @returns {'minimal'|'standard'|'full'}
 */
export function selectTier(opts = {}) {
  const { userMessage = '', contextPressure = 0, moodState = null, costBudgetPct = 0 } = opts;

  // Force minimal for stressed mood (Phase 5)
  if (moodState?.context === 'stressed' && moodState?.valence === 'negative') {
    return 'minimal';
  }

  // Force minimal under high context pressure
  if (contextPressure > 0.8) {
    return 'minimal';
  }

  // Force minimal if cost budget is high (>80% used)
  if (costBudgetPct > 80) {
    return 'minimal';
  }

  // Use message complexity to determine tier
  const msgLen = userMessage.length;
  if (msgLen < 20) return config.promptTierDefault || 'standard'; // short message — use default
  if (msgLen > 200) return 'full'; // long/complex message — full context

  // Check if message mentions code/technical work
  const codeRe = /\b(code|fix|bug|implement|create|build|deploy|error|npm|git|test)\b/i;
  if (codeRe.test(userMessage)) return 'full';

  return config.promptTierDefault || 'standard';
}

/**
 * Assemble system prompt for a given tier.
 * @param {'minimal'|'standard'|'full'} tier
 * @param {object} opts - { userMessage, matchedSkills[], relevantMemories }
 *   relevantMemories: pre-fetched Vestige results (top-5) to replace static MEMORY.md
 * @returns {{ prompt: string, tokens: number, tier: string }}
 */
export function assemblePrompt(tier = 'standard', opts = {}) {
  const { userMessage = '', matchedSkills = [], relevantMemories = '' } = opts;
  const parts = [];

  switch (tier) {
    case 'minimal': {
      parts.push('You are Claude, the user\'s personal AI agent on WhatsApp.');
      parts.push(loadSoulCore());
      parts.push(CAPABILITIES_MINIMAL);

      // Selective memories only (Mem0 pattern: no static MEMORY.md, only per-message relevant facts)
      if (relevantMemories) {
        parts.push(`\n## Relevant memories:\n${relevantMemories}`);
      }

      // Time context
      const now = new Date().toLocaleString('en-IL', { timeZone: config.timezone });
      parts.push(`\nCurrent time: ${now} (${config.timezone})`);

      break;
    }

    case 'standard': {
      parts.push('You are Claude, the user\'s personal AI agent on WhatsApp. Your personality and communication style are defined in the Soul section below.');
      parts.push(`\n## Soul\n${loadSoulCore()}`);
      parts.push(`\n## Capabilities\n${CAPABILITIES_STANDARD}`);

      // Tool bridge tools
      try {
        const tools = listTools();
        if (tools.length > 0) {
          parts.push(`\n### External Tools\n${tools.map(t => `- *${t.name}*: ${t.description.slice(0, 60)}`).join('\n')}`);
        }
      } catch {}

      // Top 3 relevant skills (not all)
      const topSkills = matchedSkills.slice(0, 3);
      if (topSkills.length > 0) {
        const skillTexts = topSkills.map(name => {
          const content = getSkill(name);
          return content ? `### ${name}\n${content.slice(0, config.claudeSkillContextLimit || 2000)}` : null;
        }).filter(Boolean);
        if (skillTexts.length > 0) {
          parts.push(`\n## Relevant Skills\n${skillTexts.join('\n\n')}`);
        }
      }

      // Active goals summary (compact)
      try {
        const goals = listGoals({ status: ['active', 'in_progress'] });
        if (goals.length > 0) {
          const goalSummary = goals.slice(0, 5).map(g =>
            `- ${g.title} (${g.status}, ${g.progress || 0}%)`
          ).join('\n');
          parts.push(`\n## Active Goals\n${goalSummary}`);
        }
      } catch {}

      // Selective memories (Mem0 pattern): use per-message relevant facts instead of full MEMORY.md
      // Per-message memories loaded dynamically by buildContext() → memory-index.search()
      if (relevantMemories) {
        parts.push(`\n## Relevant memories:\n${relevantMemories}`);
      }
      // No static MEMORY.md — saves ~500 tokens in system prompt

      // Reasoning journal context
      try {
        const reasoningCtx = formatReasoningContext();
        if (reasoningCtx) parts.push(`\n${reasoningCtx}`);
      } catch {}

      // User model context
      try {
        const userModelCtx = formatUserModelContext();
        if (userModelCtx) parts.push(`\n${userModelCtx}`);
      } catch {}

      parts.push(`\n${CODING_RULES}`);

      // Time context
      const now = new Date().toLocaleString('en-IL', { timeZone: config.timezone });
      parts.push(`\nCurrent time: ${now} (${config.timezone})`);

      break;
    }

    case 'full': {
      // Full prompt — similar to original buildSystemPrompt()
      parts.push('You are Claude, the user\'s personal AI agent on WhatsApp. Your personality and communication style are defined in the Soul section below.');
      parts.push(`\n## Soul (personality & rules)\n${loadFullSoul()}`);
      parts.push(`\n## Capabilities\n${CAPABILITIES_STANDARD}`);

      // All tools
      try {
        const tools = listTools();
        if (tools.length > 0) {
          parts.push(`\n### External Tools (Tool Bridge)\n${tools.map(t => `- *${t.name}*: ${t.description}`).join('\n')}`);
        }
      } catch {}

      // All skills list
      try {
        const names = listSkills();
        if (names.length > 0) {
          parts.push(`\n## Available skills\n${names.join(', ')}`);
        }
      } catch {}

      // Matched skill content
      if (matchedSkills.length > 0) {
        const skillTexts = matchedSkills.map(name => {
          const content = getSkill(name);
          return content ? `### ${name}\n${content.slice(0, config.claudeSkillContextLimit || 2000)}` : null;
        }).filter(Boolean);
        if (skillTexts.length > 0) {
          parts.push(`\n## Loaded Skills\n${skillTexts.join('\n\n')}`);
        }
      }

      // Full goals context
      try {
        const goalsCtx = getGoalsContext();
        if (goalsCtx) parts.push(`\n## Goals\n${goalsCtx}`);
      } catch {}

      // Full bot memory
      const mem = loadBotMemory();
      if (mem) parts.push(`\n## Bot Memory (self-updating)\n${mem}`);

      // Reasoning journal context
      try {
        const reasoningCtx = formatReasoningContext();
        if (reasoningCtx) parts.push(`\n${reasoningCtx}`);
      } catch {}

      // User model context
      try {
        const userModelCtx = formatUserModelContext();
        if (userModelCtx) parts.push(`\n${userModelCtx}`);
      } catch {}

      parts.push(`\n${CODING_RULES}`);

      // Time context
      const now = new Date().toLocaleString('en-IL', { timeZone: config.timezone });
      parts.push(`\nCurrent time: ${now} (${config.timezone})`);

      break;
    }
  }

  const prompt = parts.join('\n');
  const tokens = estimateTokens(prompt);

  log.info({ tier, tokens, charLen: prompt.length, matchedSkills: matchedSkills.length }, 'Prompt assembled');

  return { prompt, tokens, tier };
}

/**
 * Get prompt size comparison across tiers.
 */
export function getPromptSizeComparison() {
  const minimal = assemblePrompt('minimal');
  const standard = assemblePrompt('standard');
  const full = assemblePrompt('full');

  return {
    minimal: { chars: minimal.prompt.length, tokens: minimal.tokens },
    standard: { chars: standard.prompt.length, tokens: standard.tokens },
    full: { chars: full.prompt.length, tokens: full.tokens },
  };
}
