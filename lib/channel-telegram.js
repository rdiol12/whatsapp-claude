/**
 * lib/channel-telegram.js — Telegram channel adapter.
 *
 * Implements the same lightweight channel adapter interface as channel-wa.js,
 * for Telegram as an in-process channel.
 *
 * Instead of a WebSocket (which is wrong for in-process channels),
 * this adapter uses a simple EventEmitter + function injection pattern,
 * exactly mirroring channel-wa.js.
 *
 * Interface:
 *   channelId          — 'telegram'
 *   setSendFn(fn)      — Register the underlying send function (called from telegram.js on poll start)
 *   setDisconnected()  — Called when Telegram polling stops
 *   send(text)         — Send a text message via Telegram
 *   onMessage(fn)      — Subscribe to incoming Telegram messages from the user
 *   emitMessage(data)  — Called by telegram.js when a message arrives from the user
 *   getStatus()        — Returns connection status
 *   getStats()         — Returns message counters
 *   onConnect(fn)      — One-shot 'connected' listener
 *
 * Wiring:
 *   telegram.js → setSendFn(sendTelegram) when polling starts
 *   telegram.js → emitMessage(data) when the user sends a non-command message
 *   telegram.js → setDisconnected() when polling stops
 *   index.js    → imports getStatus for health checks / botApi
 *
 * Part of ms_4 — ws-gateway: WhatsApp as a channel adapter (multi-channel support).
 */

import { EventEmitter } from 'events';
import { createLogger } from './logger.js';

const log = createLogger('channel-telegram');

export const channelId = 'telegram';

const emitter = new EventEmitter();
emitter.setMaxListeners(20); // Support multiple subscribers

let _sendFn = null;
let _connected = false;
let _stats = { sent: 0, received: 0, errors: 0, connectedAt: null };

// ─── Adapter registration (called by telegram.js) ────────────────────────────

/**
 * Register the underlying Telegram send function.
 * Called from telegram.js when polling starts and credentials are confirmed.
 *
 * @param {Function} fn  Async function (text: string) => void
 */
export function setSendFn(fn) {
  _sendFn = fn;
  _connected = true;
  _stats.connectedAt = Date.now();
  log.info('Telegram channel adapter: send function registered — channel ready');
  emitter.emit('connect', { channelId, ts: Date.now() });
}

/**
 * Called when Telegram polling stops.
 */
export function setDisconnected() {
  _sendFn = null;
  _connected = false;
  log.info('Telegram channel adapter: disconnected');
  emitter.emit('disconnect', { channelId, ts: Date.now() });
}

// ─── Outgoing ────────────────────────────────────────────────────────────────

/**
 * Send a text message via Telegram.
 * Returns true on success, false if not connected or error.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function send(text) {
  if (!_sendFn) {
    log.warn({ textLen: text?.length }, 'channel-telegram: send called but not connected — message dropped');
    _stats.errors++;
    return false;
  }
  try {
    await _sendFn(text);
    _stats.sent++;
    return true;
  } catch (err) {
    log.error({ err: err.message }, 'channel-telegram: send failed');
    _stats.errors++;
    return false;
  }
}

// ─── Incoming ────────────────────────────────────────────────────────────────

/**
 * Called by telegram.js when the user sends a message.
 * Emits 'message' event to all registered listeners.
 *
 * @param {{ from: string, body: string, ts: number, type: string, [key: string]: any }} data
 */
export function emitMessage(data) {
  _stats.received++;
  emitter.emit('message', { channelId, ...data });
}

/**
 * Register a handler for incoming Telegram messages.
 *
 * @param {Function} fn  ({ channelId, from, body, ts, type, ... }) => void
 */
export function onMessage(fn) {
  emitter.on('message', fn);
}

/**
 * Remove a message handler.
 */
export function offMessage(fn) {
  emitter.off('message', fn);
}

// ─── Status & Stats ──────────────────────────────────────────────────────────

/**
 * Get connection status for health checks / dashboard.
 *
 * @returns {{ channelId: string, connected: boolean, connectedAt: number|null }}
 */
export function getStatus() {
  return {
    channelId: 'telegram',
    connected: _connected,
    connectedAt: _stats.connectedAt,
    hasSendFn: !!_sendFn,
  };
}

/**
 * Get message counters.
 */
export function getStats() {
  return { ..._stats };
}

/**
 * Register a one-time 'connect' listener (fires when Telegram polling becomes ready).
 */
export function onConnect(fn) {
  if (_connected) {
    // Already connected — call immediately
    fn({ channelId, ts: _stats.connectedAt });
  } else {
    emitter.once('connect', fn);
  }
}
