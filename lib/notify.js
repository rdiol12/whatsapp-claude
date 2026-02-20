import https from 'https';
import { createLogger } from './logger.js';

const log = createLogger('notify');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  log.warn('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — notifications disabled');
}

export function notify(message) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
  });

  const req = https.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    res.resume(); // Drain response to free connection pool
    if (res.statusCode !== 200) {
      log.error({ statusCode: res.statusCode }, 'Telegram API error');
    } else {
      log.debug('Telegram alert sent');
    }
  });

  req.on('error', (err) => {
    log.error({ err: err.message, stack: err.stack }, 'Failed to send Telegram alert');
  });

  req.write(body);
  req.end();
}
