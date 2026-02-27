#!/usr/bin/env node
/**
 * Bot Operations MCP Server.
 * Spawned by Claude CLI as an MCP server. Proxies tool calls
 * to the bot's internal IPC HTTP API.
 *
 * Usage in mcp-config.json:
 *   "bot-ops": { "command": "node", "args": ["<project-path>/lib/bot-mcp-server.js"] }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import http from 'http';

const DATA_DIR = join(process.env.HOME || process.env.USERPROFILE || '', 'sela', 'data');
const PORT_FILE = join(DATA_DIR, '.ipc-port');

function getIpcConfig() {
  try {
    const raw = readFileSync(PORT_FILE, 'utf-8').trim();
    // Support both new JSON format and legacy plain port
    if (raw.startsWith('{')) {
      const config = JSON.parse(raw);
      return { port: config.port, token: config.token };
    }
    return { port: parseInt(raw), token: null };
  } catch {
    return null;
  }
}

function ipcCall(method, path, body = null) {
  const config = getIpcConfig();
  if (!config) return Promise.reject(new Error('Bot IPC not available (no port file). Is the bot running?'));

  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: config.port, path, method, headers: {} };
    if (config.token) {
      opts.headers['Authorization'] = `Bearer ${config.token}`;
    }
    if (body) {
      const bodyStr = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });

    req.on('error', (err) => reject(new Error(`IPC connection failed: ${err.message}`)));
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('IPC timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function textResult(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function errorResult(msg) {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

// --- MCP Server setup ---

const server = new Server(
  { name: 'bot-ops', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'bot_status',
      description: 'Get live bot status: uptime, memory, model, queue, MCP connection, cron count. Use this when the user asks "how are you", "status", or "מה המצב".',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'bot_list_crons',
      description: 'List all cron jobs with schedule, status, last run, next run, and error count.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'bot_cron_add',
      description: 'Create a new recurring cron job. Schedule uses standard cron syntax in the configured timezone.',
      inputSchema: {
        type: 'object',
        required: ['name', 'schedule', 'prompt'],
        properties: {
          name: { type: 'string', description: 'Unique job name (kebab-case)' },
          schedule: { type: 'string', description: 'Cron expression (e.g., "0 9 * * *" for 9am daily)' },
          prompt: { type: 'string', description: 'The prompt to execute on each run. Must be self-contained (no conversation context).' },
          delivery: { type: 'string', enum: ['announce', 'silent'], default: 'announce', description: 'announce = send result to WhatsApp, silent = only alert on failure' },
          model: { type: 'string', description: 'Model override (optional). Default uses bot config model.' },
        },
      },
    },
    {
      name: 'bot_cron_delete',
      description: 'Delete a cron job by name or ID.',
      inputSchema: {
        type: 'object', required: ['id_or_name'],
        properties: { id_or_name: { type: 'string', description: 'Cron job name or ID' } },
      },
    },
    {
      name: 'bot_cron_toggle',
      description: 'Enable or disable a cron job by name or ID.',
      inputSchema: {
        type: 'object', required: ['id_or_name'],
        properties: { id_or_name: { type: 'string', description: 'Cron job name or ID' } },
      },
    },
    {
      name: 'bot_cron_run',
      description: 'Execute a cron job immediately (one-off run).',
      inputSchema: {
        type: 'object', required: ['id_or_name'],
        properties: { id_or_name: { type: 'string', description: 'Cron job name or ID' } },
      },
    },
    {
      name: 'bot_goal_list',
      description: 'List goals with progress. Optional status filter (active, in_progress, blocked, completed, abandoned).',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', description: 'Comma-separated statuses to filter (e.g., "active,in_progress"). Default: all.' } },
      },
    },
    {
      name: 'bot_goal_add',
      description: 'Create a new long-running goal. Use when the user mentions a new project, objective, or multi-day effort.',
      inputSchema: {
        type: 'object', required: ['title'],
        properties: {
          title: { type: 'string', description: 'Short imperative title (e.g., "Ship mission control v1")' },
          description: { type: 'string', description: 'Success criteria and context' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'], default: 'normal' },
          category: { type: 'string', enum: ['project', 'learning', 'health', 'habit', 'ops', 'personal'], default: 'project' },
          deadline: { type: 'string', description: 'ISO date (YYYY-MM-DD) or null' },
          linkedTopics: { type: 'array', items: { type: 'string' }, description: 'Keywords to match in future conversations' },
          milestones: { type: 'array', items: { type: 'string' }, description: 'Ordered list of milestone titles' },
        },
      },
    },
    {
      name: 'bot_goal_update',
      description: 'Update a goal: change status, priority, description, progress, deadline, or linkedTopics.',
      inputSchema: {
        type: 'object', required: ['id_or_title'],
        properties: {
          id_or_title: { type: 'string', description: 'Goal ID or title (partial match)' },
          status: { type: 'string', enum: ['active', 'in_progress', 'blocked', 'completed', 'abandoned'] },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
          description: { type: 'string' },
          progress: { type: 'number', description: 'Manual progress 0-100 (only works if goal has no milestones)' },
          deadline: { type: 'string' },
          linkedTopics: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    {
      name: 'bot_goal_complete',
      description: 'Mark a goal as completed.',
      inputSchema: {
        type: 'object', required: ['id_or_title'],
        properties: { id_or_title: { type: 'string', description: 'Goal ID or title' } },
      },
    },
    {
      name: 'bot_goal_detail',
      description: 'Get full goal details: milestones, activity log, progress. Use when the user asks about a specific goal.',
      inputSchema: {
        type: 'object', required: ['id_or_title'],
        properties: { id_or_title: { type: 'string', description: 'Goal ID or title (partial match)' } },
      },
    },
    {
      name: 'bot_goal_milestone_add',
      description: 'Add a milestone to a goal.',
      inputSchema: {
        type: 'object', required: ['goal', 'title'],
        properties: {
          goal: { type: 'string', description: 'Goal ID or title' },
          title: { type: 'string', description: 'Milestone title' },
        },
      },
    },
    {
      name: 'bot_goal_milestone_complete',
      description: 'Mark a milestone as done. If all milestones are done, the goal auto-completes.',
      inputSchema: {
        type: 'object', required: ['goal', 'milestone'],
        properties: {
          goal: { type: 'string', description: 'Goal ID or title' },
          milestone: { type: 'string', description: 'Milestone ID or title (partial match)' },
          evidence: { type: 'string', description: 'What proved this milestone is done (optional)' },
        },
      },
    },
    // Removed: bot_workflow_* (6 tools, unused), bot_list_files, bot_list_skills (Claude has Glob)
    // Removed: bot_costs (Claude can read DB), bot_export (Claude has Read), bot_clear_history (Claude has Bash)
    {
      name: 'bot_today_notes',
      description: "Get today's conversation notes and activity log.",
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'bot_search_notes',
      description: 'Get notes for a specific date.',
      inputSchema: {
        type: 'object', required: ['date'],
        properties: { date: { type: 'string', description: 'Date in YYYY-MM-DD format' } },
      },
    },
  ],
}));

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'bot_status':
        return textResult(await ipcCall('GET', '/status'));
      case 'bot_list_crons':
        return textResult(await ipcCall('GET', '/crons'));
      case 'bot_cron_add':
        return textResult(await ipcCall('POST', '/crons', args));
      case 'bot_cron_delete':
        return textResult(await ipcCall('POST', `/crons/${encodeURIComponent(args.id_or_name)}/delete`));
      case 'bot_cron_toggle':
        return textResult(await ipcCall('POST', `/crons/${encodeURIComponent(args.id_or_name)}/toggle`));
      case 'bot_cron_run':
        return textResult(await ipcCall('POST', `/crons/${encodeURIComponent(args.id_or_name)}/run`));
      case 'bot_goal_list':
        return textResult(await ipcCall('GET', `/goals${args.status ? '?status=' + args.status : ''}`));
      case 'bot_goal_add':
        return textResult(await ipcCall('POST', '/goals', args));
      case 'bot_goal_update':
        return textResult(await ipcCall('POST', `/goals/${encodeURIComponent(args.id_or_title)}/update`, args));
      case 'bot_goal_complete':
        return textResult(await ipcCall('POST', `/goals/${encodeURIComponent(args.id_or_title)}/update`, { status: 'completed' }));
      case 'bot_goal_detail':
        return textResult(await ipcCall('GET', `/goals/${encodeURIComponent(args.id_or_title)}`));
      case 'bot_goal_milestone_add':
        return textResult(await ipcCall('POST', `/goals/${encodeURIComponent(args.goal)}/milestone-add`, { title: args.title }));
      case 'bot_goal_milestone_complete':
        return textResult(await ipcCall('POST', `/goals/${encodeURIComponent(args.goal)}/milestone-complete`, { milestone: args.milestone, evidence: args.evidence }));
      case 'bot_today_notes':
        return textResult(await ipcCall('GET', '/notes/today'));
      case 'bot_search_notes':
        return textResult(await ipcCall('GET', `/notes/${args.date}`));
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(err.message);
  }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
