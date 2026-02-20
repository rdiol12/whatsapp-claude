#!/usr/bin/env node
/**
 * Bot Operations MCP Server.
 * Spawned by Claude CLI as an MCP server. Proxies tool calls
 * to the bot's internal IPC HTTP API.
 *
 * Usage in mcp-config.json:
 *   "bot-ops": { "command": "node", "args": ["C:/Users/rdiol/whatsapp-claude/lib/bot-mcp-server.js"] }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import http from 'http';

const DATA_DIR = join(process.env.HOME || process.env.USERPROFILE || '', 'whatsapp-claude', 'data');
const PORT_FILE = join(DATA_DIR, '.ipc-port');

function getPort() {
  try {
    return parseInt(readFileSync(PORT_FILE, 'utf-8').trim());
  } catch {
    return null;
  }
}

function ipcCall(method, path, body = null) {
  const port = getPort();
  if (!port) return Promise.reject(new Error('Bot IPC not available (no port file). Is the bot running?'));

  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port, path, method, headers: {} };
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
      description: 'Get live bot status: uptime, memory, model, queue, MCP connection, cron count. Use this when Ron asks "how are you", "status", or "מה המצב".',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'bot_list_crons',
      description: 'List all cron jobs with schedule, status, last run, next run, and error count.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'bot_cron_add',
      description: 'Create a new recurring cron job. Schedule uses standard cron syntax in Asia/Jerusalem timezone.',
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
      description: 'Create a new long-running goal. Use when Ron mentions a new project, objective, or multi-day effort.',
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
      description: 'Get full goal details: milestones, activity log, progress. Use when Ron asks about a specific goal.',
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
    {
      name: 'bot_workflow_list',
      description: 'List all workflows with status, progress, and cost. Optional status filter.',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', description: 'Comma-separated statuses (running,paused,pending,completed,failed,cancelled)' } },
      },
    },
    {
      name: 'bot_workflow_create',
      description: 'Create and start a multi-step workflow. Steps execute as a DAG with dependencies.',
      inputSchema: {
        type: 'object', required: ['name', 'steps'],
        properties: {
          name: { type: 'string', description: 'Human-readable workflow name' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Step ID (e.g., s1, s2)' },
                type: { type: 'string', enum: ['claude', 'tool', 'wait_input', 'conditional', 'delay'], default: 'claude' },
                description: { type: 'string' },
                dependsOn: { type: 'array', items: { type: 'string' }, description: 'Step IDs this depends on' },
                config: { type: 'object', description: 'Step config (prompt for claude, command for tool, etc.)' },
              },
            },
          },
          notifyPolicy: { type: 'string', enum: ['silent', 'summary', 'verbose'], default: 'summary' },
        },
      },
    },
    {
      name: 'bot_workflow_detail',
      description: 'Get full workflow details: all steps with status, timing, results.',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string', description: 'Workflow ID (e.g., wf_a1b2c3d4)' } },
      },
    },
    {
      name: 'bot_workflow_cancel',
      description: 'Cancel a running or paused workflow.',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string', description: 'Workflow ID' } },
      },
    },
    {
      name: 'bot_workflow_pause',
      description: 'Pause a running workflow. Can be resumed later.',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string', description: 'Workflow ID' } },
      },
    },
    {
      name: 'bot_workflow_resume',
      description: 'Resume a paused workflow.',
      inputSchema: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string', description: 'Workflow ID' } },
      },
    },
    {
      name: 'bot_list_files',
      description: 'List files in the bot workspace with sizes.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'bot_list_skills',
      description: 'List available bot skills (markdown skill files).',
      inputSchema: { type: 'object', properties: {} },
    },
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
    {
      name: 'bot_clear_history',
      description: 'Clear conversation history and reset the Claude session. Use when Ron asks to start fresh.',
      inputSchema: {
        type: 'object',
        properties: { jid: { type: 'string', description: 'JID to clear (optional, uses default if omitted)' } },
      },
    },
    {
      name: 'bot_costs',
      description: 'Get cost analytics for a period (today, week, month). Shows total spend, message count, tokens, and daily breakdown.',
      inputSchema: {
        type: 'object',
        properties: { period: { type: 'string', enum: ['today', 'week', 'month', 'all'], default: 'today' } },
      },
    },
    {
      name: 'bot_export',
      description: 'Export conversation transcript as formatted text.',
      inputSchema: {
        type: 'object',
        properties: { jid: { type: 'string', description: 'JID to export (optional, uses default if omitted)' } },
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
      case 'bot_workflow_list':
        return textResult(await ipcCall('GET', `/workflows${args.status ? '?status=' + args.status : ''}`));
      case 'bot_workflow_create':
        return textResult(await ipcCall('POST', '/workflows', args));
      case 'bot_workflow_detail':
        return textResult(await ipcCall('GET', `/workflows/${encodeURIComponent(args.id)}`));
      case 'bot_workflow_cancel':
        return textResult(await ipcCall('POST', `/workflows/${encodeURIComponent(args.id)}/cancel`));
      case 'bot_workflow_pause':
        return textResult(await ipcCall('POST', `/workflows/${encodeURIComponent(args.id)}/pause`));
      case 'bot_workflow_resume':
        return textResult(await ipcCall('POST', `/workflows/${encodeURIComponent(args.id)}/resume`));
      case 'bot_list_files':
        return textResult(await ipcCall('GET', '/files'));
      case 'bot_list_skills':
        return textResult(await ipcCall('GET', '/skills'));
      case 'bot_today_notes':
        return textResult(await ipcCall('GET', '/notes/today'));
      case 'bot_search_notes':
        return textResult(await ipcCall('GET', `/notes/${args.date}`));
      case 'bot_clear_history':
        return textResult(await ipcCall('POST', '/clear', { jid: args.jid }));
      case 'bot_costs':
        return textResult(await ipcCall('GET', `/costs?period=${args.period || 'today'}`));
      case 'bot_export':
        return textResult(await ipcCall('GET', `/export${args.jid ? '?jid=' + encodeURIComponent(args.jid) : ''}`));
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
