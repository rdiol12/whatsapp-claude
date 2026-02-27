/**
 * command-dispatcher.js
 *
 * Handles named action routing for WhatsApp commands (extracted from whatsapp.js).
 * Dispatches router-classified "action" type routes to the correct handler.
 *
 * @param {object} sock - Baileys socket
 * @param {string} sender - WhatsApp JID
 * @param {string} action - action key (e.g. 'status', 'goals')
 * @param {object} params - parsed parameters from router
 * @param {object} botApi - internal bot API object
 * @param {object} deps - local helpers from whatsapp.js { sendReply, sendFileToWhatsApp, trackSent }
 * @returns {Promise<boolean>} true if action was handled, false to fall through to Claude
 */

import { writeFileSync, readdirSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { resetSession, reloadSkills } from './claude.js';
import { clear, getMessages, searchMessages } from './history.js';
import { listSkills, getSkill, addSkill, deleteSkill } from './skills.js';
import { getCronSummary } from './crons.js';
import { isConnected as isMcpConnected } from './mcp-gateway.js';
import { listPlugins, setPluginEnabled } from './plugins.js';
import { formatCostReport } from './cost-analytics.js';
import { getActiveTask } from './task-planner.js';
import { getTodayNotes, getNotesForDate } from './daily-notes.js';
import { getGoalSummary, getGoalDetail, addGoal, listGoals, updateGoal } from './goals.js';
import { getBrainStatus } from './agent-brain.js';
import { generateRecap } from './recap.js';
import { forceDigest, getDigestStatus } from './daily-digest.js';
import { getOutcomeSummary } from './outcome-tracker.js';
import { runSelfReviewNow, rollbackProactiveSection } from './self-review.js';
import {
  getWorkflowSummary, getWorkflowDetail,
  cancelWorkflow, pauseWorkflow, resumeWorkflow, listWorkflows,
} from './workflow-engine.js';
import { listNotes as listUserNotes } from './user-notes.js';
import { getHealthSnapshot } from './metrics.js';
import { formatTrustReport } from './trust-engine.js';
import { getRules, getJournalStats, formatLearningContext } from './learning-journal.js';
import { getReasoningStats, getRecentConclusions, getOpenHypotheses } from './reasoning-journal.js';
import { formatConfidenceReport } from './confidence-gate.js';
import { getUserModelSummary } from './user-model.js';
import { formatGapsReport } from './capability-gaps.js';
import { formatExperimentsReport } from './experiments.js';

export async function executeAction(sock, sender, action, params = {}, botApi, deps = {}) {
  const { sendReply, sendFileToWhatsApp, trackSent } = deps;

  switch (action) {
    case 'clear':
      clear(sender);
      resetSession();
      await sendReply(sock, sender, 'History cleared, session reset.');
      return true;

    case 'help': {
      const help = `*I understand natural language!* Just talk to me normally.

Here's what I can do:
- Check bot status — "how are you?" / "מה המצב?"
- Show cron jobs — "show crons" / "מה מתוזמן?"
- Add cron jobs — "add a daily 9am status report" / "הוסף קרון"
- Today's notes — "what happened today?" / "סיכום היום"
- Goals & brain — "show goals" / "agent brain status"
- Daily recap — "recap" / "ריקאפ"
- List files — "show files" / "מה יש בתיקייה?"
- List skills — "what can you do?" / "מה אתה יודע?"
- Send files — "send me report.pdf" / "תשלח את הקובץ"
- Save URLs — "save this: https://..." / "שמור את הלינק"
- Clear history — "start fresh" / "נקה היסטוריה"
- Cost report — "how much did I spend?" / "כמה עלה?"
- Run multi-step tasks — "/task check all crons and fix broken ones"
- Manage crons, skills, code, memory — just ask!

_Shortcuts: /clear /status /crons /addcron /today /files /cost /goals /brain /recap /review /rollback /export /task /tasks /plugins_`;
      await sendReply(sock, sender, help);
      return true;
    }

    case 'status': {
      const qStats = botApi?._queue?.stats() || { running: '?', waiting: '?' };
      const mcp = isMcpConnected() ? 'connected' : 'disconnected';
      const h = getHealthSnapshot();
      const t = h.tier_breakdown;
      const status = [
        `*Bot Status*`,
        `Uptime: ${h.uptime}`,
        `Memory: ${h.memory_mb}MB (heap: ${h.heap_mb}MB)`,
        `Model: ${config.claudeModel}`,
        `Queue: ${qStats.running} running, ${qStats.waiting} waiting`,
        `Vestige MCP: ${mcp}`,
        `Crons: ${getCronSummary().split('\n').length} jobs`,
        ``,
        `*Session stats:*`,
        `Messages: ${h.messages_in} in / ${h.messages_out} out`,
        `Claude calls: ${h.claude_calls}`,
        `Errors: ${h.errors}`,
        `Avg latency: ${h.avg_latency_ms}ms`,
        `Cost: $${h.cost_usd_session}`,
        `Tiers: T0:${t.t0} T1:${t.t1} T2:${t.t2} T3:${t.t3}`,
        h.last_message ? `Last msg: ${new Date(h.last_message).toLocaleTimeString('en-IL', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' })}` : '',
      ].filter(Boolean).join('\n');
      await sendReply(sock, sender, status);
      return true;
    }

    case 'cost': {
      const period = params.period || 'today';
      await sendReply(sock, sender, formatCostReport(period));
      return true;
    }

    case 'export': {
      const messages = getMessages(sender);
      if (messages.length === 0) {
        await sendReply(sock, sender, 'No conversation history to export.');
        return true;
      }
      const lines = messages.map(m => {
        const time = m.ts ? new Date(m.ts).toLocaleTimeString('en-IL', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' }) : '??:??';
        const date = m.ts ? new Date(m.ts).toLocaleDateString('en-CA', { timeZone: config.timezone }) : '';
        const role = m.role === 'user' ? 'the user' : 'Bot';
        return `[${date} ${time}] ${role}: ${m.content}`;
      });
      const header = `# Conversation Export\n# ${messages.length} messages\n# Exported: ${new Date().toISOString()}\n\n`;
      const content = header + lines.join('\n\n---\n\n');
      const exportPath = join(config.workspaceDir, `export-${Date.now()}.md`);
      try {
        mkdirSync(config.workspaceDir, { recursive: true });
        writeFileSync(exportPath, content);
        const sent = await sendFileToWhatsApp(sock, sender, exportPath, false);
        trackSent(sent);
        await sendReply(sock, sender, `Exported ${messages.length} messages.`);
      } catch (err) {
        await sendReply(sock, sender, `Export failed: ${err.message}`);
      }
      return true;
    }

    case 'plugins': {
      const all = listPlugins();
      if (all.length === 0) {
        await sendReply(sock, sender, 'No plugins loaded.');
      } else {
        const lines = all.map(p => {
          const status = p.enabled ? 'on' : 'off';
          const hooks = p.hooks.length > 0 ? p.hooks.join(', ') : 'none';
          return `${p.enabled ? '\u2705' : '\u26AA'} *${p.name}* v${p.version} [${status}]\n   ${p.description || 'No description'}\n   Hooks: ${hooks} | Priority: ${p.priority}`;
        });
        await sendReply(sock, sender, `*Plugins (${all.length}):*\n\n${lines.join('\n\n')}`);
      }
      return true;
    }

    case 'plugin-manage': {
      const { subCmd, name } = params;
      if (!subCmd || !name) {
        await sendReply(sock, sender, 'Usage: /plugin enable|disable <name>');
        return true;
      }
      if (subCmd !== 'enable' && subCmd !== 'disable') {
        await sendReply(sock, sender, `Unknown sub-command "${subCmd}". Use: /plugin enable|disable <name>`);
        return true;
      }
      const result = setPluginEnabled(name, subCmd === 'enable');
      if (!result) {
        await sendReply(sock, sender, `Plugin "${name}" not found.`);
      } else {
        await sendReply(sock, sender, `Plugin "${name}" ${result.enabled ? 'enabled' : 'disabled'}.`);
      }
      return true;
    }

    case 'tasks': {
      const task = getActiveTask();
      if (!task || !task.taskId) {
        await sendReply(sock, sender, 'No active or recent tasks.');
      } else {
        const elapsed = task.durationMs ? `${(task.durationMs / 1000).toFixed(0)}s` : `${((Date.now() - task.startedAt) / 1000).toFixed(0)}s`;
        const lines = [
          `*Task:* ${task.description?.slice(0, 100) || '(unknown)'}`,
          `*Status:* ${task.status || 'unknown'}`,
          `*Steps:* ${task.succeeded ?? '?'}/${task.steps ?? '?'} (${task.failed || 0} failed)`,
          `*Duration:* ${elapsed}`,
          task.costUsd ? `*Cost:* $${task.costUsd.toFixed(4)}` : '',
        ].filter(Boolean);
        await sendReply(sock, sender, lines.join('\n'));
      }
      return true;
    }

    case 'crons': {
      const summary = getCronSummary();
      await sendReply(sock, sender, `*Cron Jobs:*\n${summary}`);
      return true;
    }

    case 'addcron': {
      // Pass to Claude with addCron tool context — it parses name, schedule, and prompt
      return false; // fall through to Claude pipeline with hint
    }

    case 'today': {
      let notes;
      if (params.date) {
        notes = getNotesForDate(params.date) || `No notes for ${params.date}.`;
      } else {
        notes = getTodayNotes() || 'No notes yet today.';
      }
      await sendReply(sock, sender, notes);
      return true;
    }

    case 'files': {
      try {
        const files = readdirSync(config.workspaceDir);
        if (files.length === 0) {
          await sendReply(sock, sender, 'Workspace is empty.');
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
          await sendReply(sock, sender, `*Workspace files (${files.length}):*\n${listing}`);
        }
      } catch (err) {
        await sendReply(sock, sender, `Error: ${err.message}`);
      }
      return true;
    }

    case 'skills': {
      const names = listSkills();
      const reply = names.length
        ? `*Skills (${names.length}):*\n${names.map(n => `• ${n}`).join('\n')}`
        : 'No skills loaded.';
      await sendReply(sock, sender, reply);
      return true;
    }

    case 'search': {
      const { query } = params;
      if (!query) {
        await sendReply(sock, sender, 'Usage: /search <keyword>');
        return true;
      }
      const results = searchMessages(query, { jid: sender, limit: 10 });
      if (!results.length) {
        await sendReply(sock, sender, `No messages found for: _${query}_`);
        return true;
      }
      const lines2 = results.map(r => {
        const d = new Date(r.ts).toLocaleDateString('he-IL');
        const who = r.role === 'user' ? '👤' : '🤖';
        const snippet = r.content.slice(0, 120).replace(/\n/g, ' ');
        return `${who} ${d}: ${snippet}…`;
      });
      await sendReply(sock, sender, `*Found ${results.length} result(s) for "${query}":*\n\n${lines2.join("\n\n")}`);
      return true;
    }

    case 'skill': {
      if (!params?.name) {
        await sendReply(sock, sender, 'Which skill? Try "show me skill humanizer" or /skills to list.');
        return true;
      }
      const content = getSkill(params.name);
      await sendReply(sock, sender, content
        ? `*Skill: ${params.name}*\n\n${content.slice(0, 3500)}`
        : `Skill "${params.name}" not found. Use /skills to see available.`);
      return true;
    }

    case 'addskill': {
      if (!params?.name || !params?.content) {
        await sendReply(sock, sender, 'Usage: /addskill <name>\n<skill content on next lines>');
        return true;
      }
      const saved = addSkill(params.name, params.content);
      reloadSkills();
      await sendReply(sock, sender, `Skill *${saved}* added. (${params.content.length} chars)`);
      return true;
    }

    case 'delskill': {
      if (!params?.name) {
        await sendReply(sock, sender, 'Which skill to delete? Example: "delete skill humanizer"');
        return true;
      }
      const ok = deleteSkill(params.name);
      reloadSkills();
      await sendReply(sock, sender, ok ? `Skill *${params.name}* deleted.` : `Skill "${params.name}" not found.`);
      return true;
    }

    case 'notes': {
      if (!params?.date) {
        await sendReply(sock, sender, 'Which date? Try "notes for yesterday" or "notes 2025-01-15"');
        return true;
      }
      const dateNotes = getNotesForDate(params.date);
      await sendReply(sock, sender, dateNotes || `No notes for ${params.date}.`);
      return true;
    }

    case 'save': {
      if (!params?.url) {
        await sendReply(sock, sender, 'Usage: /save <url>');
        return true;
      }
      // Fall through to Claude pipeline with rewritten prompt for URL ingestion
      return false;
    }

    case 'send': {
      const file = params.file || params.path;
      if (!file) {
        await sendReply(sock, sender, 'Usage: /send <filename>');
        return true;
      }
      try {
        const sent = await sendFileToWhatsApp(sock, sender, file, true);
        trackSent(sent);
      } catch (err) {
        await sendReply(sock, sender, `Could not send: ${err.message}`);
      }
      return true;
    }

    case 'goals': {
      const summary = getGoalSummary();
      await sendReply(sock, sender, `*Goals:*\n${summary}`);
      return true;
    }

    case 'goal-manage': {
      const { subCmd, arg } = params;
      if (!subCmd) {
        await sendReply(sock, sender, 'Usage: /goal add <title> | /goal <name> | /goal review');
        return true;
      }
      if (subCmd === 'add' && arg) {
        const goal = addGoal(arg);
        await sendReply(sock, sender, `Goal created: *${goal.title}*\nID: ${goal.id}`);
        return true;
      }
      if (subCmd === 'review') {
        await sendReply(sock, sender, `*Goal Review:*\n${getGoalSummary()}`);
        return true;
      }
      const query = arg ? `${subCmd} ${arg}` : subCmd;
      const detail = getGoalDetail(query);
      await sendReply(sock, sender, detail || `Goal "${query}" not found. Use /goals to list.`);
      return true;
    }

    case 'brain': {
      const brainStatus = getBrainStatus();
      try {
        const outcomes = getOutcomeSummary();
        await sendReply(sock, sender, outcomes ? `${brainStatus}\n\n${outcomes}` : brainStatus);
      } catch {
        await sendReply(sock, sender, brainStatus);
      }
      return true;
    }

    case 'trust': {
      const report = formatTrustReport();
      await sendReply(sock, sender, report || '_No trust data yet. Trust builds as the agent takes actions._');
      return true;
    }

    case 'learning': {
      const rules = getRules();
      const stats = getJournalStats();
      if (rules.length === 0 && stats.totalEntries === 0) {
        await sendReply(sock, sender, '_No learning data yet. The agent learns from outcomes over time._');
        return true;
      }
      const lines = ['*Learning Journal*\n'];
      lines.push(`Entries: ${stats.totalEntries} | Rules: ${rules.length}`);
      if (stats.lastSynthesisAt) {
        lines.push(`Last synthesis: ${new Date(stats.lastSynthesisAt).toLocaleDateString('en-IL', { timeZone: config.timezone })}`);
      }
      if (rules.length > 0) {
        lines.push('\n*Learned Rules:*');
        for (const r of rules) {
          const conf = Math.round((r.confidence || 0.7) * 100);
          lines.push(`- ${r.rule} (${conf}%)`);
        }
      }
      if (stats.recentEntries && stats.recentEntries.length > 0) {
        lines.push(`\n_${stats.recentEntries.length} entries in the last 7 days_`);
      }
      await sendReply(sock, sender, lines.join('\n'));
      return true;
    }

    case 'recap': {
      await sendReply(sock, sender, '_Generating recap..._');
      try {
        const { text: recapText, generatedAt } = await generateRecap();
        const time = new Date(generatedAt).toLocaleTimeString('en-IL', {
          timeZone: config.timezone, hour: '2-digit', minute: '2-digit',
        });
        await sendReply(sock, sender, `*Daily Recap* (${time})\n\n${recapText}`);
      } catch (err) {
        await sendReply(sock, sender, `Recap failed: ${err.message}`);
      }
      return true;
    }

    case 'digest': {
      const sub = params.subCmd?.trim().toLowerCase();
      if (sub === 'status') {
        await sendReply(sock, sender, getDigestStatus());
        return true;
      }
      await sendReply(sock, sender, '_Generating digest..._');
      try {
        const result = await forceDigest(async (text) => sendReply(sock, sender, text));
        if (!result) {
          await sendReply(sock, sender, 'Digest already sent today. Use /digest status to check.');
        }
      } catch (err) {
        await sendReply(sock, sender, `Digest failed: ${err.message}`);
      }
      return true;
    }

    case 'workflows': {
      const summary = getWorkflowSummary();
      await sendReply(sock, sender, `*Workflows:*\n${summary}`);
      return true;
    }

    case 'workflow-manage': {
      const { subCmd: wfCmd, arg: wfArg } = params;
      if (!wfCmd) {
        await sendReply(sock, sender, 'Usage: /wf list | /wf status <id> | /wf cancel|pause|resume <id>');
        return true;
      }
      if (wfCmd === 'list' || wfCmd === 'ls') {
        const wfs = listWorkflows();
        if (wfs.length === 0) {
          await sendReply(sock, sender, 'No workflows.');
        } else {
          const lines = wfs.slice(0, 15).map(w => {
            const pct = w.steps > 0 ? Math.round((w.completed / w.steps) * 100) : 0;
            return `- *${w.name}* [${w.status}] ${w.completed}/${w.steps} (${pct}%) — ${w.id}`;
          });
          await sendReply(sock, sender, `*Workflows (${wfs.length}):*\n${lines.join('\n')}`);
        }
        return true;
      }
      if (['status', 'detail', 'info'].includes(wfCmd)) {
        if (!wfArg) { await sendReply(sock, sender, 'Which workflow? /wf status <id>'); return true; }
        const wfDetail = getWorkflowDetail(wfArg);
        await sendReply(sock, sender, wfDetail || `Workflow "${wfArg}" not found.`);
        return true;
      }
      if (['cancel', 'stop', 'abort'].includes(wfCmd)) {
        if (!wfArg) { await sendReply(sock, sender, 'Which workflow? /wf cancel <id>'); return true; }
        const wf = cancelWorkflow(wfArg);
        await sendReply(sock, sender, wf ? `Workflow *${wf.name}* cancelled.` : `Workflow "${wfArg}" not found.`);
        return true;
      }
      if (wfCmd === 'pause') {
        if (!wfArg) { await sendReply(sock, sender, 'Which workflow? /wf pause <id>'); return true; }
        const wf = pauseWorkflow(wfArg);
        await sendReply(sock, sender, wf ? `Workflow *${wf.name}* paused.` : `Workflow "${wfArg}" not found.`);
        return true;
      }
      if (wfCmd === 'resume') {
        if (!wfArg) { await sendReply(sock, sender, 'Which workflow? /wf resume <id>'); return true; }
        const wf = resumeWorkflow(wfArg);
        await sendReply(sock, sender, wf ? `Workflow *${wf.name}* resumed.` : `Workflow "${wfArg}" not found.`);
        return true;
      }
      const wfDetail = getWorkflowDetail(wfCmd + (wfArg ? ` ${wfArg}` : ''));
      await sendReply(sock, sender, wfDetail || 'Usage: /wf list | /wf status <id> | /wf cancel|pause|resume <id>');
      return true;
    }

    case 'user-notes': {
      const notes = listUserNotes();
      if (notes.length === 0) {
        await sendReply(sock, sender, 'No personal notes yet.');
      } else {
        const lines = notes.slice(0, 15).map(n => {
          const date = new Date(n.createdAt).toLocaleDateString('en-CA', { timeZone: config.timezone });
          const text = n.text.length > 100 ? n.text.slice(0, 100) + '...' : n.text;
          return `- ${text} _(${date})_`;
        });
        await sendReply(sock, sender, `*Your notes (${notes.length}):*\n${lines.join('\n')}`);
      }
      return true;
    }

    case 'review': {
      await sendReply(sock, sender, '_Running self-review..._');
      try {
        await runSelfReviewNow(async (text) => sendReply(sock, sender, text));
      } catch (err) {
        await sendReply(sock, sender, `Self-review failed: ${err.message}`);
      }
      return true;
    }

    case 'rollback': {
      const ok = rollbackProactiveSection();
      await sendReply(sock, sender,
        ok
          ? 'Rolled back proactive behavior section. Takes effect within 5 minutes.'
          : 'No previous section saved — nothing to rollback.'
      );
      return true;
    }

    case 'experiments': {
      const report = formatExperimentsReport();
      await sendReply(sock, sender, report);
      return true;
    }

    case 'gaps': {
      const report = formatGapsReport();
      await sendReply(sock, sender, report);
      return true;
    }

    case 'usermodel': {
      const model = getUserModelSummary();
      const lines = ['*User Model*\n'];
      if (model.bestSendTime) {
        lines.push(`Best send hour: ${model.bestSendTime.hour}:00 Israel (${model.bestSendTime.positiveRate}% positive, ${model.bestSendTime.sampleSize} samples)`);
      } else {
        lines.push('Best send hour: _not enough data_');
      }
      if (model.preferredLength) {
        lines.push(`Message preference: ${model.preferredLength.preferShort ? 'concise' : 'detailed'} (avg ~${model.preferredLength.avgPreferredLength} chars, ${model.preferredLength.sampleSize} samples)`);
      } else {
        lines.push('Message preference: _not enough data_');
      }
      lines.push(`Currently available: ${model.currentlyAvailable ? 'likely yes' : 'probably not'}`);
      await sendReply(sock, sender, lines.join('\n'));
      return true;
    }

    case 'confidence': {
      const report = formatConfidenceReport();
      await sendReply(sock, sender, report);
      return true;
    }

    case 'proposed-goals': {
      const proposed = listGoals({ status: ['proposed'] });
      if (proposed.length === 0) {
        await sendReply(sock, sender, 'No proposed goals. The agent hasn\'t suggested any yet.');
        return true;
      }
      const lines = proposed.map((g, i) => {
        const rationale = g.log?.[0]?.detail || '';
        return `${i + 1}. *${g.title}* (${g.id})\n   ${rationale.slice(0, 120)}`;
      });
      await sendReply(sock, sender, `*Proposed Goals (${proposed.length}):*\n\n${lines.join('\n\n')}\n\n_Reply "/approve-goal <id>" or "/reject-goal <id>"_`);
      return true;
    }

    case 'approve-goal': {
      const goalId = params.arg || params.id;
      if (!goalId) {
        await sendReply(sock, sender, 'Usage: /approve-goal <goal-id>');
        return true;
      }
      const updated = updateGoal(goalId, { status: 'active' });
      if (updated) {
        await sendReply(sock, sender, `Goal *${updated.title}* approved and activated.`);
      } else {
        await sendReply(sock, sender, `Goal "${goalId}" not found or can't be activated.`);
      }
      return true;
    }

    case 'reject-goal': {
      const goalId = params.arg || params.id;
      if (!goalId) {
        await sendReply(sock, sender, 'Usage: /reject-goal <goal-id>');
        return true;
      }
      const updated = updateGoal(goalId, { status: 'abandoned' });
      if (updated) {
        await sendReply(sock, sender, `Goal *${updated.title}* rejected.`);
      } else {
        await sendReply(sock, sender, `Goal "${goalId}" not found.`);
      }
      return true;
    }

    case 'reasoning': {
      const stats = getReasoningStats();
      const open = getOpenHypotheses(5);
      const concluded = getRecentConclusions(5);
      const lines = ['*Reasoning Journal*\n'];
      lines.push(`Total entries: ${stats.total}`);
      const statusParts = Object.entries(stats.byStatus).map(([s, c]) => `${s}: ${c}`);
      if (statusParts.length > 0) lines.push(`Status: ${statusParts.join(', ')}`);
      if (stats.avgConcludedConfidence !== null) lines.push(`Avg concluded confidence: ${(stats.avgConcludedConfidence * 100).toFixed(0)}%`);
      if (open.length > 0) {
        lines.push('\n*Open hypotheses:*');
        for (const h of open) {
          let evidenceCount = 0;
          try { evidenceCount = JSON.parse(h.evidence).length; } catch {}
          lines.push(`- [#${h.id}] ${h.hypothesis.slice(0, 100)} (${evidenceCount} evidence, conf: ${(h.confidence * 100).toFixed(0)}%)`);
        }
      }
      if (concluded.length > 0) {
        lines.push('\n*Recent conclusions:*');
        for (const c of concluded) {
          lines.push(`- ${c.hypothesis.slice(0, 60)} → ${(c.conclusion || '').slice(0, 80)}`);
        }
      }
      await sendReply(sock, sender, lines.join('\n'));
      return true;
    }

    default:
      return false;
  }
}
