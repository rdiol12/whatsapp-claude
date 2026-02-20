/**
 * NLU Handler — Executes intents classified by nlu-router.js
 *
 * This module maps intent names to handler functions. Each handler
 * receives (sock, sender, params, msg, botApi) and returns true if it
 * handled the message, false if it should fall through to Claude.
 *
 * Integration: whatsapp.js calls `handleIntent()` before the Claude pipeline.
 */

import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { clear } from './history.js';
import { listSkills, getSkill, addSkill, deleteSkill } from './skills.js';
import { reloadSkills } from './claude.js';
import { getCronSummary } from './crons.js';
import { getGoalSummary, getGoalDetail, addGoal, updateGoal, addMilestone, completeMilestone, getGoal } from './goals.js';
import { getBrainStatus } from './agent-brain.js';
import { getWorkflowSummary, getWorkflowDetail, cancelWorkflow, pauseWorkflow, resumeWorkflow, listWorkflows } from './workflow-engine.js';
import { getTodayNotes, getNotesForDate } from './daily-notes.js';
import { isConnected as isMcpConnected } from './mcp-gateway.js';
import { createLogger } from './logger.js';

const log = createLogger('nlu-handler');

/**
 * Send a message and track its ID to prevent echo loops.
 * Returns the sent message (for reaction tracking, etc).
 */
async function reply(sock, sender, text, sentMessageIds) {
  const MAX_CHUNK = 4000;
  const chunks = [];
  let remaining = text;

  while (remaining.length > MAX_CHUNK) {
    let splitIdx = remaining.lastIndexOf('\n\n', MAX_CHUNK);
    if (splitIdx < MAX_CHUNK * 0.3) splitIdx = remaining.lastIndexOf('\n', MAX_CHUNK);
    if (splitIdx < MAX_CHUNK * 0.3) splitIdx = remaining.lastIndexOf(' ', MAX_CHUNK);
    if (splitIdx < MAX_CHUNK * 0.3) splitIdx = MAX_CHUNK;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);

  let lastSent;
  for (const chunk of chunks) {
    const sent = await sock.sendMessage(sender, { text: chunk });
    if (sent?.key?.id) sentMessageIds.set(sent.key.id, Date.now());
    lastSent = sent;
  }
  return lastSent;
}

// ---------------------------------------------------------------------------
// Intent handlers — each returns true (handled) or false (fall through)
// ---------------------------------------------------------------------------

const handlers = {

  async status(sock, sender, params, msg, botApi, sentMessageIds) {
    const upSec = process.uptime();
    const upStr = upSec < 3600
      ? `${(upSec / 60).toFixed(0)}m`
      : `${(upSec / 3600).toFixed(1)}h`;
    const mem = process.memoryUsage();
    const memStr = `${(mem.rss / 1048576).toFixed(0)}MB`;
    const qStats = botApi?._queue?.stats() || { running: '?', waiting: '?' };
    const mcp = isMcpConnected() ? 'connected' : 'disconnected';
    const status = `*Bot Status*
Uptime: ${upStr}
Memory: ${memStr}
Model: ${config.claudeModel}
Queue: ${qStats.running} running, ${qStats.waiting} waiting
Vestige MCP: ${mcp}
Crons: ${getCronSummary().split('\n').length} jobs`;
    await reply(sock, sender, status, sentMessageIds);
    return true;
  },

  async clear(sock, sender, params, msg, botApi, sentMessageIds) {
    clear(sender);
    await reply(sock, sender, 'Conversation history cleared.', sentMessageIds);
    return true;
  },

  async help(sock, sender, params, msg, botApi, sentMessageIds) {
    const help = `*Commands:*
/help - this list
/status - bot health & stats
/goals - list active goals
/goal add <title> - create a goal
/goal <name> - goal details
/goal review - goal progress review
/brain - agent observations & patterns
/wf - list active workflows
/wf status <id> - workflow details
/wf cancel/pause/resume <id>
/crons - list scheduled jobs
/today - today's conversation notes
/clear - clear conversation history
/skills - list available skills
/skill <name> - show skill content
/addskill <name> - add/update skill
/delskill <name> - delete skill
/files - list workspace files
/send <path> - send file from workspace
/save <url> - save URL to knowledge base

_You can also just ask in natural language._
_Example: "what are my goals?" = /goals_`;
    await reply(sock, sender, help, sentMessageIds);
    return true;
  },

  async crons(sock, sender, params, msg, botApi, sentMessageIds) {
    const summary = getCronSummary();
    await reply(sock, sender, `*Cron Jobs:*\n${summary}`, sentMessageIds);
    return true;
  },

  async today(sock, sender, params, msg, botApi, sentMessageIds) {
    const notes = getTodayNotes() || 'No notes yet today.';
    await reply(sock, sender, notes, sentMessageIds);
    return true;
  },

  async notes(sock, sender, params, msg, botApi, sentMessageIds) {
    if (!params?.date) {
      await reply(sock, sender, 'Which date? Try "notes for yesterday" or "notes 2025-01-15"', sentMessageIds);
      return true;
    }
    const notes = getNotesForDate(params.date);
    if (!notes) {
      await reply(sock, sender, `No notes for ${params.date}.`, sentMessageIds);
    } else {
      await reply(sock, sender, notes, sentMessageIds);
    }
    return true;
  },

  async skills(sock, sender, params, msg, botApi, sentMessageIds) {
    const names = listSkills();
    const text = names.length
      ? `*Skills (${names.length}):*\n${names.map(n => `- ${n}`).join('\n')}\n\n_Ask "show me skill <name>" for details._`
      : 'No skills loaded.';
    await reply(sock, sender, text, sentMessageIds);
    return true;
  },

  async skill(sock, sender, params, msg, botApi, sentMessageIds) {
    if (!params?.name) {
      await reply(sock, sender, 'Which skill? Try "show me skill humanizer" or /skills to list.', sentMessageIds);
      return true;
    }
    const content = getSkill(params.name);
    const text = content
      ? `*Skill: ${params.name}*\n\n${content.slice(0, 3500)}`
      : `Skill "${params.name}" not found. Use /skills to see available.`;
    await reply(sock, sender, text, sentMessageIds);
    return true;
  },

  async addskill(sock, sender, params, msg, botApi, sentMessageIds) {
    if (!params?.name || !params?.content) {
      await reply(sock, sender, 'Usage: /addskill <name>\n<skill content on next lines>', sentMessageIds);
      return true;
    }
    const saved = addSkill(params.name, params.content);
    reloadSkills();
    await reply(sock, sender, `Skill *${saved}* added. (${params.content.length} chars)`, sentMessageIds);
    return true;
  },

  async delskill(sock, sender, params, msg, botApi, sentMessageIds) {
    if (!params?.name) {
      await reply(sock, sender, 'Which skill to delete? Example: "delete skill humanizer"', sentMessageIds);
      return true;
    }
    const ok = deleteSkill(params.name);
    reloadSkills();
    const text = ok ? `Skill *${params.name}* deleted.` : `Skill "${params.name}" not found.`;
    await reply(sock, sender, text, sentMessageIds);
    return true;
  },

  async goals(sock, sender, params, msg, botApi, sentMessageIds) {
    const summary = getGoalSummary();
    await reply(sock, sender, `*Goals:*\n${summary}`, sentMessageIds);
    return true;
  },

  async 'goal-manage'(sock, sender, params, msg, botApi, sentMessageIds) {
    const { subCmd, arg } = params || {};
    if (!subCmd) {
      await reply(sock, sender, 'Usage: /goal add <title> | /goal <name> | /goal review', sentMessageIds);
      return true;
    }

    if (subCmd === 'add' && arg) {
      const goal = addGoal(arg);
      await reply(sock, sender, `Goal created: *${goal.title}*\nID: ${goal.id}\n\nWant me to break it into milestones?`, sentMessageIds);
      return true;
    }

    if (subCmd === 'review') {
      const summary = getGoalSummary();
      await reply(sock, sender, `*Goal Review:*\n${summary}`, sentMessageIds);
      return true;
    }

    // Default: show detail for a goal matching subCmd + arg
    const query = arg ? `${subCmd} ${arg}` : subCmd;
    const detail = getGoalDetail(query);
    if (detail) {
      await reply(sock, sender, detail, sentMessageIds);
    } else {
      await reply(sock, sender, `Goal "${query}" not found. Use /goals to list.`, sentMessageIds);
    }
    return true;
  },

  async brain(sock, sender, params, msg, botApi, sentMessageIds) {
    const status = getBrainStatus();
    await reply(sock, sender, status, sentMessageIds);
    return true;
  },

  async workflows(sock, sender, params, msg, botApi, sentMessageIds) {
    const summary = getWorkflowSummary();
    await reply(sock, sender, `*Workflows:*\n${summary}`, sentMessageIds);
    return true;
  },

  async 'workflow-manage'(sock, sender, params, msg, botApi, sentMessageIds) {
    const { subCmd, arg } = params || {};
    if (!subCmd) {
      await reply(sock, sender, 'Usage: /wf list | /wf status <id> | /wf cancel <id> | /wf pause <id> | /wf resume <id>', sentMessageIds);
      return true;
    }

    if (subCmd === 'list' || subCmd === 'ls') {
      const wfs = listWorkflows();
      if (wfs.length === 0) {
        await reply(sock, sender, 'No workflows.', sentMessageIds);
      } else {
        const lines = wfs.slice(0, 15).map(w => {
          const pct = w.steps > 0 ? Math.round((w.completed / w.steps) * 100) : 0;
          return `- *${w.name}* [${w.status}] ${w.completed}/${w.steps} (${pct}%) — ${w.id}`;
        });
        await reply(sock, sender, `*Workflows (${wfs.length}):*\n${lines.join('\n')}`, sentMessageIds);
      }
      return true;
    }

    if (subCmd === 'status' || subCmd === 'detail' || subCmd === 'info') {
      if (!arg) {
        await reply(sock, sender, 'Which workflow? /wf status <id>', sentMessageIds);
        return true;
      }
      const detail = getWorkflowDetail(arg);
      if (!detail) {
        await reply(sock, sender, `Workflow "${arg}" not found.`, sentMessageIds);
      } else {
        await reply(sock, sender, detail, sentMessageIds);
      }
      return true;
    }

    if (subCmd === 'cancel' || subCmd === 'stop' || subCmd === 'abort') {
      if (!arg) {
        await reply(sock, sender, 'Which workflow? /wf cancel <id>', sentMessageIds);
        return true;
      }
      const wf = cancelWorkflow(arg);
      await reply(sock, sender, wf ? `Workflow *${wf.name}* cancelled.` : `Workflow "${arg}" not found or already done.`, sentMessageIds);
      return true;
    }

    if (subCmd === 'pause') {
      if (!arg) {
        await reply(sock, sender, 'Which workflow? /wf pause <id>', sentMessageIds);
        return true;
      }
      const wf = pauseWorkflow(arg);
      await reply(sock, sender, wf ? `Workflow *${wf.name}* paused.` : `Workflow "${arg}" not found or can't be paused.`, sentMessageIds);
      return true;
    }

    if (subCmd === 'resume') {
      if (!arg) {
        await reply(sock, sender, 'Which workflow? /wf resume <id>', sentMessageIds);
        return true;
      }
      const wf = resumeWorkflow(arg);
      await reply(sock, sender, wf ? `Workflow *${wf.name}* resumed.` : `Workflow "${arg}" not found or not paused.`, sentMessageIds);
      return true;
    }

    // Default: try to show status for the arg
    const detail = getWorkflowDetail(subCmd + (arg ? ` ${arg}` : ''));
    if (detail) {
      await reply(sock, sender, detail, sentMessageIds);
    } else {
      await reply(sock, sender, 'Usage: /wf list | /wf status <id> | /wf cancel <id> | /wf pause <id> | /wf resume <id>', sentMessageIds);
    }
    return true;
  },

  async files(sock, sender, params, msg, botApi, sentMessageIds) {
    try {
      const files = readdirSync(config.workspaceDir);
      if (files.length === 0) {
        await reply(sock, sender, 'Workspace is empty.', sentMessageIds);
      } else {
        const listing = files.map(f => {
          try {
            const st = statSync(join(config.workspaceDir, f));
            const size = st.size < 1024 ? `${st.size}B`
              : st.size < 1048576 ? `${(st.size / 1024).toFixed(1)}KB`
              : `${(st.size / 1048576).toFixed(1)}MB`;
            return `- ${f} (${size})`;
          } catch {
            return `- ${f}`;
          }
        }).join('\n');
        await reply(sock, sender, `*Workspace files (${files.length}):*\n${listing}`, sentMessageIds);
      }
    } catch (err) {
      await reply(sock, sender, `Error listing files: ${err.message}`, sentMessageIds);
    }
    return true;
  },

  // /send and /save return false → they need special handling in whatsapp.js
  // (send needs sendFileToWhatsApp, save needs Claude pipeline)
  // We return the params so whatsapp.js can use them directly.

  async send() {
    // Handled in whatsapp.js with sendFileToWhatsApp
    return 'delegate';
  },

  async save() {
    // Handled in whatsapp.js with Claude pipeline (fall-through with rewritten prompt)
    return 'delegate';
  },
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Handle a classified intent.
 *
 * @param {object} classification - { intent, confidence, params } from nlu-router.classify()
 * @param {object} sock - Baileys socket
 * @param {string} sender - JID
 * @param {object} msg - Original Baileys message
 * @param {object} botApi - Bot API object (plugins, queue, etc)
 * @param {Map} sentMessageIds - Map of sent message IDs (for echo prevention)
 * @returns {boolean|'delegate'} true=handled, false=not handled, 'delegate'=needs special handling
 */
export async function handleIntent(classification, sock, sender, msg, botApi, sentMessageIds) {
  const { intent, confidence, params } = classification;

  const handler = handlers[intent];
  if (!handler) {
    log.warn({ intent }, 'No handler for intent');
    return false;
  }

  log.info({ intent, confidence: confidence.toFixed(2), params }, 'Executing intent handler');

  try {
    const result = await handler(sock, sender, params, msg, botApi, sentMessageIds);
    return result;
  } catch (err) {
    log.error({ intent, err: err.message }, 'Intent handler failed');
    try {
      await reply(sock, sender, `Error: ${err.message}`, sentMessageIds);
    } catch {}
    return true; // Consumed the message (with error)
  }
}

export { handlers };
