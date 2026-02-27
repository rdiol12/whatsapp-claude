/**
 * Channel Router — unified outbound message dispatcher.
 *
 * Routes bot replies through the appropriate channel adapter.
 * Priority order:
 *   1. WS gateway (external adapters: web UI, mobile app, etc.)
 *   2. In-process WhatsApp adapter (channel-wa)
 *   3. Fallback function (e.g. Telegram notify)
 *
 * ms_3: Unified outbound routing — all agent replies go through routeSend().
 *
 * Usage:
 *   import { routeSend } from './channel-router.js';
 *   await routeSend('whatsapp', jid, 'Hello!', fallbackFn);
 */

import { send as waSend, getStatus as getWaStatus } from './channel-wa.js';
import { sendToChannel, emitToChannel, hasChannels } from './ws-gateway.js';
import { createLogger } from './logger.js';

const log = createLogger('channel-router');

/**
 * Route an outbound message to the best available channel adapter.
 *
 * @param {string}    channel      - Target channel ('whatsapp' | 'telegram' | ...)
 * @param {string}    to           - Recipient identifier (JID, chat ID, etc.)
 * @param {string}    text         - Message body
 * @param {function}  [fallbackFn] - Optional async fallback (called if primary fails)
 * @returns {Promise<boolean>}     True if message was delivered, false otherwise
 */
export async function routeSend(channel, to, text, fallbackFn = null) {
  // 1. WS gateway — for external adapters (web UI, mobile clients, etc.)
  if (hasChannels()) {
    const sent = sendToChannel(channel, to, text);
    if (sent) {
      log.debug({ channel, to, textLen: text.length }, 'channel-router: sent via WS gateway');
      return true;
    }
    log.debug({ channel }, 'channel-router: WS gateway has channels but send failed — trying in-process');
  }

  // 2. In-process WhatsApp adapter
  if (channel === 'whatsapp') {
    const status = getWaStatus();
    if (status.connected) {
      const ok = await waSend(text);
      if (ok) {
        log.info({ textLen: text.length }, 'channel-router: sent via channel-wa (in-process)');
        return true;
      }
      log.warn({ textLen: text.length }, 'channel-router: channel-wa send returned false — trying fallback');
    } else {
      log.warn({ connected: status.connected }, 'channel-router: channel-wa not connected — trying fallback');
    }
  }

  // 3. Fallback (Telegram notify, test harness, etc.)
  if (fallbackFn) {
    try {
      await fallbackFn(text);
      log.info({ channel, textLen: text.length }, 'channel-router: sent via fallback function');
      return true;
    } catch (err) {
      log.error({ err: err.message, channel }, 'channel-router: fallback send failed');
    }
  }

  log.warn({ channel, to }, 'channel-router: no adapter available — message dropped');
  return false;
}

/**
 * Route a typing indicator to a channel adapter (WS gateway only).
 *
 * @param {string} channel  - Target channel name
 * @param {string} to       - Recipient identifier
 * @returns {boolean}       True if indicator was sent
 */
export function routeTyping(channel, to) {
  if (!hasChannels()) return false;
  return emitToChannel(channel, 'typing', { to });
}
