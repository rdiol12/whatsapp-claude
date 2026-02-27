/**
 * WebSocket Gateway — multi-channel message routing protocol.
 *
 * ─── ms_1 Protocol Design ───────────────────────────────────────────────────
 *
 * Architecture:
 *   Each messaging channel (WhatsApp, Telegram, Web) connects as a WS adapter.
 *   Messages flow:  channel → ws-gateway → agent queue → ws-gateway → channel
 *   Decouples channel specifics from agent brain. Enables multi-channel support
 *   and easier testing by swapping adapters without touching the brain.
 *
 * Message Schema (all messages share this envelope):
 *   {
 *     type:        string,   // Event type (see below)
 *     id:          string?,  // Optional message ID for ack tracking
 *     channel:     string,   // Channel identifier: 'whatsapp' | 'telegram' | 'web'
 *     from?:       string,   // Sender ID (JID, chat ID, user ID)
 *     to?:         string,   // Recipient ID
 *     body?:       string,   // Message text
 *     ts:          number,   // Unix timestamp (ms)
 *     attachments?: Array<{ type, url, mime, size? }>
 *     metadata?:   object,   // Channel-specific extras (platform message ID, etc.)
 *   }
 *
 * Auth Handshake:
 *   1. Channel connects to gateway
 *   2. Channel sends: { type: 'auth', channel, token }
 *   3. Gateway replies: { type: 'auth_ok', channel }  OR  { type: 'auth_error', reason }
 *
 * Event Types:
 *   Inbound  (adapter → gateway):  'auth', 'message_in', 'status', 'typing', 'ack'
 *   Outbound (gateway → adapter):  'auth_ok', 'auth_error', 'message_out', 'typing', 'error'
 *
 * Port: WS_GATEWAY_PORT env var (default 18789).
 * Token: WS_GATEWAY_TOKEN env var (auto-generated on first start if not set).
 *
 * ─── ms_2 Implementation ────────────────────────────────────────────────────
 */

import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';
import config from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('ws-gateway');

/** Shared token all channel adapters must present during auth handshake */
const GATEWAY_TOKEN = process.env.WS_GATEWAY_TOKEN || randomBytes(24).toString('hex');

/**
 * Channel registry: channelName → { ws, lastSeen, stats }
 * Only one WS connection per channel (latest replaces previous).
 * @type {Map<string, { ws: import('ws'), lastSeen: number, stats: { in: number, out: number } }>}
 */
const channels = new Map();

let wss = null;

/** Callback invoked for each inbound message: (channelName, from, body, rawMsg) => void */
let onMessageCallback = null;

// ─── Server Lifecycle ───────────────────────────────────────────────────────

/**
 * Start the WebSocket gateway server.
 * Binds to localhost only — not accessible from outside the machine.
 *
 * @param {object} opts
 * @param {number} [opts.port]       Port to listen on (default: config.wsGatewayPort)
 * @param {function} [opts.onMessage] Called with (channel, from, body, rawMsg) on message_in
 * @returns {import('ws').WebSocketServer}
 */
export function startGateway({ port, onMessage, _retryCount = 0 } = {}) {
  if (wss) {
    log.warn('startGateway called but server already running — ignoring');
    return wss;
  }

  const listenPort = port ?? config.wsGatewayPort;
  onMessageCallback = onMessage ?? null;

  wss = new WebSocketServer({ port: listenPort, host: '127.0.0.1' });

  wss.on('connection', (ws) => {
    let channelName = null;
    let authenticated = false;

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        ws.send(JSON.stringify({ type: 'error', reason: 'Invalid JSON', ts: Date.now() }));
        return;
      }

      // ── Auth handshake ──────────────────────────────────────────────────
      if (msg.type === 'auth') {
        if (msg.token !== GATEWAY_TOKEN) {
          ws.send(JSON.stringify({ type: 'auth_error', reason: 'Invalid token', ts: Date.now() }));
          ws.close(4001, 'Unauthorized');
          return;
        }
        if (!msg.channel || typeof msg.channel !== 'string') {
          ws.send(JSON.stringify({ type: 'auth_error', reason: 'Missing channel name', ts: Date.now() }));
          ws.close(4002, 'Bad request');
          return;
        }

        // If channel already connected, close old connection gracefully
        const existing = channels.get(msg.channel);
        if (existing?.ws?.readyState === 1 /* OPEN */) {
          log.warn({ channel: msg.channel }, 'Replacing existing channel connection');
          existing.ws.close(4003, 'Replaced by newer connection');
        }

        channelName = msg.channel;
        authenticated = true;
        channels.set(channelName, {
          ws,
          lastSeen: Date.now(),
          stats: { in: 0, out: 0 },
        });

        ws.send(JSON.stringify({ type: 'auth_ok', channel: channelName, ts: Date.now() }));
        log.info({ channel: channelName, total: channels.size }, 'Channel adapter authenticated');
        return;
      }

      if (!authenticated) {
        ws.send(JSON.stringify({ type: 'error', reason: 'Not authenticated — send auth first', ts: Date.now() }));
        return;
      }

      // ── Authenticated messages ──────────────────────────────────────────
      const ch = channels.get(channelName);
      if (ch) {
        ch.lastSeen = Date.now();
        ch.stats.in++;
      }

      if (msg.type === 'message_in') {
        // Validate required fields
        if (!msg.from || !msg.body) {
          ws.send(JSON.stringify({ type: 'error', reason: 'message_in requires: from, body', id: msg.id, ts: Date.now() }));
          return;
        }
        // Send ack back to adapter
        if (msg.id) {
          ws.send(JSON.stringify({ type: 'ack', id: msg.id, ts: Date.now() }));
        }
        // Route to agent
        if (onMessageCallback) {
          try {
            onMessageCallback(channelName, msg.from, msg.body, msg);
          } catch (err) {
            log.error({ err: err.message, channel: channelName }, 'onMessage callback threw');
          }
        }
      } else if (msg.type === 'status') {
        log.info({ channel: channelName, connected: msg.connected }, 'Channel status update');
      } else if (msg.type === 'typing') {
        // Forward typing indicator to same channel (echo to other adapters if multi-client)
        log.debug({ channel: channelName, to: msg.to }, 'Typing indicator received');
      } else if (msg.type === 'ack') {
        log.debug({ channel: channelName, id: msg.id }, 'Message ack received');
      } else {
        log.warn({ channel: channelName, type: msg.type }, 'Unknown gateway message type');
      }
    });

    ws.on('close', (code, reason) => {
      if (channelName) {
        channels.delete(channelName);
        log.info({ channel: channelName, code, remaining: channels.size }, 'Channel adapter disconnected');
      }
    });

    ws.on('error', (err) => {
      log.warn({ err: err.message, channel: channelName ?? '(unauthenticated)' }, 'Channel WS error');
    });
  });

  wss.on('listening', () => {
    const addr = wss.address();
    log.info({
      port: addr?.port ?? listenPort,
      token: GATEWAY_TOKEN.slice(0, 8) + '...',
    }, 'WS gateway listening — channel adapters can connect');
  });

  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Expected on restart: previous process may still hold the port for a few seconds.
      // Log at info level (not error/warn) to avoid false error_spike signals.
      if (_retryCount === 0) {
        log.info({ port: listenPort }, 'WS gateway EADDRINUSE — port held by previous process, retrying every 4s...');
      } else {
        log.info({ port: listenPort, attempt: _retryCount + 1 }, 'Port still in use — waiting...');
      }
      if (_retryCount >= 30) {
        // Give up after ~2 minutes — THIS is a real error worth alerting on
        log.error({ port: listenPort }, 'WS gateway EADDRINUSE: giving up after 30 retries (~2 minutes). Manual intervention required.');
        return;
      }
      wss = null;
      setTimeout(() => startGateway({ port: listenPort, onMessage: onMessageCallback, _retryCount: _retryCount + 1 }), 4000);
    } else {
      log.error({ err: err.message }, 'WS gateway server error');
    }
  });

  return wss;
}

/**
 * Stop the gateway and disconnect all channel adapters.
 */
export function stopGateway() {
  if (!wss) return;
  for (const [name, ch] of channels) {
    try { ch.ws.close(1001, 'Gateway shutting down'); } catch {}
    log.info({ channel: name }, 'Closed channel on gateway shutdown');
  }
  channels.clear();
  wss.close();
  wss = null;
  log.info('WS gateway stopped');
}

// ─── Outbound API ────────────────────────────────────────────────────────────

/**
 * Send a message_out to a channel adapter (e.g., to deliver a bot reply).
 *
 * @param {string} channel  Target channel name ('whatsapp', 'telegram', etc.)
 * @param {string} to       Recipient identifier within that channel (JID, chat ID)
 * @param {string} body     Message text
 * @param {object} [opts]   Optional fields: replyTo, attachments, metadata
 * @returns {boolean}       True if message was sent, false if channel not connected
 */
export function sendToChannel(channel, to, body, opts = {}) {
  const ch = channels.get(channel);
  if (!ch || ch.ws.readyState !== 1 /* OPEN */) {
    log.warn({ channel }, 'sendToChannel: channel not connected or not ready');
    return false;
  }
  const msg = {
    type: 'message_out',
    channel,
    to,
    body,
    ts: Date.now(),
    ...opts,
  };
  try {
    ch.ws.send(JSON.stringify(msg));
    ch.stats.out++;
    return true;
  } catch (err) {
    log.warn({ err: err.message, channel }, 'sendToChannel: send failed');
    return false;
  }
}

/**
 * Emit a typed event to a channel adapter (typing indicator, status, etc.)
 *
 * @param {string} channel  Target channel name
 * @param {string} event    Event type ('typing', 'status', etc.)
 * @param {object} [data]   Additional event data
 * @returns {boolean}
 */
export function emitToChannel(channel, event, data = {}) {
  const ch = channels.get(channel);
  if (!ch || ch.ws.readyState !== 1) return false;
  try {
    ch.ws.send(JSON.stringify({ type: event, channel, ts: Date.now(), ...data }));
    return true;
  } catch {
    return false;
  }
}

// ─── Introspection ───────────────────────────────────────────────────────────

/**
 * Get runtime stats: connected channels, message counts, token prefix.
 * Safe to expose in dashboards (token truncated).
 */
export function getChannelStats() {
  return {
    running: wss !== null,
    port: wss?.address()?.port ?? config.wsGatewayPort,
    connected: channels.size,
    channels: Array.from(channels.entries()).map(([name, ch]) => ({
      name,
      ready: ch.ws.readyState === 1,
      lastSeen: ch.lastSeen,
      stats: ch.stats,
    })),
    tokenPrefix: GATEWAY_TOKEN.slice(0, 8) + '...',
  };
}

/** True if at least one channel adapter is connected and authenticated. */
export function hasChannels() {
  return channels.size > 0;
}
