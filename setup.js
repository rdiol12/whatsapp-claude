#!/usr/bin/env node
/**
 * Sela Setup Wizard
 *
 * Interactive guided setup for first-time installation.
 * Prompts for essential config, validates, and starts the bot.
 */

import readline from 'readline';
import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Color output ────────────────────────────────────────────────────────────

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
};

const log = {
  header: (msg) => console.log(`\n${colors.blue}${colors.bright}▶ ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}✓ ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}✗ ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}⚠ ${msg}${colors.reset}`),
  info: (msg) => console.log(`  ${msg}`),
};

// ─── Readline interface ───────────────────────────────────────────────────────

function ask(question, defaultVal = '') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const displayQ = defaultVal ? `${question} (${defaultVal}): ` : `${question}: `;
    rl.question(displayQ, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

function askChoice(question, choices) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(`\n${question}`);
    choices.forEach((c, i) => {
      console.log(`  ${i + 1}) ${c}`);
    });

    rl.question('Enter choice (1-' + choices.length + '): ', (answer) => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      resolve(choices[Math.max(0, Math.min(idx, choices.length - 1))]);
    });
  });
}

// ─── Setup flow ──────────────────────────────────────────────────────────────

async function setup() {
  console.clear();
  console.log(`\n${colors.bright}${colors.blue}╔═══════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}${colors.blue}║   Sela Setup Wizard v2.0      ║${colors.reset}`);
  console.log(`${colors.bright}${colors.blue}╚═══════════════════════════════╝${colors.reset}\n`);

  const cfg = {};

  // Step 1: WhatsApp Phone
  log.header('Step 1: WhatsApp Phone Number');
  log.info('Your WhatsApp account phone (e.g., 972501234567)');
  cfg.phone = await ask('Phone number');
  if (!cfg.phone.match(/^\d{10,15}$/)) {
    log.error('Invalid phone number. Please use digits only.');
    process.exit(1);
  }
  log.success(`WhatsApp phone set to ${cfg.phone}`);

  // Step 2: Claude API
  log.header('Step 2: Claude API Credentials');
  log.info('Option A: Use Claude API key (fastest)');
  log.info('Option B: Use Claude CLI OAuth (recommended for production)');
  const authMethod = await askChoice('Choose authentication method', ['API Key', 'Claude CLI OAuth']);

  if (authMethod === 'API Key') {
    cfg.claudeApiKey = await ask('Claude API key');
    if (!cfg.claudeApiKey.startsWith('sk-')) {
      log.warn('API key should start with sk-');
    }
    log.success('Claude API key configured');
  } else {
    log.info('Claude CLI OAuth will be configured automatically on first run.');
    log.info('You\'ll see a QR code to scan with your Anthropic account.');
    cfg.claudeOAuth = true;
  }

  // Step 3: Timezone
  log.header('Step 3: Timezone');
  log.info('All dates, quiet hours, and cron schedules use this timezone.');
  const tzChoice = await askChoice('Choose your timezone', [
    'UTC',
    'US/Eastern (America/New_York)',
    'US/Pacific (America/Los_Angeles)',
    'Europe/London',
    'Asia/Jerusalem',
    'Asia/Tokyo',
    'Custom (enter manually)',
  ]);
  const tzMap = {
    'UTC': 'UTC',
    'US/Eastern (America/New_York)': 'America/New_York',
    'US/Pacific (America/Los_Angeles)': 'America/Los_Angeles',
    'Europe/London': 'Europe/London',
    'Asia/Jerusalem': 'Asia/Jerusalem',
    'Asia/Tokyo': 'Asia/Tokyo',
  };
  if (tzChoice === 'Custom (enter manually)') {
    cfg.timezone = await ask('IANA timezone (e.g., Europe/Berlin)', 'UTC');
  } else {
    cfg.timezone = tzMap[tzChoice];
  }
  log.success(`Timezone set to ${cfg.timezone}`);

  // Step 4: Telegram (optional)
  log.header('Step 4: Telegram Bot Alerts (Optional)');
  const setupTelegram = await askChoice('Enable Telegram alerts?', ['Yes', 'No']);

  if (setupTelegram === 'Yes') {
    log.info('Go to https://t.me/BotFather');
    log.info('Send: /newbot');
    log.info('Follow prompts, get your token');
    cfg.telegramToken = await ask('Telegram bot token');
    cfg.telegramChatId = await ask('Telegram chat ID (get via /start to your bot, check logs)');
    log.success('Telegram configured');
  }

  // Step 5: Model choice
  log.header('Step 5: Claude Model');
  const model = await askChoice('Choose default model', ['Haiku (cheapest)', 'Sonnet (balanced)', 'Opus (most capable)']);
  const modelMap = { 'Haiku (cheapest)': 'haiku', 'Sonnet (balanced)': 'sonnet', 'Opus (most capable)': 'opus' };
  cfg.model = modelMap[model];
  log.success(`Model set to ${cfg.model}`);

  // Step 6: Persistent mode
  log.header('Step 6: Persistent Mode');
  log.info('Keep one Claude CLI process alive between messages (faster, uses cached tokens).');
  const persistChoice = await askChoice('Enable persistent mode? (recommended)', ['Yes', 'No']);
  cfg.persistentMode = persistChoice === 'Yes';
  log.success(`Persistent mode: ${cfg.persistentMode ? 'enabled' : 'disabled'}`);

  // Step 7: Quiet hours
  log.header('Step 7: Quiet Hours');
  log.info('When should the bot NOT send unsolicited WhatsApp messages?');
  cfg.quietStart = parseInt(await ask('Start hour (0-23)', '23'), 10);
  cfg.quietEnd = parseInt(await ask('End hour (0-23)', '8'), 10);
  log.success(`Quiet hours: ${cfg.quietStart}:00 - ${cfg.quietEnd}:00 (${cfg.timezone})`);

  // Step 8: Daily budget
  log.header('Step 8: Daily Cost Budget');
  cfg.dailyBudget = parseFloat(await ask('Daily budget (USD)', '2'));
  log.success(`Daily budget: $${cfg.dailyBudget}`);

  // Step 9: Bot personality (SOUL.md)
  log.header('Step 9: Bot Personality');
  const templatePath = path.join(__dirname, 'SOUL.md.template');
  const soulPath = path.join(__dirname, 'SOUL.md');
  if (fs.existsSync(soulPath)) {
    log.info('SOUL.md already exists — keeping your existing personality.');
  } else if (fs.existsSync(templatePath)) {
    cfg.botName = await ask('Bot name', 'Claude');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const soul = template.replace(/\{\{name\}\}/g, cfg.botName);
    fs.writeFileSync(soulPath, soul, 'utf-8');
    log.success(`SOUL.md created with bot name: ${cfg.botName}`);
  } else {
    log.warn('No SOUL.md.template found — create SOUL.md manually to define bot personality.');
  }

  // Step 9b: MEMORY.md
  const memPath = path.join(__dirname, 'MEMORY.md');
  if (!fs.existsSync(memPath)) {
    const memTemplatePath = path.join(__dirname, 'MEMORY.md.template');
    if (fs.existsSync(memTemplatePath)) {
      fs.copyFileSync(memTemplatePath, memPath);
      log.success('MEMORY.md created from template');
    } else {
      fs.writeFileSync(memPath, '# Bot Memory\n\nThis file stores persistent notes for the bot.\n', 'utf-8');
      log.success('MEMORY.md created');
    }
  }

  // Step 10: Create directories
  log.header('Step 10: Creating Directories');
  const dirs = [
    path.join(__dirname, 'data'),
    path.join(__dirname, 'auth'),
    path.join(__dirname, 'logs'),
    path.join(__dirname, 'workspace'),
  ];

  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log.success(`Created ${dir}`);
      }
    } catch (err) {
      log.error(`Failed to create ${dir}: ${err.message}`);
      process.exit(1);
    }
  }

  // Step 11: Write .env
  log.header('Step 11: Writing Configuration');
  const envPath = path.join(__dirname, '.env');
  const envContent = generateEnv(cfg);

  try {
    fs.writeFileSync(envPath, envContent, 'utf-8');
    log.success(`.env written to ${envPath}`);
  } catch (err) {
    log.error(`Failed to write .env: ${err.message}`);
    process.exit(1);
  }

  // Step 12: Install dependencies
  log.header('Step 12: Installing Dependencies');
  const installDeps = await askChoice('Install npm dependencies?', ['Yes', 'No (skip)']);

  if (installDeps === 'Yes') {
    try {
      log.info('Running npm install...');
      execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
      log.success('Dependencies installed');
    } catch (err) {
      log.error(`npm install failed: ${err.message}`);
      log.warn('You may need to run: npm install manually');
    }
  }

  // Step 13: Setup PM2 (if available)
  log.header('Step 13: PM2 Setup');
  try {
    execSync('pm2 --version', { stdio: 'ignore' });
    log.info('PM2 is already installed');
  } catch {
    log.info('PM2 not found. Installing globally...');
    try {
      execSync('npm install -g pm2', { stdio: 'inherit' });
      log.success('PM2 installed');
    } catch (err) {
      log.warn(`PM2 installation failed. You can install manually: npm install -g pm2`);
    }
  }

  const startBot = await askChoice('Start Sela with PM2?', ['Yes', 'No (manual start later)']);

  if (startBot === 'Yes') {
    try {
      log.info('Starting Sela...');
      execSync('pm2 start ecosystem.config.cjs', { cwd: __dirname, stdio: 'inherit' });
      log.success('Sela started! View logs: pm2 logs sela');
    } catch (err) {
      log.error(`Failed to start with PM2: ${err.message}`);
      log.info('Try manual start: npm start');
    }
  } else {
    log.info('To start manually: npm start');
  }

  // Step 14: Health check
  log.header('Step 14: Health Check');
  log.info('Validating system components...');

  let healthResults = [];
  try {
    const { runHealthCheck, formatHealthReport } = await import('./lib/health-check.js');
    healthResults = await runHealthCheck();
    if (healthResults.length > 0) {
      console.log(formatHealthReport(healthResults));
    }
  } catch (err) {
    log.warn(`Health check error: ${err.message}`);
  }

  // Final summary
  console.log(`\n${colors.green}${colors.bright}╔═══════════════════════════════╗${colors.reset}`);
  console.log(`${colors.green}${colors.bright}║   Setup Complete!              ║${colors.reset}`);
  console.log(`${colors.green}${colors.bright}╚═══════════════════════════════╝${colors.reset}\n`);

  log.info(`Configuration saved to: ${envPath}`);
  log.info(`Timezone: ${cfg.timezone}`);
  log.info(`Dashboard: http://localhost:4242 (start bot first)`);
  log.info(`Logs: ${path.join(__dirname, 'logs')}`);

  console.log(`\n${colors.bright}Next steps:${colors.reset}`);
  console.log(`  1. Start the bot: pm2 start ecosystem.config.cjs`);
  console.log(`  2. Monitor startup: pm2 logs sela`);
  console.log(`  3. Scan WhatsApp QR code when prompted`);
  console.log(`  4. Open dashboard: http://localhost:4242`);
  console.log(`  5. Send a message to the bot WhatsApp number\n`);
}

// ─── ENV file generator ─────────────────────────────────────────────────────

function generateEnv(cfg) {
  const lines = [
    '# Sela Configuration',
    '# Generated by setup.js',
    '',
    '# --- Core ---',
    `ALLOWED_PHONE=${cfg.phone}`,
    `CLAUDE_MODEL=${cfg.model}`,
    'MAX_HISTORY=20',
    '',
    '# --- Timezone (IANA format) ---',
    `TIMEZONE=${cfg.timezone}`,
    '',
    '# --- Persistent Mode ---',
    `PERSISTENT_MODE=${cfg.persistentMode}`,
    '',
    '# --- Quiet Hours (24h format, in configured timezone) ---',
    `QUIET_START=${cfg.quietStart}`,
    `QUIET_END=${cfg.quietEnd}`,
    '',
    '# --- Costs ---',
    `DAILY_COST_LIMIT=${cfg.dailyBudget}`,
    '',
    '# --- Claude API ---',
  ];

  if (cfg.claudeApiKey) {
    lines.push(`CLAUDE_API_KEY=${cfg.claudeApiKey}`);
  } else {
    lines.push('# Using Claude CLI OAuth (first run will prompt for QR scan)');
    lines.push(`CLAUDE_CREDENTIALS_PATH=${path.join(homedir(), '.claude', '.credentials.json')}`);
  }

  lines.push('');
  lines.push('# --- Telegram Alerts (optional) ---');
  if (cfg.telegramToken) {
    lines.push(`TELEGRAM_BOT_TOKEN=${cfg.telegramToken}`);
    lines.push(`TELEGRAM_CHAT_ID=${cfg.telegramChatId}`);
  } else {
    lines.push('# TELEGRAM_BOT_TOKEN=your_token_here');
    lines.push('# TELEGRAM_CHAT_ID=your_chat_id_here');
  }

  lines.push('');
  lines.push('# --- Logging ---');
  lines.push('LOG_LEVEL=info');
  lines.push('LOG_RETENTION_DAYS=7');

  return lines.join('\n') + '\n';
}

// ─── Main ────────────────────────────────────────────────────────────────────

setup().catch(err => {
  log.error(`Setup failed: ${err.message}`);
  process.exit(1);
});
