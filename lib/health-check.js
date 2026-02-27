/**
 * Health Check — Validates all system components after setup
 *
 * Checks: Claude CLI, Telegram bot, WhatsApp client, Vestige MCP, SQLite DB
 * Returns: { component: string, status: 'pass'|'fail'|'warn', message: string }[]
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, accessSync, constants as fsConstants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import config from './config.js';

const results = [];

function check(name, fn) {
  try {
    const result = fn();
    return { component: name, status: 'pass', message: result };
  } catch (err) {
    return { component: name, status: 'fail', message: err.message };
  }
}

export async function runHealthCheck() {
  // 1. SQLite Database
  results.push(check('SQLite Database', () => {
    const dbPath = join(config.dataDir, 'sela.db');
    if (!existsSync(dbPath)) throw new Error(`DB not found at ${dbPath}`);
    accessSync(dbPath, fsConstants.R_OK | fsConstants.W_OK);
    return `Ready at ${dbPath}`;
  }));

  // 2. Configuration
  results.push(check('Configuration', () => {
    if (!config.allowedPhone) throw new Error('ALLOWED_PHONE not set in .env');
    if (!config.claudeModel) throw new Error('CLAUDE_MODEL not set');
    return `Phone: ${config.allowedPhone}, Model: ${config.claudeModel}`;
  }));

  // 3. Environment directories
  results.push(check('Data Directory', () => {
    if (!existsSync(config.dataDir)) throw new Error(`${config.dataDir} does not exist`);
    return `Present at ${config.dataDir}`;
  }));

  results.push(check('Auth Directory', () => {
    if (!existsSync(config.authDir)) throw new Error(`${config.authDir} does not exist`);
    return `Present at ${config.authDir}`;
  }));

  // 4. Claude API — check if CLI is available
  results.push(check('Claude CLI', () => {
    try {
      execSync('claude --version', { stdio: 'ignore', timeout: 3000 });
      return 'Claude CLI available';
    } catch (err) {
      throw new Error('Claude CLI not found or not working — install via: npm install -g @anthropic-ai/sdk');
    }
  }));

  // 5. PM2
  results.push(check('PM2', () => {
    try {
      execSync('pm2 --version', { stdio: 'ignore', timeout: 3000 });
      return 'PM2 installed globally';
    } catch (err) {
      throw new Error('PM2 not found — install via: npm install -g pm2');
    }
  }));

  // 6. Node modules (check for key dependencies)
  results.push(check('Dependencies', () => {
    const pkgPath = join(process.cwd(), 'node_modules');
    if (!existsSync(pkgPath)) throw new Error('node_modules not found — run: npm install');
    const required = ['better-sqlite3', 'pino', 'dotenv'];
    const missing = required.filter(m => !existsSync(join(pkgPath, m)));
    if (missing.length > 0) throw new Error(`Missing: ${missing.join(', ')}`);
    return 'All key packages present';
  }));

  // 7. Telegram Bot (if configured)
  if (process.env.TELEGRAM_BOT_TOKEN) {
    results.push(check('Telegram Bot', () => {
      if (!process.env.TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID not set');
      // We can't truly test without making an API call, so just verify env vars exist
      return 'Credentials configured (not tested)';
    }));
  } else {
    results.push({
      component: 'Telegram Bot',
      status: 'warn',
      message: 'TELEGRAM_BOT_TOKEN not set — alerts will be disabled',
    });
  }

  // 8. WhatsApp ready (client not started yet, just check auth dir)
  results.push(check('WhatsApp Auth', () => {
    const expected = ['Default', 'IndexedDB', 'session.wdb'];
    const authPath = join(config.authDir);
    // We can't check if QR has been scanned yet, just verify auth dir is writable
    accessSync(authPath, fsConstants.W_OK);
    return 'Auth directory ready (QR scan needed on first run)';
  }));

  // 9. Vestige MCP (check if configured)
  if (process.env.VESTIGE_MCP_PATH || process.env.MCP_SERVERS) {
    results.push(check('Vestige MCP', () => {
      // MCP will connect on first use, just verify config
      return 'MCP configured (will connect on first use)';
    }));
  } else {
    results.push({
      component: 'Vestige MCP',
      status: 'warn',
      message: 'MCP not configured — memory features disabled',
    });
  }

  return results;
}

export function formatHealthReport(results) {
  const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
  };

  const passFail = { pass: 0, fail: 0, warn: 0 };
  let report = '\n╔═══════════════════════════════════════╗\n';
  report += '║        Health Check Report            ║\n';
  report += '╚═══════════════════════════════════════╝\n\n';

  for (const r of results) {
    const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '⚠';
    const color = r.status === 'pass' ? colors.green : r.status === 'fail' ? colors.red : colors.yellow;
    report += `${color}${icon}${colors.reset} ${r.component}: ${r.message}\n`;
    passFail[r.status]++;
  }

  report += `\nSummary: ${colors.green}${passFail.pass} pass${colors.reset}, ${passFail.fail > 0 ? colors.red : colors.reset}${passFail.fail} fail${colors.reset}, ${passFail.warn > 0 ? colors.yellow : colors.reset}${passFail.warn} warn${colors.reset}\n\n`;

  if (passFail.fail > 0) {
    report += `${colors.red}❌ Setup incomplete — fix errors above${colors.reset}\n`;
  } else if (passFail.warn > 0) {
    report += `${colors.yellow}⚠️  Setup ready (some features disabled)${colors.reset}\n`;
  } else {
    report += `${colors.green}✅ All systems ready!${colors.reset}\n`;
  }

  return report;
}
