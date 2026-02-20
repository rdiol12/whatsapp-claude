/**
 * Telegram receive — long-polling for slash commands.
 * Ron can control the bot from Telegram when WhatsApp is unavailable.
 *
 * Supported commands: /status, /crons, /run <name>, /help
 * Only responds to messages from TELEGRAM_CHAT_ID.
 */

import https from 'https';
import { createLogger } from './logger.js';
import { listCrons, getCronSummary, runCronNow } from './crons.js';
import { isConnected as isMcpConnected } from './mcp-gateway.js';
import { getHealthSnapshot } from './metrics.js';
import { formatCostReport } from './cost-analytics.js';
import config from './config.js';

const log = createLogger('telegram');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let polling = false;
let offset = 0;
let queueStatsFn = null;

function telegramApi(method, body) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
    const bodyStr = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ ok: false, raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(35000, () => { req.destroy(); reject(new Error('Telegram API timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

async function sendTelegram(text) {
  await telegramApi('sendMessage', {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'Markdown',
  });
}

async function handleCommand(text) {
  const cmd = text.trim().toLowerCase();

  if (cmd === '/status') {
    const h = getHealthSnapshot();
    const qStats = queueStatsFn?.() || { running: '?', waiting: '?' };
    const mcp = isMcpConnected() ? 'connected' : 'disconnected';
    const t = h.tier_breakdown;
    await sendTelegram(
      `*Bot Status*\nUptime: ${h.uptime}\nMemory: ${h.memory_mb}MB\nModel: ${config.claudeModel}\nQueue: ${qStats.running} running, ${qStats.waiting} waiting\nVestige: ${mcp}\nCrons: ${listCrons().length} jobs\n\nMsgs: ${h.messages_in}→${h.messages_out} | Errors: ${h.errors}\nAvg latency: ${h.avg_latency_ms}ms\nCost: $${h.cost_usd_session}\nTiers: T0:${t.t0} T1:${t.t1} T2:${t.t2} T3:${t.t3}`
    );
    return;
  }

  if (cmd === '/cost' || cmd.startsWith('/cost ')) {
    const period = cmd.split(' ')[1] || 'today';
    await sendTelegram(formatCostReport(period));
    return;
  }

  if (cmd === '/crons') {
    const summary = getCronSummary();
    await sendTelegram(`*Cron Jobs:*\n${summary || 'No crons configured.'}`);
    return;
  }

  if (cmd.startsWith('/run ')) {
    const name = cmd.slice(5).trim();
    if (!name) {
      await sendTelegram('Usage: /run <cron-name>');
      return;
    }
    const result = runCronNow(name);
    await sendTelegram(result ? `Running cron *${name}*...` : `Cron "${name}" not found.`);
    return;
  }

  if (cmd === '/help') {
    await sendTelegram(
      '*Telegram Commands:*\n/status — bot status + metrics\n/crons — list cron jobs\n/run <name> — execute a cron now\n/cost [today|week|month] — cost report\n/help — this message'
    );
    return;
  }

  // Unknown command — ignore silently
}

async function pollLoop() {
  while (polling) {
    try {
      const result = await telegramApi('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message'],
      });

      if (result.ok && result.result) {
        for (const update of result.result) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text) continue;
          if (String(msg.chat?.id) !== CHAT_ID) continue;

          log.info({ text: msg.text.slice(0, 50) }, 'Telegram command received');
          try {
            await handleCommand(msg.text);
          } catch (err) {
            log.error({ err: err.message }, 'Failed to handle Telegram command');
          }
        }
      }
    } catch (err) {
      // Network errors are expected during long-polling
      if (!err.message.includes('timeout')) {
        log.debug({ err: err.message }, 'Telegram poll error');
      }
      // Back off on error
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

export function startTelegramPolling({ queueStats } = {}) {
  if (!BOT_TOKEN || !CHAT_ID) {
    log.warn('Telegram credentials not set — receive disabled');
    return;
  }
  queueStatsFn = queueStats;
  polling = true;
  pollLoop(); // fire-and-forget
  log.info('Telegram polling started');
}

export function stopTelegramPolling() {
  polling = false;
}
