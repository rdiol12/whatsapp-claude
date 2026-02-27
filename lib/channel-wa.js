/**
 * lib/channel-wa.js — WhatsApp channel adapter.
 *
 * Implements a lightweight channel adapter interface for WhatsApp,
 * consistent with the ws-gateway multi-channel architecture (ms_1/ms_2).
 *
 * Instead of a WebSocket (which is wrong for in-process channels),
 * this adapter uses a simple EventEmitter + function injection pattern.
 *
 * Interface:
 *   channelId          — 'whatsapp'
 *   setSendFn(fn)      — Register the underlying send function (called from whatsapp.js on connect)
 *   send(text)         — Send a text message via WhatsApp
 *   onMessage(fn)      — Subscribe to incoming WhatsApp messages
 *   emitMessage(data)  — Called by whatsapp.js when a message arrives from the user
 *   getStatus()        — Returns connection status
 *   getStats()         — Returns message counters
 *
 * Wiring:
 *   whatsapp.js → setSendFn(sendWhatsAppMessage) when socket connects
 *   whatsapp.js → emitMessage(data) when the user sends a message
 *   index.js    → imports getStatus for health checks / botApi
 *   agent-loop.js or other modules → can call send() via this adapter
 */

import { EventEmitter } from 'events';
import { createLogger } from './logger.js';

const log = createLogger('channel-wa');

export const channelId = 'whatsapp';

const emitter = new EventEmitter();
emitter.setMaxListeners(20); // Support multiple subscribers

let _sendFn = null;
let _connected = false;
let _stats = { sent: 0, received: 0, errors: 0, connectedAt: null };

// ─── Adapter registration (called by whatsapp.js) ────────────────────────────

/**
 * Register the underlying WhatsApp send function.
 * Called from whatsapp.js when the Baileys socket connects and is ready.
 *
 * @param {Function} fn  Async function (text: string) => void
 */
export function setSendFn(fn) {
  _sendFn = fn;
  _connected = true;
  _stats.connectedAt = Date.now();
  log.info('WhatsApp channel adapter: send function registered — channel ready');
  emitter.emit('connect', { channelId, ts: Date.now() });
}

/**
 * Called when WhatsApp socket disconnects.
 */
export function setDisconnected() {
  _sendFn = null;
  _connected = false;
  log.info('WhatsApp channel adapter: disconnected');
  emitter.emit('disconnect', { channelId, ts: Date.now() });
}

// ─── Outgoing ────────────────────────────────────────────────────────────────

/**
 * Send a text message via WhatsApp.
 * Returns true on success, false if not connected or error.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function send(text) {
  if (!_sendFn) {
    log.warn({ textLen: text?.length }, 'channel-wa: send called but not connected — message dropped');
    _stats.errors++;
    return false;
  }
  try {
    await _sendFn(text);
    _stats.sent++;
    return true;
  } catch (err) {
    log.error({ err: err.message }, 'channel-wa: send failed');
    _stats.errors++;
    return false;
  }
}

// ─── Incoming ────────────────────────────────────────────────────────────────

/**
 * Called by whatsapp.js when the user sends a message.
 * Emits 'message' event to all registered listeners.
 *
 * @param {{ from: string, body: string, ts: number, type: string, [key: string]: any }} data
 */
export function emitMessage(data) {
  _stats.received++;
  emitter.emit('message', { channelId, ...data });
}

/**
 * Register a handler for incoming WhatsApp messages.
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
    channelId: 'whatsapp',
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
 * Register a one-time 'connect' listener (fires when WA socket becomes ready).
 */
export function onConnect(fn) {
  if (_connected) {
    // Already connected — call immediately
    fn({ channelId, ts: _stats.connectedAt });
  } else {
    emitter.once('connect', fn);
  }
}
