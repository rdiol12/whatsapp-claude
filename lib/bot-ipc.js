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
import { listWorkflows, getWorkflow, getWorkflowSummary, getWorkflowDetail, createWorkflow, startWorkflow, cancelWorkflow, pauseWorkflow, resumeWorkflow } from './workflow-engine.js';
import { listSkills } from './skills.js';
import { getTodayNotes, getNotesForDate } from './daily-notes.js';
import { isConnected as isMcpConnected } from './mcp-gateway.js';
import { clear, getMessages } from './history.js';
import { resetSession } from './claude.js';
import { getHealthSnapshot, getDetailedMetrics } from './metrics.js';
import { listPlugins } from './plugins.js';
import { getCostSummary } from './cost-analytics.js';

const log = createLogger('bot-ipc');
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
      return jsonResponse(res, getCostSummary(period));
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
      return jsonResponse(res, { notes: getTodayNotes() || 'No notes yet today.' });
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

    // --- Plugins ---
    if (path === '/plugins' && method === 'GET') {
      return jsonResponse(res, { plugins: listPlugins() });
    }

    // --- Clear history ---
    if (path === '/clear' && method === 'POST') {
      const body = await readBody(req);
      if (body.jid) clear(body.jid);
      resetSession();
      return jsonResponse(res, { success: true, message: 'History cleared and session reset.' });
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
