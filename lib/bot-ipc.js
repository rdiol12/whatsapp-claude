/**
 * Internal HTTP API for bot operations.
 * Runs on localhost with a random port. Used by bot-mcp-server.js
 * to expose bot operations as MCP tools to Claude CLI.
 *
 * Only binds to 127.0.0.1 — not accessible from outside.
 */

import http from 'http';
import { writeFileSync, readFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { createLogger } from './logger.js';
import { listCrons, getCronSummary, addCron, deleteCron, toggleCron, runCronNow } from './crons.js';
import { listGoals, getGoal, addGoal, updateGoal, deleteGoal, addMilestone, completeMilestone, getGoalSummary, getGoalDetail } from './goals.js';
import { getState, setState } from './state.js';
import { listWorkflows, getWorkflow, getWorkflowSummary, getWorkflowDetail, createWorkflow, startWorkflow, cancelWorkflow, pauseWorkflow, resumeWorkflow } from './workflow-engine.js';
import { listSkills } from './skills.js';
import { getTodayNotes, getNotesForDate, listAvailableDates } from './daily-notes.js';
import { listNotes as listUserNotes, addNote as addUserNote, deleteNote as deleteUserNote } from './user-notes.js';
import { isConnected as isMcpConnected, getConnectionStats as getMcpStats } from './mcp-gateway.js';
import { clear, getMessages } from './history.js';
import { resetSession } from './claude.js';
import { getHealthSnapshot, getDetailedMetrics } from './metrics.js';
import { listPlugins } from './plugins.js';
import { getCostSummary, getCostOverview } from './cost-analytics.js';
import { getOutcomeSummary, getLowEngagementCrons } from './outcome-tracker.js';
import { homedir } from 'os';

const log = createLogger('bot-ipc');
const SOUL_PATH = join(homedir(), 'whatsapp-claude', 'SOUL.md');
const PROACTIVE_START = '## When you act on your own';
const PROACTIVE_END = '## What you know about Ron';

function readProactiveSection() {
  const content = readFileSync(SOUL_PATH, 'utf-8');
  const startIdx = content.indexOf(PROACTIVE_START);
  const endIdx = content.indexOf(PROACTIVE_END);
  if (startIdx === -1 || endIdx === -1) return { full: content, proactive: content };
  return { full: content, proactive: content.slice(startIdx, endIdx).trim() };
}

function writeProactiveSection(newSection) {
  const content = readFileSync(SOUL_PATH, 'utf-8');
  const startIdx = content.indexOf(PROACTIVE_START);
  const endIdx = content.indexOf(PROACTIVE_END);
  if (startIdx === -1 || endIdx === -1) throw new Error('Cannot find proactive section markers in SOUL.md');
  // Backup current section
  const current = content.slice(startIdx, endIdx).trim();
  setState('soul-backup', { proactiveSection: current, backedUpAt: Date.now() });
  // Write new content
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx);
  writeFileSync(SOUL_PATH, before + newSection.trim() + '\n\n' + after, 'utf-8');
  return true;
}

function rollbackProactiveSection() {
  const backup = getState('soul-backup');
  if (!backup?.proactiveSection) throw new Error('No backup available');
  const content = readFileSync(SOUL_PATH, 'utf-8');
  const startIdx = content.indexOf(PROACTIVE_START);
  const endIdx = content.indexOf(PROACTIVE_END);
  if (startIdx === -1 || endIdx === -1) throw new Error('Cannot find proactive section markers');
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx);
  writeFileSync(SOUL_PATH, before + backup.proactiveSection + '\n\n' + after, 'utf-8');
  setState('soul-backup', null);
  return true;
}
const PORT_FILE = join(config.dataDir, '.ipc-port');
let server = null;
let queueStatsFn = null;

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const MAX_BODY_BYTES = 64 * 1024; // 64KB — more than enough for any IPC payload

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost`);
  const path = url.pathname;
  const method = req.method;

  try {
    // --- Status ---
    if (path === '/status' && method === 'GET') {
      const qStats = queueStatsFn?.() || { running: '?', waiting: '?' };
      return jsonResponse(res, getHealthSnapshot({
        model: config.claudeModel,
        queue: qStats,
        vestige_mcp: isMcpConnected() ? 'connected' : 'disconnected',
        cron_count: listCrons().length,
      }));
    }

    // --- Costs ---
    if (path === '/costs' && method === 'GET') {
      const period = url.searchParams.get('period') || 'today';
      const summary = getCostSummary(period);
      // When today is empty, include yesterday + week for context
      if (period === 'today' && summary.count === 0) {
        const yesterday = getCostSummary('yesterday');
        const week = getCostSummary('week');
        summary.yesterday = { total: yesterday.total, count: yesterday.count, inputTokens: yesterday.inputTokens, outputTokens: yesterday.outputTokens };
        summary.week = { total: week.total, count: week.count };
      }
      return jsonResponse(res, summary);
    }

    // --- Cost Summary ---
    if (path === '/costs/summary' && method === 'GET') {
      return jsonResponse(res, getCostOverview());
    }

    // --- History dates ---
    if (path === '/history/dates' && method === 'GET') {
      const dates = listAvailableDates();
      const allCosts = getCostSummary('all');
      const byDay = allCosts.byDay || {};
      const result = dates.map(date => ({
        date,
        hasNotes: true,
        cost: byDay[date] ? parseFloat(byDay[date].cost.toFixed(4)) : 0,
        turns: byDay[date] ? byDay[date].count : 0,
      }));
      return jsonResponse(res, { dates: result });
    }

    // --- Export conversation ---
    if (path === '/export' && method === 'GET') {
      const jid = url.searchParams.get('jid') || config.allowedJid;
      const messages = getMessages(jid);
      const lines = messages.map(m => {
        const time = m.ts ? new Date(m.ts).toLocaleTimeString('en-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }) : '??:??';
        const role = m.role === 'user' ? 'Ron' : 'Bot';
        return `[${time}] ${role}: ${m.content}`;
      });
      return jsonResponse(res, { jid, count: messages.length, transcript: lines.join('\n') });
    }

    // --- Crons ---
    if (path === '/crons' && method === 'GET') {
      const crons = listCrons().map(j => ({
        id: j.id, name: j.name, schedule: j.schedule,
        enabled: j.enabled, delivery: j.delivery, model: j.model,
        prompt: j.prompt?.slice(0, 200),
        lastRun: j.state?.lastRun, nextRun: j.state?.nextRun,
        consecutiveErrors: j.state?.consecutiveErrors || 0,
      }));
      return jsonResponse(res, { crons, summary: getCronSummary() });
    }

    if (path === '/crons' && method === 'POST') {
      const body = await readBody(req);
      if (!body.name || !body.schedule || !body.prompt) {
        return jsonResponse(res, { error: 'Missing required fields: name, schedule, prompt' }, 400);
      }
      const job = addCron(body.name, body.schedule, body.prompt, null, body.delivery || 'announce', body.model || null);
      return jsonResponse(res, {
        success: true,
        id: job.id, name: job.name, schedule: job.schedule,
        nextRun: job.state?.nextRun,
      });
    }

    const cronMatch = path.match(/^\/crons\/([^/]+)\/(delete|toggle|run)$/);
    if (cronMatch) {
      const idOrName = decodeURIComponent(cronMatch[1]);
      const action = cronMatch[2];
      if (action === 'delete') {
        const deleted = deleteCron(idOrName);
        return jsonResponse(res, { success: !!deleted, name: deleted?.name || idOrName });
      }
      if (action === 'toggle') {
        const toggled = toggleCron(idOrName);
        return jsonResponse(res, { success: !!toggled, name: toggled?.name, enabled: toggled?.enabled });
      }
      if (action === 'run') {
        const ran = runCronNow(idOrName);
        return jsonResponse(res, { success: !!ran, name: ran || idOrName });
      }
    }

    // --- Goals ---
    if (path === '/goals' && method === 'GET') {
      const status = url.searchParams.get('status');
      const filter = status ? { status: status.split(',') } : {};
      const goalsList = listGoals(filter);
      return jsonResponse(res, { goals: goalsList, summary: getGoalSummary() });
    }

    if (path === '/goals' && method === 'POST') {
      const body = await readBody(req);
      if (!body.title) {
        return jsonResponse(res, { error: 'Missing required field: title' }, 400);
      }
      const goal = addGoal(body.title, {
        description: body.description,
        priority: body.priority,
        category: body.category,
        deadline: body.deadline,
        linkedTopics: body.linkedTopics,
        milestones: body.milestones,
      });
      return jsonResponse(res, { success: true, id: goal.id, title: goal.title, status: goal.status });
    }

    const goalDetailMatch = path.match(/^\/goals\/([^/]+)$/);
    if (goalDetailMatch && method === 'GET') {
      const idOrTitle = decodeURIComponent(goalDetailMatch[1]);
      const goal = getGoal(idOrTitle);
      if (!goal) return jsonResponse(res, { error: 'Goal not found' }, 404);
      return jsonResponse(res, { goal, detail: getGoalDetail(idOrTitle) });
    }

    const goalActionMatch = path.match(/^\/goals\/([^/]+)\/(update|delete|milestone-add|milestone-complete)$/);
    if (goalActionMatch) {
      const idOrTitle = decodeURIComponent(goalActionMatch[1]);
      const action = goalActionMatch[2];
      const body = await readBody(req);

      if (action === 'update') {
        const updated = updateGoal(idOrTitle, body);
        if (!updated) return jsonResponse(res, { error: 'Goal not found or invalid transition' }, 400);
        return jsonResponse(res, { success: true, id: updated.id, title: updated.title, status: updated.status, progress: updated.progress });
      }
      if (action === 'delete') {
        const deleted = deleteGoal(idOrTitle);
        return jsonResponse(res, { success: !!deleted, title: deleted?.title });
      }
      if (action === 'milestone-add') {
        if (!body.title) return jsonResponse(res, { error: 'Missing milestone title' }, 400);
        const ms = addMilestone(idOrTitle, body.title);
        if (!ms) return jsonResponse(res, { error: 'Goal not found' }, 404);
        return jsonResponse(res, { success: true, milestone: ms });
      }
      if (action === 'milestone-complete') {
        if (!body.milestone) return jsonResponse(res, { error: 'Missing milestone id or title' }, 400);
        const ms = completeMilestone(idOrTitle, body.milestone, body.evidence);
        if (!ms) return jsonResponse(res, { error: 'Goal or milestone not found' }, 404);
        return jsonResponse(res, { success: true, milestone: ms });
      }
    }

    // --- Brain ---
    if (path === '/brain' && method === 'GET') {
      const patterns = getState('agent-patterns')?.patterns || [];
      const proposals = getState('agent-proposals')?.proposals || [];
      const rates = getState('agent-rate-limits') || {};
      return jsonResponse(res, { patterns, proposals, rates });
    }

    // --- Workflows ---
    if (path === '/workflows' && method === 'GET') {
      const status = url.searchParams.get('status');
      const filter = status ? { status: status.split(',') } : {};
      const wfList = listWorkflows(filter);
      return jsonResponse(res, { workflows: wfList, summary: getWorkflowSummary() });
    }

    if (path === '/workflows' && method === 'POST') {
      const body = await readBody(req);
      if (!body.name || !body.steps || !Array.isArray(body.steps)) {
        return jsonResponse(res, { error: 'Missing required fields: name, steps (array)' }, 400);
      }
      const wf = createWorkflow(body.name, body.steps, {
        trigger: body.trigger || { type: 'api', source: 'mcp' },
        notifyPolicy: body.notifyPolicy || 'summary',
      });
      if (body.autoStart !== false) startWorkflow(wf.id);
      return jsonResponse(res, { success: true, id: wf.id, name: wf.name, status: wf.status });
    }

    const wfDetailMatch = path.match(/^\/workflows\/([^/]+)$/);
    if (wfDetailMatch && method === 'GET') {
      const id = decodeURIComponent(wfDetailMatch[1]);
      const wf = getWorkflow(id);
      if (!wf) return jsonResponse(res, { error: 'Workflow not found' }, 404);
      return jsonResponse(res, { workflow: wf, detail: getWorkflowDetail(id) });
    }

    const wfActionMatch = path.match(/^\/workflows\/([^/]+)\/(cancel|pause|resume|start)$/);
    if (wfActionMatch) {
      const id = decodeURIComponent(wfActionMatch[1]);
      const action = wfActionMatch[2];
      let wf;
      if (action === 'cancel') wf = cancelWorkflow(id);
      else if (action === 'pause') wf = pauseWorkflow(id);
      else if (action === 'resume') wf = resumeWorkflow(id);
      else if (action === 'start') wf = startWorkflow(id);
      if (!wf) return jsonResponse(res, { error: 'Workflow not found or invalid state' }, 400);
      return jsonResponse(res, { success: true, id: wf.id, name: wf.name, status: wf.status });
    }

    // --- Files ---
    if (path === '/files' && method === 'GET') {
      try {
        const files = readdirSync(config.workspaceDir).map(f => {
          try {
            const st = statSync(join(config.workspaceDir, f));
            return { name: f, size: st.size, modified: st.mtime.toISOString() };
          } catch { return { name: f }; }
        });
        return jsonResponse(res, { files, workspace: config.workspaceDir });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // --- Skills ---
    if (path === '/skills' && method === 'GET') {
      return jsonResponse(res, { skills: listSkills() });
    }

    // --- Notes ---
    if (path === '/notes/today' && method === 'GET') {
      const todayNotes = getTodayNotes();
      if (todayNotes) {
        return jsonResponse(res, { notes: todayNotes, date: 'today' });
      }
      // Fall back to yesterday
      const yest = new Date(Date.now() - 86400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
      const yesterdayNotes = getNotesForDate(yest);
      if (yesterdayNotes) {
        return jsonResponse(res, { notes: yesterdayNotes, date: yest });
      }
      return jsonResponse(res, { notes: '', date: 'today' });
    }

    const notesMatch = path.match(/^\/notes\/(\d{4}-\d{2}-\d{2})$/);
    if (notesMatch && method === 'GET') {
      const date = notesMatch[1];
      // Validate it's a real date (not just digits matching the pattern)
      if (isNaN(Date.parse(date))) {
        return jsonResponse(res, { error: 'Invalid date' }, 400);
      }
      const notes = getNotesForDate(date);
      return jsonResponse(res, { date, notes: notes || `No notes for ${date}.` });
    }

    // --- User Notes (persistent personal notes) ---
    if (path === '/user-notes' && method === 'GET') {
      return jsonResponse(res, { notes: listUserNotes() });
    }

    if (path === '/user-notes' && method === 'POST') {
      const body = await readBody(req);
      if (!body.text || !body.text.trim()) {
        return jsonResponse(res, { error: 'Missing required field: text' }, 400);
      }
      const note = addUserNote(body.text);
      return jsonResponse(res, { success: true, note });
    }

    const userNoteDeleteMatch = path.match(/^\/user-notes\/([^/]+)\/delete$/);
    if (userNoteDeleteMatch && method === 'POST') {
      const id = decodeURIComponent(userNoteDeleteMatch[1]);
      const deleted = deleteUserNote(id);
      if (!deleted) return jsonResponse(res, { error: 'Note not found' }, 404);
      return jsonResponse(res, { success: true, id: deleted.id });
    }

    // --- Health check (lightweight) ---
    if (path === '/healthz' && method === 'GET') {
      const mcpOk = isMcpConnected();
      const qStats = queueStatsFn?.() || {};
      const mem = process.memoryUsage();
      const heapPct = Math.round(mem.heapUsed / mem.heapTotal * 100);

      // Degraded if: MCP disconnected, queue > 80% full, or heap > 85%
      const degraded = !mcpOk || heapPct > 85 || (qStats.waiting || 0) > 3;
      const status = degraded ? 'degraded' : 'ok';

      res.writeHead(degraded ? 503 : 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status, mcp: mcpOk, heap_pct: heapPct, queue_waiting: qStats.waiting || 0 }));
    }

    // --- Detailed metrics (for dashboard) ---
    if (path === '/metrics' && method === 'GET') {
      const qStats = queueStatsFn?.() || {};
      const detailed = getDetailedMetrics();
      detailed.model = config.claudeModel;
      detailed.queue_live = qStats;
      detailed.vestige_mcp = isMcpConnected() ? 'connected' : 'disconnected';
      detailed.cron_count = listCrons().length;
      return jsonResponse(res, detailed);
    }

    // --- Recap ---
    if (path === '/recap' && method === 'GET') {
      const recap = getState('last-recap') || { text: null, generatedAt: null };
      return jsonResponse(res, recap);
    }

    if (path === '/recap' && method === 'POST') {
      try {
        const { generateRecap } = await import('./recap.js');
        const result = await generateRecap();
        return jsonResponse(res, result);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // --- Plugins ---
    if (path === '/plugins' && method === 'GET') {
      return jsonResponse(res, { plugins: listPlugins() });
    }

    // --- Services (MCP + plugins overview) ---
    if (path === '/services' && method === 'GET') {
      const mcpStats = getMcpStats();
      const plugins = listPlugins();
      return jsonResponse(res, {
        mcp: [
          { name: 'Vestige MCP', type: 'mcp', status: mcpStats.connected ? 'connected' : 'disconnected', failures: mcpStats.consecutiveFailures },
          { name: 'Bot MCP Server', type: 'mcp', status: 'running', failures: 0 },
        ],
        plugins: plugins.map(p => ({ name: p.name, status: p.enabled ? 'active' : 'disabled', hooks: p.hooks || [] })),
      });
    }

    // --- Clear history ---
    if (path === '/clear' && method === 'POST') {
      const body = await readBody(req);
      if (body.jid) clear(body.jid);
      resetSession();
      return jsonResponse(res, { success: true, message: 'History cleared and session reset.' });
    }

    // --- Outcomes ---
    if (path === '/outcomes' && method === 'GET') {
      const proposals = Object.values(getState('outcome-proposals') || {}).slice(-20);
      return jsonResponse(res, {
        summary: getOutcomeSummary(),
        lowEngagementCrons: getLowEngagementCrons(),
        recentProposals: proposals,
      });
    }

    // --- Soul Editor ---
    if (path === '/soul' && method === 'GET') {
      try {
        const { proactive } = readProactiveSection();
        return jsonResponse(res, { proactiveSection: proactive });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (path === '/soul' && method === 'POST') {
      try {
        const body = await readBody(req);
        if (!body.proactiveSection) return jsonResponse(res, { error: 'Missing proactiveSection' }, 400);
        writeProactiveSection(body.proactiveSection);
        return jsonResponse(res, { success: true, message: 'Saved. Bot will reload within 5 minutes.' });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (path === '/soul/rollback' && method === 'POST') {
      try {
        rollbackProactiveSection();
        return jsonResponse(res, { success: true, message: 'Rolled back to previous version.' });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // --- Self-Review (stub until self-review module is built) ---
    if (path === '/review/history' && method === 'GET') {
      const history = getState('review-history')?.entries || [];
      return jsonResponse(res, { history });
    }

    if (path === '/review' && method === 'POST') {
      return jsonResponse(res, { error: 'Self-review module not built yet. Coming after 1 week of outcome data.' }, 501);
    }

    jsonResponse(res, { error: 'Not found' }, 404);
  } catch (err) {
    log.error({ err: err.message, path }, 'IPC request failed');
    jsonResponse(res, { error: err.message }, 500);
  }
}

export function startIpcServer({ queueStats } = {}) {
  queueStatsFn = queueStats;

  server = http.createServer(handleRequest);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(PORT_FILE, String(port));
    log.info({ port }, 'Bot IPC server started');
  });

  return server;
}

export function stopIpcServer() {
  if (server) {
    server.close();
    server = null;
  }
}
