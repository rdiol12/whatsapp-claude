/**
 * Internal HTTP API for bot operations.
 * Runs on localhost with a random port. Used by bot-mcp-server.js
 * to expose bot operations as MCP tools to Claude CLI.
 *
 * Only binds to 127.0.0.1 — not accessible from outside.
 */

import http from 'http';
import { WebSocketServer } from 'ws';
import { writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, chmodSync, existsSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';
import config from './config.js';
import { createLogger } from './logger.js';
import { listCrons, getCronSummary, addCron, deleteCron, toggleCron, runCronNow } from './crons.js';
import { listGoals, getGoal, addGoal, updateGoal, deleteGoal, addMilestone, completeMilestone, getGoalSummary, getGoalDetail } from './goals.js';
import { getState, setState } from './state.js';
import { listWorkflows, getWorkflow, getWorkflowSummary, getWorkflowDetail, createWorkflow, startWorkflow, cancelWorkflow, pauseWorkflow, resumeWorkflow } from './workflow-engine.js';
import { listSkills } from './skills.js';
import { getTodayNotes, getNotesForDate, listAvailableDates } from './daily-notes.js';
import { listNotes as listUserNotes, addNote as addUserNote, deleteNote as deleteUserNote } from './user-notes.js';
import { isConnected as isMcpConnected, getConnectionStats as getMcpStats, searchMemories, memoryTimeline, getVestigeStats, deleteMemory, smartIngest } from './mcp-gateway.js';
import { clear, getMessages } from './history.js';
import { resetSession } from './claude.js';
import { getHealthSnapshot, getDetailedMetrics } from './metrics.js';
import { listPlugins } from './plugins.js';
import { getCostSummary, getCostOverview } from './cost-analytics.js';
import { getOutcomeSummary, getLowEngagementCrons } from './outcome-tracker.js';
import { runReview, getReviewHistory } from './self-review.js';
import { registerBroadcast, emit as wsEmit } from './ws-events.js';
import { getChannelStats } from './ws-gateway.js';
import { getErrors, markErrorResolved } from './db.js';
import { getAgentLoopStatus, getAgentLoopDetail, getCycleDiffs, markCycleReviewed, triggerCycleNow } from './agent-loop.js';
import { listIdeas, addIdea, updateIdea, removeIdea, seedIfEmpty as seedIdeas } from './ideas.js';
import { listProjects, getProject, createProject, importProject, addGoalToProject, scanDirectory } from './projects.js';
import { getModuleApiRoutes } from './module-loader.js';
import { getMemoryDashboard, getTier, getHeapStats } from './memory-guardian.js';

const log = createLogger('bot-ipc');
const SOUL_PATH = config.soulPath;
const PROACTIVE_START = '## When you act on your own';
const PROACTIVE_END = '## What you know about the user';

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
// Reuse existing token across restarts to avoid auth rejections during timing window
let IPC_TOKEN;
try {
  if (existsSync(PORT_FILE)) {
    const raw = readFileSync(PORT_FILE, 'utf-8').trim();
    if (raw.startsWith('{')) {
      const cfg = JSON.parse(raw);
      if (cfg.token && typeof cfg.token === 'string' && cfg.token.length >= 48) {
        IPC_TOKEN = cfg.token;
      }
    }
  }
} catch {}
if (!IPC_TOKEN) IPC_TOKEN = randomBytes(24).toString('hex');
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

  // Auth check — require Bearer token on all endpoints except /healthz
  if (path !== '/healthz') {
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${IPC_TOKEN}`) {
      log.warn({ path, ip: req.socket.remoteAddress }, 'IPC auth rejected');
      return jsonResponse(res, { error: 'Unauthorized' }, 401);
    }
  }

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
        const time = m.ts ? new Date(m.ts).toLocaleTimeString('en-IL', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' }) : '??:??';
        const role = m.role === 'user' ? 'the user' : 'Bot';
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
      // Input length limits — prevent DoS via oversized payloads
      if (body.name.length > 256 || body.schedule.length > 128 || body.prompt.length > 10000) {
        return jsonResponse(res, { error: 'Field too long (name≤256, schedule≤128, prompt≤10000)' }, 400);
      }
      const job = addCron(body.name, body.schedule, body.prompt, null, body.delivery || 'announce', body.model || null);
      wsEmit('cron_added', { id: job.id, name: job.name, schedule: job.schedule });
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
        wsEmit('cron_deleted', { id: idOrName, name: deleted?.name || idOrName });
        return jsonResponse(res, { success: !!deleted, name: deleted?.name || idOrName });
      }
      if (action === 'toggle') {
        const toggled = toggleCron(idOrName);
        wsEmit('cron_updated', { id: idOrName, name: toggled?.name, enabled: toggled?.enabled });
        return jsonResponse(res, { success: !!toggled, name: toggled?.name, enabled: toggled?.enabled });
      }
      if (action === 'run') {
        const ran = runCronNow(idOrName);
        return jsonResponse(res, { success: !!ran, name: ran || idOrName });
      }
    }

    // --- Goals ---
    if (path === '/goals' && method === 'GET') {
      const all = url.searchParams.get('all');
      const status = url.searchParams.get('status');
      const parentGoalId = url.searchParams.get('parentGoalId');
      const filter = all ? {} : (status ? { status: status.split(',') } : { status: ['active', 'in_progress', 'pending', 'blocked', 'draft'] });
      if (parentGoalId) filter.parentGoalId = parentGoalId;
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
        source: body.source || 'claude',
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

    // --- Projects ---
    if (path === '/projects' && method === 'GET') {
      const projects = listProjects();
      return jsonResponse(res, { projects });
    }

    if (path === '/projects' && method === 'POST') {
      const body = await readBody(req);
      if (!body.brief) return jsonResponse(res, { error: 'Missing required field: brief' }, 400);
      if (typeof body.brief !== 'string' || body.brief.length > 10000) {
        return jsonResponse(res, { error: 'Brief must be a string under 10000 chars' }, 400);
      }
      try {
        const result = await createProject(body.brief, {
          title: body.title,
          priority: body.priority,
        });
        return jsonResponse(res, {
          success: true,
          id: result.project.id,
          title: result.project.title,
          slug: result.slug,
          goals: result.childGoals.length,
        });
      } catch (err) {
        log.error({ err }, 'Project creation failed');
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (path === '/projects/browse' && method === 'GET') {
      const browsePath = url.searchParams.get('path') || homedir();
      try {
        const resolved = resolvePath(browsePath);
        const entries = readdirSync(resolved, { withFileTypes: true });
        const dirs = [];
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('.') && entry.name !== '..') continue;
          dirs.push(entry.name);
        }
        dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        // Also provide parent path for "go up"
        const parent = resolvePath(resolved, '..');
        return jsonResponse(res, { current: resolved, parent: parent !== resolved ? parent : null, dirs });
      } catch (err) {
        return jsonResponse(res, { error: 'Cannot read directory: ' + err.message, current: browsePath, parent: null, dirs: [] }, 400);
      }
    }

    if (path === '/projects/import' && method === 'POST') {
      const body = await readBody(req);
      if (!body.path) return jsonResponse(res, { error: 'Missing required field: path' }, 400);
      if (typeof body.path !== 'string' || body.path.length > 500) {
        return jsonResponse(res, { error: 'Path must be a string under 500 chars' }, 400);
      }
      try {
        const result = importProject(body.path, {
          title: body.title,
          description: body.description,
          priority: body.priority,
        });
        return jsonResponse(res, {
          success: true,
          id: result.project.id,
          title: result.project.title,
          slug: result.slug,
          files: result.fileTree.totalFiles,
          dirs: result.fileTree.totalDirs,
        });
      } catch (err) {
        log.error({ err }, 'Project import failed');
        return jsonResponse(res, { error: err.message }, 400);
      }
    }

    if (path === '/projects/scan' && method === 'POST') {
      const body = await readBody(req);
      if (!body.path) return jsonResponse(res, { error: 'Missing required field: path' }, 400);
      try {
        const tree = scanDirectory(body.path, 2);
        return jsonResponse(res, { tree });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 400);
      }
    }

    const projectDetailMatch = path.match(/^\/projects\/([^/]+)$/);
    if (projectDetailMatch && method === 'GET') {
      const id = decodeURIComponent(projectDetailMatch[1]);
      const project = getProject(id);
      if (!project) return jsonResponse(res, { error: 'Project not found' }, 404);
      return jsonResponse(res, { project });
    }

    const projectGoalMatch = path.match(/^\/projects\/([^/]+)\/goals$/);
    if (projectGoalMatch && method === 'POST') {
      const projectId = decodeURIComponent(projectGoalMatch[1]);
      const body = await readBody(req);
      if (!body.title) return jsonResponse(res, { error: 'Missing required field: title' }, 400);
      if (typeof body.title !== 'string' || body.title.length > 256) {
        return jsonResponse(res, { error: 'Title must be a string under 256 chars' }, 400);
      }
      try {
        const goal = addGoalToProject(projectId, body.title, {
          description: body.description,
          priority: body.priority,
          milestones: body.milestones,
        });
        return jsonResponse(res, { success: true, goal: { id: goal.id, title: goal.title, status: goal.status } });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 400);
      }
    }

    // --- Brain ---
    if (path === '/brain' && method === 'GET') {
      const patterns = getState('agent-patterns')?.patterns || [];
      const proposals = getState('agent-proposals')?.proposals || [];
      const rates = getState('agent-rate-limits') || {};
      return jsonResponse(res, { patterns, proposals, rates });
    }

    // --- Brain: review a proposal (approve/reject from Mission Control) ---
    const proposalReviewMatch = path.match(/^\/brain\/proposals\/([^/]+)\/review$/);
    if (proposalReviewMatch && method === 'POST') {
      const proposalId = decodeURIComponent(proposalReviewMatch[1]);
      const body = await readBody(req);
      const action = body.action; // "approve" or "reject"
      if (action !== 'approve' && action !== 'reject') {
        return jsonResponse(res, { error: 'action must be "approve" or "reject"' }, 400);
      }
      const proposals = getState('agent-proposals') || {};
      if (!Array.isArray(proposals.proposals)) proposals.proposals = [];
      const idx = proposals.proposals.findIndex(p => (p.id || p.proposalId) === proposalId);
      if (idx === -1) return jsonResponse(res, { error: 'Proposal not found' }, 404);
      const proposal = proposals.proposals[idx];
      // Remove the proposal from the list immediately (approved or rejected — either way, done)
      proposals.proposals.splice(idx, 1);
      setState('agent-proposals', proposals);
      // Respond immediately — LLM execution runs in background to avoid HTTP timeout (502)
      jsonResponse(res, { success: true, proposalId, action, executed: 'queued' });
      log.info({ proposalId, action }, 'Proposal reviewed via MC — executing in background');
      // Fire-and-forget: execute the action asynchronously
      import('./agent-brain.js').then(({ executeApprovedAction }) =>
        executeApprovedAction(proposal, null, action)
      ).catch(err => {
        log.warn({ err: err.message, proposalId }, 'Failed to execute proposal action via MC');
      });
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
      const yest = new Date(Date.now() - 86400_000).toLocaleDateString('en-CA', { timeZone: config.timezone });
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

    // --- Health check (lightweight, enhanced with Memory Guardian tier) ---
    if (path === '/healthz' && method === 'GET') {
      const mcpOk = isMcpConnected();
      const qStats = queueStatsFn?.() || {};
      const heapStats = getHeapStats();
      const tier = getTier(heapStats.heapPct);

      // Degraded if: MCP disconnected, queue > 80% full, or Memory Guardian tier is SHED+
      const degraded = !mcpOk || tier.name !== 'normal' && tier.name !== 'warn' || (qStats.waiting || 0) > 3;
      const status = degraded ? 'degraded' : 'ok';

      res.writeHead(degraded ? 503 : 200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status, pid: process.pid, mcp: mcpOk, heap_pct: heapStats.heapPct,
        heap_mb: heapStats.heapUsedMB, memory_tier: tier.name,
        queue_waiting: qStats.waiting || 0,
      }));
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

    // --- Memory Guardian dashboard ---
    if (path === '/memory' && method === 'GET') {
      try {
        const dashboard = getMemoryDashboard();
        return jsonResponse(res, dashboard);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // --- Memory Guardian self-test ---
    if (path === '/memory/test' && method === 'GET') {
      try {
        const { selfTest } = await import('./memory-guardian-test.js');
        const result = selfTest();
        return jsonResponse(res, result);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // --- Recap ---
    if (path === '/recap' && method === 'GET') {
      const { getLastRecap, getRecentRecaps } = await import('./recap.js');
      const latest = getLastRecap() || { text: null, generatedAt: null };
      const recaps = getRecentRecaps();
      return jsonResponse(res, { ...latest, recaps });
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

    // --- Services (MCP + plugins + WS gateway overview) ---
    if (path === '/services' && method === 'GET') {
      const mcpStats = getMcpStats();
      const plugins = listPlugins();
      const gwStats = getChannelStats();
      return jsonResponse(res, {
        mcp: [
          { name: 'Vestige MCP', type: 'mcp', status: mcpStats.connected ? 'connected' : 'disconnected', failures: mcpStats.consecutiveFailures },
          { name: 'Bot MCP Server', type: 'mcp', status: 'running', failures: 0 },
        ],
        gateway: {
          name: 'WS Gateway',
          status: gwStats.running ? 'running' : 'stopped',
          port: gwStats.port,
          channels: gwStats.connected,
          adapters: gwStats.channels,
        },
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

    // --- Error history (dashboard panel) ---
    if (path === '/errors' && method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const severity = url.searchParams.get('severity') || null;
      const search = url.searchParams.get('q') || null;

      let errors = getErrors(limit, offset, severity);

      // Client-side search filter (search is low-volume, no need for SQL LIKE index)
      if (search) {
        const q = search.toLowerCase();
        errors = errors.filter(e =>
          e.message?.toLowerCase().includes(q) ||
          e.module?.toLowerCase().includes(q) ||
          e.stack?.toLowerCase().includes(q)
        );
      }

      return jsonResponse(res, { errors, limit, offset, count: errors.length });
    }

    const errorResolveMatch = path.match(/^\/errors\/(\d+)\/resolve$/);
    if (errorResolveMatch && method === 'POST') {
      const id = parseInt(errorResolveMatch[1], 10);
      markErrorResolved(id);
      return jsonResponse(res, { success: true, id });
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

    // --- Cron Health (plugin stats) ---
    if (path === '/cron-health' && method === 'GET') {
      const stats = getState('plugin_cron-health') || {};
      const crons = stats.crons || {};
      return jsonResponse(res, { crons });
    }

    // --- Test Runner ---
    if (path === '/tests/list' && method === 'GET') {
      const { readdirSync } = await import('fs');
      const testDir = config.testDir;
      try {
        const files = readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort();
        return jsonResponse(res, { files });
      } catch (err) {
        return jsonResponse(res, { files: [], error: err.message });
      }
    }

    if (path === '/tests/run' && method === 'POST') {
      const { execFile } = await import('child_process');
      const testDir = config.testDir;
      const reqBody = await readBody(req);
      const file = reqBody?.file; // optional: run single test file
      if (file && (!file.endsWith('.test.js') || file.includes('..') || file.includes('/') || file.includes('\\'))) {
        return jsonResponse(res, { error: 'Invalid test file' }, 400);
      }
      // Use basename to strip any directory component as defense-in-depth
      const safeFile = file ? require('path').basename(file) : null;
      const target = safeFile ? join(testDir, safeFile) : join(testDir, 'run-all.js');
      return new Promise((resolve) => {
        execFile('node', [target], { timeout: 30000, cwd: config.projectRoot, env: { ...process.env, LOG_LEVEL: 'silent' } }, (err, stdout, stderr) => {
          const output = stdout + (stderr || '');
          const passed = (output.match(/(\d+) passed/g) || []).reduce((sum, m) => sum + parseInt(m), 0);
          const failed = (output.match(/(\d+) failed/g) || []).reduce((sum, m) => sum + parseInt(m), 0);
          resolve(jsonResponse(res, {
            success: !err || err.code === 0,
            passed, failed, total: passed + failed,
            output: output.slice(-30000),
            file: file || 'all',
            ranAt: Date.now(),
          }));
        });
      });
    }

    // --- Self-Review ---
    if (path === '/review/history' && method === 'GET') {
      return jsonResponse(res, { history: getReviewHistory() });
    }

    if (path === '/review' && method === 'POST') {
      try {
        const review = runReview();
        return jsonResponse(res, review);
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // --- Memories (Vestige) ---
    if (path === '/memories/search' && method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const limit = parseInt(url.searchParams.get('limit') || '20');
      if (!q.trim()) return jsonResponse(res, { error: 'Missing query parameter: q' }, 400);
      try {
        const raw = await searchMemories(q, { limit, detail_level: 'full' });
        return jsonResponse(res, { query: q, results: raw });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (path === '/memories/timeline' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const nodeType = url.searchParams.get('type') || undefined;
      try {
        const raw = await memoryTimeline({ limit, detail_level: 'summary', node_type: nodeType });
        return jsonResponse(res, { timeline: raw });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (path === '/memories/stats' && method === 'GET') {
      try {
        const raw = await getVestigeStats();
        return jsonResponse(res, { stats: raw });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (path === '/memories/ingest' && method === 'POST') {
      const body = await readBody(req);
      if (!body.content) return jsonResponse(res, { error: 'Missing content' }, 400);
      try {
        const result = await smartIngest(body.content, body.tags || [], body.nodeType || 'fact', 'dashboard');
        wsEmit('memory_ingested', { nodeType: body.nodeType || 'fact', tags: body.tags || [] });
        return jsonResponse(res, { success: true, result });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    const memDeleteMatch = path.match(/^\/memories\/([^/]+)\/delete$/);
    if (memDeleteMatch && method === 'POST') {
      const id = decodeURIComponent(memDeleteMatch[1]);
      try {
        const result = await deleteMemory(id);
        return jsonResponse(res, { success: true, result });
      } catch (err) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // --- Agent Loop ---
    if (path === '/agent-loop' && method === 'GET') {
      return jsonResponse(res, getAgentLoopDetail());
    }

    if (path === '/agent-loop/trigger' && method === 'POST') {
      const result = triggerCycleNow();
      return jsonResponse(res, result, result.triggered ? 200 : 409);
    }

    // --- Cycle Diffs (review) ---
    if (path === '/cycle-diffs' && method === 'GET') {
      return jsonResponse(res, { diffs: getCycleDiffs(20) });
    }
    const promptMatch = path.match(/^\/cycle-diffs\/(\d+)\/prompt$/);
    if (promptMatch && method === 'GET') {
      const cycleNum = parseInt(promptMatch[1], 10);
      const promptPath = join(config.dataDir, 'cycle-diffs', `cycle-${cycleNum}-prompt.txt`);
      try {
        const content = readFileSync(promptPath, 'utf-8');
        return jsonResponse(res, { cycle: cycleNum, prompt: content });
      } catch {
        return jsonResponse(res, { error: 'Prompt file not found' }, 404);
      }
    }
    // --- CLI Prompts (all prompts sent to Claude CLI) ---
    const cliPromptMatch = path.match(/^\/cli-prompts\/([a-z0-9-]+)$/);
    if (cliPromptMatch && method === 'GET') {
      const promptId = cliPromptMatch[1];
      const promptPath = join(config.dataDir, 'cli-prompts', `prompt-${promptId}.txt`);
      try {
        const content = readFileSync(promptPath, 'utf-8');
        return jsonResponse(res, { promptId, prompt: content });
      } catch {
        return jsonResponse(res, { error: 'Prompt file not found' }, 404);
      }
    }

    const reviewMatch = path.match(/^\/cycle-diffs\/(\d+)\/review$/);
    if (reviewMatch && method === 'POST') {
      const ok = markCycleReviewed(parseInt(reviewMatch[1], 10));
      return jsonResponse(res, { success: ok });
    }

    // --- Ideas ---
    if (path === '/ideas' && method === 'GET') {
      return jsonResponse(res, { ideas: listIdeas() });
    }

    if (path === '/ideas' && method === 'POST') {
      const body = await readBody(req);
      if (!body.title || !body.title.trim()) {
        return jsonResponse(res, { error: 'Missing required field: title' }, 400);
      }
      const idea = addIdea(body);
      return jsonResponse(res, { success: true, idea });
    }

    const ideaUpdateMatch = path.match(/^\/ideas\/(\d+)$/);
    if (ideaUpdateMatch && (method === 'PUT' || method === 'PATCH')) {
      const id = parseInt(ideaUpdateMatch[1], 10);
      const body = await readBody(req);
      const updated = updateIdea(id, body);
      if (!updated) return jsonResponse(res, { error: 'Idea not found' }, 404);
      return jsonResponse(res, { success: true, idea: updated });
    }

    const ideaDeleteMatch = path.match(/^\/ideas\/(\d+)\/delete$/);
    if (ideaDeleteMatch && method === 'POST') {
      const id = parseInt(ideaDeleteMatch[1], 10);
      const removed = removeIdea(id);
      if (!removed) return jsonResponse(res, { error: 'Idea not found' }, 404);
      return jsonResponse(res, { success: true, id });
    }

    const ideaPromoteMatch = path.match(/^\/ideas\/(\d+)\/promote$/);
    if (ideaPromoteMatch && method === 'POST') {
      const id = parseInt(ideaPromoteMatch[1], 10);
      const body = await readBody(req);
      if (!body.title || !body.title.trim()) {
        return jsonResponse(res, { error: 'Missing required field: title' }, 400);
      }
      const goal = addGoal(body.title, {
        description: body.description,
        priority: body.priority || 'medium',
        category: body.category || 'improvement',
        source: 'ideas',
      });
      const removed = removeIdea(id);
      if (!removed) {
        // Goal was created but idea not found — still succeed
        return jsonResponse(res, { success: true, goal, warning: 'Idea not found for deletion' });
      }
      return jsonResponse(res, { success: true, goal, deletedIdeaId: id });
    }

    if (path === '/ideas/seed' && method === 'POST') {
      const body = await readBody(req);
      const seeded = seedIdeas(body.ideas || []);
      return jsonResponse(res, { success: true, seeded });
    }

    // --- Module routes (Hattrick, etc.) ---
    const moduleRoute = getModuleApiRoutes().find(r => r.path === path && r.method === method);
    if (moduleRoute) {
      return moduleRoute.handler(req, res, { getState, setState, triggerCycleNow, jsonResponse });
    }

    jsonResponse(res, { error: 'Not found' }, 404);
  } catch (err) {
    log.error({ err: err.message, path }, 'IPC request failed');
    jsonResponse(res, { error: err.message }, 500);
  }
}

// --- WebSocket live push ---

let wss = null;
let wsPushTimer = null;
let lastPushHash = '';

function gatherLiveState() {
  const qStats = queueStatsFn?.() || { running: 0, waiting: 0 };
  const mcpStats = getMcpStats();
  const plugins = listPlugins();
  const cronHealthStats = getState('plugin_cron-health') || {};
  const costOverview = getCostOverview();
  const weekCosts = getCostSummary('week');
  costOverview.byDay = weekCosts.byDay || {};

  const cronsList = listCrons().map(j => ({
    id: j.id, name: j.name, schedule: j.schedule,
    enabled: j.enabled, delivery: j.delivery, model: j.model,
    prompt: j.prompt?.slice(0, 200),
    lastRun: j.state?.lastRun, nextRun: j.state?.nextRun,
    consecutiveErrors: j.state?.consecutiveErrors || 0,
  }));

  return {
    status: getHealthSnapshot({
      model: config.claudeModel,
      queue: qStats,
      vestige_mcp: isMcpConnected() ? 'connected' : 'disconnected',
      cron_count: cronsList.length,
    }),
    crons: { crons: cronsList, summary: getCronSummary() },
    services: {
      mcp: [
        { name: 'Vestige MCP', type: 'mcp', status: mcpStats.connected ? 'connected' : 'disconnected', failures: mcpStats.consecutiveFailures },
        { name: 'Bot MCP Server', type: 'mcp', status: 'running', failures: 0 },
      ],
      plugins: plugins.map(p => ({ name: p.name, status: p.enabled ? 'active' : 'disabled', hooks: p.hooks || [] })),
    },
    cronHealth: { crons: cronHealthStats.crons || {} },
    costs: costOverview,
    agentLoop: getAgentLoopDetail(),
  };
}

function broadcastState() {
  if (!wss || wss.clients.size === 0) return;

  const state = gatherLiveState();
  const payload = JSON.stringify({ type: 'state', ts: Date.now(), data: state });

  // Skip if nothing changed (cheap hash comparison)
  const hash = payload.length + ':' + payload.slice(0, 200);
  if (hash === lastPushHash) return;
  lastPushHash = hash;

  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

/** Broadcast an event to all connected WS clients */
export function broadcastEvent(event, data) {
  if (!wss || wss.clients.size === 0) return;
  const payload = JSON.stringify({ type: 'event', event, ts: Date.now(), data });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

export function startIpcServer({ queueStats } = {}) {
  queueStatsFn = queueStats;

  server = http.createServer(handleRequest);

  // WebSocket server — handles upgrade requests
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    // Auth: prefer Authorization header, fall back to query param for backward compat
    const authHeader = req.headers.authorization || '';
    const url = new URL(req.url, 'http://localhost');
    const queryToken = url.searchParams.get('token');
    const authenticated = authHeader === `Bearer ${IPC_TOKEN}` || queryToken === IPC_TOKEN;
    if (!authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    log.info({ clients: wss.clients.size }, 'WS client connected');

    // Send full state immediately on connect
    try {
      const state = gatherLiveState();
      ws.send(JSON.stringify({ type: 'state', ts: Date.now(), data: state }));
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to send initial WS state');
    }

    ws.on('close', () => {
      log.info({ clients: wss.clients.size }, 'WS client disconnected');
    });

    ws.on('error', (err) => {
      log.warn({ err: err.message }, 'WS client error');
    });
  });

  // Register broadcast for other modules to push events
  registerBroadcast(broadcastEvent);

  // Push state every 5s to connected clients
  wsPushTimer = setInterval(broadcastState, 5000);
  wsPushTimer.unref();

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    mkdirSync(config.dataDir, { recursive: true });
    // Write port + token so authorized consumers can authenticate
    writeFileSync(PORT_FILE, JSON.stringify({ port, token: IPC_TOKEN, pid: process.pid }));
    try { chmodSync(PORT_FILE, 0o600); } catch {} // restrict to owner (best-effort on Windows)
    log.info({ port }, 'Bot IPC server started (HTTP + WS)');
  });

  return server;
}

export function stopIpcServer() {
  if (wsPushTimer) {
    clearInterval(wsPushTimer);
    wsPushTimer = null;
  }
  if (wss) {
    wss.close();
    wss = null;
  }
  if (server) {
    server.close();
    server = null;
  }
}
