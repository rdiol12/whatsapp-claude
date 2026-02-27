import https from 'https';
import { createLogger } from './logger.js';

const log = createLogger('notify');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  log.warn('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — notifications disabled');
}

function sendTelegramMessage(text, parseMode) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: CHAT_ID, text: text.slice(0, 4000) };
  if (parseMode) payload.parse_mode = parseMode;
  const body = JSON.stringify(payload);

  const req = https.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        log.error({ statusCode: res.statusCode, body: data.slice(0, 300) }, 'Telegram API error');
        // On 400 (bad Markdown), retry as plain text if we were using parse_mode
        if (res.statusCode === 400 && parseMode) {
          log.warn('Retrying Telegram message without parse_mode (Markdown parse error)');
          sendTelegramMessage(text, null);
        }
      } else {
        log.debug('Telegram alert sent');
      }
    });
  });

  req.on('error', (err) => {
    log.error({ err: err.message }, 'Failed to send Telegram alert');
  });

  req.write(body);
  req.end();
}

export function notify(message) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  sendTelegramMessage(message, 'Markdown');
  // Also push to WA alerts group (lazy import to avoid circular dep with whatsapp.js)
  import('./whatsapp.js').then(wa => wa.sendToGroup('alerts', message)).catch(() => {});
}

export function alertCrash(module, error) {
  const msg = error instanceof Error ? error.message : String(error);
  notify(`*CRASH: ${module}*\n${msg.slice(0, 300)}`);
}
