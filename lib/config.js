import { resolve } from 'path';
import { homedir } from 'os';

function envInt(key, fallback) {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

const config = {
  // --- Core ---
  allowedPhone: process.env.ALLOWED_PHONE || '',
  claudeModel: process.env.CLAUDE_MODEL || 'sonnet',
  maxHistory: envInt('MAX_HISTORY', 20),

  // --- Paths ---
  authDir: resolve(homedir(), 'sela', 'auth'),
  dataDir: resolve(homedir(), 'sela', 'data'),
  workspaceDir: resolve(homedir(), 'sela', 'workspace'),

  // --- Queue ---
  maxConcurrent: envInt('MAX_CONCURRENT', 2),
  maxQueuePerUser: envInt('MAX_QUEUE_PER_USER', 5),

  // --- Timeouts (ms) ---
  cliTimeout: envInt('CLI_TIMEOUT', 900_000),              // Claude CLI absolute max (safety net)
  cliActivityTimeout: envInt('CLI_ACTIVITY_TIMEOUT', 120_000), // Kill if no stdout for this long
  composingTimeout: envInt('COMPOSING_TIMEOUT', 90_000), // "typing" stuck detection
  mcpToolTimeout: envInt('MCP_TOOL_TIMEOUT', 10_000),   // vestige tool calls
  mcpSearchTimeout: envInt('MCP_SEARCH_TIMEOUT', 5_000), // vestige searches

  // --- WhatsApp ---
  maxChunk: envInt('MAX_CHUNK', 4000),         // message length limit
  batchDelay: envInt('BATCH_DELAY', 2000),     // debounce rapid messages (ms)

  // --- Quiet hours (Israel time, 24h format) ---
  quietStart: envInt('QUIET_START', 23),       // 23:00
  quietEnd: envInt('QUIET_END', 8),            // 08:00

  // --- Proactive ---
  proactiveInterval: envInt('PROACTIVE_INTERVAL', 30 * 60_000), // 30 min

  // --- Costs ---
  dailyCostLimit: parseFloat(process.env.DAILY_COST_LIMIT || '5'),

  // --- Persistent mode ---
  persistentMode: process.env.PERSISTENT_MODE === 'true',

  // --- Logs ---
  logRetentionDays: envInt('LOG_RETENTION_DAYS', 7),
};

// Baileys uses JID format: <number>@s.whatsapp.net
config.allowedJid = config.allowedPhone + '@s.whatsapp.net';

export default config;
