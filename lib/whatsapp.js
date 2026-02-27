import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  getContentType,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, rmSync } from 'fs';
import { join, extname, resolve, isAbsolute } from 'path';
import config from './config.js';
import { chat, chatOneShot, resetSession, reloadSkills } from './claude.js';
import { formatForWhatsApp, chunkMessage as chunkMessageUtil } from './formatter.js';
import { routeMessage } from './router.js';
import { getMessages, addMessage, clear, buildHistoryForClaude, trackTopic, searchMessages } from './history.js';
import { notify } from './notify.js';
import { listSkills, getSkill, addSkill, deleteSkill } from './skills.js';
import { setSendFn, getCronSummary } from './crons.js';
import { trackUserEngagement } from './agent-loop.js';
import { updateMood } from './mood-engine.js';
import { appendConversation, getTodayNotes, getNotesForDate } from './daily-notes.js';
import { isConnected as isMcpConnected, smartIngest, setIntention } from './mcp-gateway.js';
import { createLogger, genRequestId } from './logger.js';
import { runHook, runHookAsync, runCommandHook, runPreChatPipeline, listPlugins, setPluginEnabled } from './plugins.js';
import { recordMessage, recordError, getHealthSnapshot } from './metrics.js';
import { checkCostAlert, formatCostReport } from './cost-analytics.js';
import { executeTask, executeTaskAsWorkflow, getActiveTask } from './task-planner.js';
import { trackSave } from './memory-tiers.js';
import { recordFeedback, getLastInjectedMemories } from './memory-index.js';
import { getGoalSummary, getGoalDetail, addGoal } from './goals.js';
import { getBrainStatus } from './agent-brain.js';
import { generateRecap } from './recap.js';
import { getOutcomeSummary } from './outcome-tracker.js';
import { runSelfReviewNow, rollbackProactiveSection } from './self-review.js';
import { getWorkflowSummary, getWorkflowDetail, cancelWorkflow, pauseWorkflow, resumeWorkflow, listWorkflows } from './workflow-engine.js';
import { listNotes as listUserNotes, getNotesContext } from './user-notes.js';
import { emit as wsEmit } from './ws-events.js';
import { transcribeAudio, isTranscriptionAvailable } from './transcribe.js';
import {
  extractClarification,
  storePendingClarification,
  getPendingClarification,
  clearPendingClarification,
  buildClarifiedMessage,
} from './clarification.js';
import {
  setSendFn as waChannelSetSend,
  setDisconnected as waChannelDisconnect,
  emitMessage as waChannelEmit,
} from './channel-wa.js';
import { executeAction } from './command-dispatcher.js';

const log = createLogger('whatsapp');
const baileysLogger = pino({ level: 'warn', base: undefined });

const MAX_CHUNK = config.maxChunk;
const COMPOSING_TIMEOUT_MS = config.composingTimeout;
const sentMessageIds = new Map(); // Track bot-sent messages { id → timestamp } to avoid loops
const processedIncomingIds = new Map(); // Track processed incoming msg IDs — prevent cascade re-delivery after reconnect

/** Track a sent message to avoid echo loops. */
function trackSent(result) {
  if (result?.key?.id) sentMessageIds.set(result.key.id, Date.now());
}
let currentSock = null; // Exposed for cron delivery

// --- Smart message batching (2s debounce) ---
const BATCH_DELAY_MS = config.batchDelay;
const pendingBatches = new Map(); // sender → { texts: [], timer, latestMsg }

// Prune sentMessageIds and processedIncomingIds every 60s — remove entries older than 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 300_000; // 5 min window (covers reconnect re-delivery window)
  for (const [id, ts] of sentMessageIds) {
    if (ts < cutoff) sentMessageIds.delete(id);
  }
  for (const [id, ts] of processedIncomingIds) {
    if (ts < cutoff) processedIncomingIds.delete(id);
  }
}, 60_000).unref();

const SEND_TIMEOUT_MS = 15_000; // 15s max per chunk — prevents infinite hang on dead socket

async function sendWhatsAppMessage(text) {
  if (!currentSock) {
    log.warn('sendWhatsAppMessage called but no socket connected');
    return;
  }
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    try {
      // Race send against timeout — prevents cascade of hung sends during reconnect
      const sent = await Promise.race([
        currentSock.sendMessage(config.allowedJid, { text: chunk }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('sendMessage timeout (15s)')), SEND_TIMEOUT_MS)),
      ]);
      trackSent(sent);
    } catch (err) {
      log.error({ err: err.message }, 'sendWhatsAppMessage: chunk send failed — socket may be disconnecting');
      throw err; // re-throw so channel-wa.js catch block returns false (prevents silent drop)
    }
  }
}

// ─── Group-Based Alert Routing ────────────────────────────────────────────

const GROUP_MAP = {
  alerts:   () => config.waGroupAlerts,
  hattrick: () => config.waGroupHattrick,
  daily:    () => config.waGroupDaily,
};

/**
 * Send a message to a specific JID (group or individual).
 * @param {string} jid - Baileys JID (e.g. 120363...@g.us or ...@s.whatsapp.net)
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function sendToJid(jid, text) {
  if (!currentSock) {
    log.warn({ jid }, 'sendToJid: no socket');
    return false;
  }
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    const sent = await Promise.race([
      currentSock.sendMessage(jid, { text: chunk }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('sendMessage timeout')), SEND_TIMEOUT_MS)),
    ]);
    trackSent(sent); // Prevent bot from re-processing its own group messages
  }
  return true;
}

/**
 * Send a message routed by category.
 * If the group for this category is configured → sends to group.
 * Otherwise → falls back to user DM.
 *
 * @param {string} category - 'alerts' | 'hattrick' | 'daily'
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function sendToGroup(category, text) {
  const groupJid = GROUP_MAP[category]?.();
  const targetJid = groupJid || config.allowedJid;
  try {
    await sendToJid(targetJid, text);
    log.info({ category, target: groupJid ? 'group' : 'dm', len: text.length }, 'sendToGroup delivered');
    return true;
  } catch (err) {
    log.error({ err: err.message, category }, 'sendToGroup failed');
    if (groupJid) {
      try { await sendToJid(config.allowedJid, text); return true; } catch {}
    }
    return false;
  }
}

// Ensure workspace directory exists
mkdirSync(config.workspaceDir, { recursive: true });

// Mimetype map for sending files
const MIME_MAP = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.py': 'text/x-python',
  '.js': 'text/javascript',
  '.html': 'text/html',
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

// Media content types we can receive
const MEDIA_TYPES = new Set([
  'imageMessage',
  'documentMessage',
  'audioMessage',
  'videoMessage',
]);

function resolveFilePath(filePath, restrictToWorkspace = true) {
  let resolved;
  if (isAbsolute(filePath)) {
    resolved = resolve(filePath);
  } else {
    // Strip leading "workspace/" prefix if present — paths are already relative to workspaceDir
    const normalized = filePath.replace(/^workspace[/\\]/i, '');
    resolved = resolve(config.workspaceDir, normalized);
  }

  // Enforce workspace boundary (case-insensitive on Windows)
  if (restrictToWorkspace) {
    const workspacePrefix = resolve(config.workspaceDir);
    const cmp = process.platform === 'win32'
      ? !resolved.toLowerCase().startsWith(workspacePrefix.toLowerCase())
      : !resolved.startsWith(workspacePrefix);
    if (cmp) {
      throw new Error(`Path "${filePath}" is outside workspace`);
    }
  }

  return resolved;
}

async function sendFileToWhatsApp(sock, jid, filePath, restrictToWorkspace = true) {
  const fullPath = resolveFilePath(filePath, restrictToWorkspace);
  const buffer = readFileSync(fullPath);
  const ext = extname(fullPath).toLowerCase();
  const fileName = fullPath.split(/[/\\]/).pop();
  const mimetype = MIME_MAP[ext] || 'application/octet-stream';
  const sizeStr = buffer.length < 1024 ? `${buffer.length}B`
    : buffer.length < 1048576 ? `${(buffer.length / 1024).toFixed(1)}KB`
    : `${(buffer.length / 1048576).toFixed(1)}MB`;

  log.info({ fileName, size: sizeStr, mimetype }, 'Sending file');

  if (IMAGE_EXTENSIONS.has(ext)) {
    const sent = await sock.sendMessage(jid, {
      image: buffer,
      mimetype,
      caption: fileName,
    });
    log.info({ fileName }, 'File sent (image)');
    return sent;
  } else {
    const sent = await sock.sendMessage(jid, {
      document: buffer,
      mimetype,
      fileName,
    });
    log.info({ fileName }, 'File sent (document)');
    return sent;
  }
}

// Wrap the shared chunkMessage utility with the configured max chunk size
function chunkMessage(text) { return chunkMessageUtil(text, MAX_CHUNK); }

// --- Shared action helpers ---

async function sendReply(sock, sender, text) {
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    const sent = await sock.sendMessage(sender, { text: chunk });
    trackSent(sent);
  }
}

// --- Progress tracker for long-running Claude tasks ---

/**
 * Creates a progress tracker that sends WhatsApp heartbeats and Telegram alerts
 * for long-running tasks. Gives visibility into what Sela is doing.
 */
function createProgressTracker(sock, sender, text) {
  let lastToolName = null;
  let toolCount = 0;
  const startedAt = Date.now();
  // Progress is shown only via typing indicator + dashboard (no WhatsApp messages to avoid ghost bubbles)

  // Dashboard heartbeat every 60s (no WhatsApp messages — typing indicator suffices)
  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const activity = lastToolName || 'thinking';
    wsEmit('task:heartbeat', { elapsed, activity, toolCount });
  }, 60_000);

  // Telegram alert after 3 min of continuous work
  const longTaskAlert = setTimeout(() => {
    notify(`Heavy task (>3min): "${text.slice(0, 80)}"`);
    wsEmit('task:long', { text: text.slice(0, 80), elapsed: 180 });
  }, 180_000);

  return {
    trackTool(name) { lastToolName = name; toolCount++; },
    getLastTool() { return lastToolName; },
    getToolCount() { return toolCount; },
    /** No-op — progress messages no longer sent to WhatsApp */
    trackProgress() {},
    async cleanupProgress() {},
    complete(costUsd) {
      clearInterval(heartbeat);
      clearTimeout(longTaskAlert);
      const totalMs = Date.now() - startedAt;
      if (totalMs > 120_000) {
        const mins = Math.floor(totalMs / 60000);
        const secs = Math.floor((totalMs % 60000) / 1000);
        notify(`Done (${mins}m${secs}s, $${costUsd?.toFixed(4) || '?'}, ${toolCount} tools): "${text.slice(0, 60)}"`);
      }
      wsEmit('task:complete', { totalMs, costUsd, toolCount, text: text.slice(0, 80) });
    },
    fail(err) {
      clearInterval(heartbeat);
      clearTimeout(longTaskAlert);
      const totalMs = Date.now() - startedAt;
      if (totalMs > 60_000) {
        notify(`Failed (${Math.round(totalMs / 1000)}s): ${err.message.slice(0, 100)}`);
      }
      wsEmit('task:failed', { totalMs, error: err.message, text: text.slice(0, 80) });
    },
  };
}

/**
 * Start a composing timeout watchdog. If message handling takes longer
 * than COMPOSING_TIMEOUT_MS, log a warning and clear composing state.
 * Returns a cleanup function to call when processing finishes.
 */
function startComposingWatchdog(sock, sender) {
  const start = Date.now();
  let fired = false;
  const timer = setTimeout(async () => {
    fired = true;
    const elapsedMs = Date.now() - start;
    log.warn({ sender, elapsedMs }, 'Message processing stuck, clearing composing');
    try {
      await sock.sendPresenceUpdate('paused', sender);
    } catch {}
  }, COMPOSING_TIMEOUT_MS);

  return () => {
    clearTimeout(timer);
    return fired;
  };
}

export async function startWhatsApp({ queue, botApi } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  // Fetch latest WA web version to avoid 405 rejections
  const { version } = await fetchLatestWaWebVersion();
  log.info({ version }, 'Fetched latest WA web version');

  // Exponential backoff state — shared across reconnects via closure
  let reconnectDelay = 3000;  // starts at 3s, doubles up to 60s max
  let reconnectCount = 0;     // tracks consecutive failures for Telegram spam prevention
  let totalAuthClearCount = 0; // total 405 auth clears — never resets, prevents infinite loop

  function connectSocket() {
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      logger: baileysLogger,
      version,
      browser: ['Sela', 'Chrome', '22.0'],
    });

    currentSock = sock;
    setSendFn((text, cronName) => {
      // Route cron output to appropriate WA group, with Telegram fallback
      const category = cronName?.startsWith('ht-') ? 'hattrick' : 'daily';
      sendToGroup(category, text).catch(() => {});
      notify(text);  // Always also send to Telegram
    });
    // NOTE: botApi.send and waChannelSetSend are registered in connection === 'open' below.
    // Registering them here (before connection is established) causes cascade: callers think
    // WA is ready, attempt sends, get errors when socket isn't actually open yet. (Bug fixed Cycle 271)

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        log.info('Scan this QR code with WhatsApp:');
        qrcode.generate(qr, { small: true });
        // Also save as PNG for SSH users who can't see Unicode
        const qrPath = new URL('../qr.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
        QRCode.toFile(qrPath, qr, { scale: 8 }, (err) => {
          if (err) log.error({ err: err.message }, 'Failed to save QR image');
          else log.info({ qrPath }, 'QR code saved');
        });
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode
          : lastDisconnect?.error?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          log.error('Logged out — delete auth/ folder and restart to re-scan QR');
          notify('🔴 *Sela* logged out. Needs QR re-scan.');
          process.exit(1);
        }

        // 405 = server rejected session — after 10+ attempts, clear auth and force QR re-scan
        if (statusCode === 405 && reconnectCount >= 10) {
          totalAuthClearCount++;
          // Hard cap: after 3 auth clears without a successful open, stop looping — alert the user
          if (totalAuthClearCount > 3) {
            log.error({ totalAuthClearCount }, 'WA 405 loop: too many auth clears — stopping reconnect, manual restart needed');
            notify(`🔴 WA stuck in 405 loop (${totalAuthClearCount} auth clears). Run \`pm2 restart sela\` and scan QR at ./qr.png`);
            waChannelDisconnect();
            return; // Stops reconnecting — breaks infinite loop
          }
          log.error({ attempt: reconnectCount, totalAuthClearCount }, 'WA session expired (405) — clearing auth state, regenerating QR');
          try {
            rmSync(config.authDir, { recursive: true, force: true });
            log.info({ authDir: config.authDir }, 'Auth state cleared for QR re-scan');
          } catch (e) {
            log.warn({ err: e.message }, 'Could not clear auth dir');
          }
          notify(`⚠️ WA session expired (405) after ${reconnectCount} attempts. Auth cleared — scan QR at ./qr.png`);
          reconnectCount = 0;
          // NOTE: intentionally NOT resetting reconnectDelay here — keep backoff pressure
          waChannelDisconnect();
          setTimeout(connectSocket, reconnectDelay); // use current backoff, not hardcoded 2000ms
          return;
        }

        reconnectCount += 1;
        const nextDelay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, 60000); // cap at 60s
        log.warn({ statusCode, attempt: reconnectCount, nextDelayMs: nextDelay },
          `Disconnected, reconnecting in ${nextDelay / 1000}s...`);
        // Only notify Telegram on first disconnect or every 5th attempt (prevent spam)
        if (reconnectCount === 1 || reconnectCount % 5 === 0) {
          notify(`⚠️ *Sela* disconnected (attempt ${reconnectCount}). Reconnecting in ${nextDelay / 1000}s...`);
        }
        waChannelDisconnect();
        setTimeout(connectSocket, nextDelay);
      } else if (connection === 'open') {
        if (reconnectCount > 0) {
          log.info({ afterAttempts: reconnectCount }, 'Reconnected successfully!');
        } else {
          log.info('Connected successfully!');
        }
        reconnectDelay = 3000; // reset backoff on successful connect
        reconnectCount = 0;
        // Register send fn ONLY when socket is truly open — prevents premature send cascade
        if (botApi) botApi.send = sendWhatsAppMessage;
        waChannelSetSend(sendWhatsAppMessage); // channel-wa marks "ready" only after confirmed open
        notify('🟢 *Sela* is online.');
      }
    });

    // Track emoji reactions as engagement
    sock.ev.on('messages.reaction', (reactions) => {
      for (const r of reactions) {
        const sender = r.key?.remoteJid;
        if (sender === config.allowedJid) {
          trackUserEngagement();
          log.debug({ reaction: r.reaction?.text }, 'Reaction received — engagement tracked');
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
      if (type !== 'notify') return;

      for (const msg of msgs) {
        const sender = msg.key?.remoteJid;
        if (!sender) continue;
        if (sentMessageIds.has(msg.key.id)) { sentMessageIds.delete(msg.key.id); continue; }
        // Cascade prevention: skip re-delivered messages after WA reconnect (prevents ×N error amplification)
        if (processedIncomingIds.has(msg.key.id)) {
          log.warn({ msgId: msg.key.id, sender }, 'Skipping re-delivered msg (cascade prevention)');
          continue;
        }
        processedIncomingIds.set(msg.key.id, Date.now());
        if (!msg.message) continue;

        // Group messages: only respond when @mentioned or replied to (unless it's a bot-managed group)
        if (sender.endsWith('@g.us')) {
          log.info({ groupJid: sender }, 'Group message received (use this JID for WA_GROUP_* config)');
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

          // Bot-managed groups (WA_GROUP_*): listen to ALL messages, no @mention needed
          const botGroups = [config.waGroupAlerts, config.waGroupHattrick, config.waGroupDaily].filter(Boolean);
          const isBotGroup = botGroups.includes(sender);

          // Bot-sent messages are already filtered by sentMessageIds check above (line 473).
          // Do NOT check fromMe here — the user's phone IS the bot's phone (Baileys session),
          // so fromMe is true for all user replies in groups.

          if (!isBotGroup) {
            // External groups: require @mention or reply-to-bot
            const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
            const botJid = sock.user?.id?.replace(/:\d+@/, '@') || '';
            const isMentioned = mentions.some(jid => jid === botJid || jid?.replace(/:\d+@/, '@') === botJid);
            const isReplyToBot = quotedParticipant === botJid || quotedParticipant?.replace(/:\d+@/, '@') === botJid;
            const allowedGroups = (process.env.ALLOWED_GROUPS || '').split(',').filter(Boolean);
            const groupAllowed = allowedGroups.length === 0 || allowedGroups.some(g => sender.includes(g));

            if (!groupAllowed || (!isMentioned && !isReplyToBot)) continue;
          }

          // Strip the @mention from text so Claude gets clean input
          const cleanText = text.replace(/@\d+/g, '').trim();
          if (!cleanText) continue;

          // Inject cleaned text back into message for handleMessage
          if (msg.message.conversation != null) msg.message.conversation = cleanText;
          else if (msg.message.extendedTextMessage) msg.message.extendedTextMessage.text = cleanText;

          // Tag this as a group message for handleMessage
          msg._groupContext = {
            groupJid: sender,
            senderJid: msg.key.participant || '',
            senderName: msg.pushName || msg.key.participant?.split('@')[0] || 'someone',
          };
          log.info({ group: sender, from: msg._groupContext.senderName, text: cleanText.slice(0, 80) }, 'Group mention detected');
        }

        // Check if this is a batchable text message (not a command, not media)
        const contentType = getContentType(msg.message);
        const isMedia = contentType && MEDIA_TYPES.has(contentType);
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
        const isCommand = text && text.trim().startsWith('/');

        if (text && !isCommand && !isMedia) {
          // Debounce: batch rapid text messages from same sender
          let batch = pendingBatches.get(sender);
          if (!batch) {
            batch = { texts: [], latestMsg: msg };
            pendingBatches.set(sender, batch);
          }
          batch.texts.push(text);
          batch.latestMsg = msg;

          if (batch.timer) clearTimeout(batch.timer);
          batch.timer = setTimeout(() => {
            pendingBatches.delete(sender);
            const combined = batch.texts.join('\n\n');
            // Build synthetic message with combined text
            const synMsg = JSON.parse(JSON.stringify(batch.latestMsg));
            if (synMsg.message.conversation != null) synMsg.message.conversation = combined;
            else if (synMsg.message.extendedTextMessage) synMsg.message.extendedTextMessage.text = combined;

            if (batch.texts.length > 1) {
              log.info({ sender, count: batch.texts.length, combinedLen: combined.length }, 'Batched messages');
            }

            const enqueueMsg = (m) => {
              if (queue) {
                const { queued, depth } = queue.enqueue(sender, () => handleMessage(sock, m, botApi));
                if (!queued) {
                  log.warn({ sender, depth }, 'Queue full, sending backpressure message');
                  sock.sendMessage(sender, { text: 'Still working on your previous messages, one moment...' })
                    .then(sent => { trackSent(sent); })
                    .catch(() => {});
                }
              } else {
                handleMessage(sock, m, botApi).catch(err => {
                  log.error({ err: err.message, stack: err.stack }, 'Error handling message');
                  try {
                    sock.sendMessage(sender, { text: 'Something went wrong processing your message. Try again or /clear to reset.' })
                      .catch(() => {});
                  } catch {}
                });
              }
            };
            enqueueMsg(synMsg);
          }, BATCH_DELAY_MS);
          continue;
        }

        // Non-batchable: commands, media — process immediately
        if (queue && sender) {
          const { queued, depth } = queue.enqueue(sender, () => handleMessage(sock, msg, botApi));
          if (!queued) {
            log.warn({ sender, depth }, 'Queue full, sending backpressure message');
            try {
              const sent = await sock.sendMessage(sender, { text: 'Still working on your previous messages, one moment...' });
              trackSent(sent);
            } catch {}
          }
        } else {
          try {
            await handleMessage(sock, msg, botApi);
          } catch (err) {
            log.error({ err: err.message, stack: err.stack }, 'Error handling message');
          }
        }
      }
    });
  }

  connectSocket();
}

async function handleMessage(sock, msg, botApi) {
  // Skip bot's own replies (prevent infinite loop)
  if (sentMessageIds.has(msg.key.id)) {
    sentMessageIds.delete(msg.key.id);
    return;
  }

  const isGroup = msg.key.remoteJid.endsWith('@g.us');
  const groupCtx = msg._groupContext;
  // sender = group JID for groups, personal JID for DMs (used as history key)
  const sender = msg.key.remoteJid;

  // For DMs: only respond to allowed number or self-chat
  if (!isGroup) {
    if (msg.key.fromMe) {
      if (sender !== config.allowedJid) return;
    } else {
      if (sender !== config.allowedJid) {
        log.info({ sender }, 'Ignored message from unauthorized');
        return;
      }
    }
  }
  // Group messages already filtered by mention/reply in upsert handler

  // Skip protocol messages (reactions, receipts, etc.)
  if (!msg.message) return;

  // --- Handle media messages (file receive) ---
  const contentType = getContentType(msg.message);
  if (contentType && MEDIA_TYPES.has(contentType)) {
    await handleMediaMessage(sock, msg, sender, contentType);
    return;
  }

  // Extract text from message
  let text = msg.message?.conversation
    || msg.message?.extendedTextMessage?.text;
  if (!text) return;

  // Prepend quoted message context if this is a quote-reply
  const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const quotedText = quotedMsg?.conversation
    || quotedMsg?.extendedTextMessage?.text
    || quotedMsg?.imageMessage?.caption;
  if (quotedText) {
    text = `[מענה להודעה: "${quotedText.slice(0, 300)}"]\n${text}`;
  }

  // Notify channel adapter of incoming message (for multi-channel routing future)
  waChannelEmit({ from: sender, body: text, ts: msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now(), type: 'text' });

  log.info({ sender, text: text.slice(0, 100) }, 'Incoming message');
  wsEmit('message:received', { preview: text.slice(0, 80), ts: Date.now() });

  // Track engagement: did user reply to an agent-initiated message?
  trackUserEngagement(text);

  // Phase 5: Update mood engine with message signals
  try { updateMood({ text, timestamp: Date.now() }); } catch {}

  // Track conversation topics for context enrichment
  trackTopic(sender, text);

  // HOOK: onMessage — every message received
  runHook('onMessage', { sender, text, msg }, botApi);

  // --- Clarification answer check ---
  let isClarificationResend = false;
  let overrideTier = null;
  const pending = getPendingClarification(sender);
  if (pending) {
    if (text.trim().startsWith('/')) {
      // Slash command while pending — treat as new command, discard pending
      clearPendingClarification(sender);
    } else {
      // It's an answer to a pending clarification
      clearPendingClarification(sender);
      log.info({ sender: sender.slice(0, 12) }, 'Clarification answered — re-sending original request');
      text = buildClarifiedMessage(pending.originalText, text);
      overrideTier = pending.tier;
      isClarificationResend = true;
    }
  }

  // --- Message routing (classifier → intent → action → Claude) ---
  const route = routeMessage(text, sender);
  let tier = overrideTier || route.tier;

  if (route.type === 'action') {
    const handled = await executeAction(sock, sender, route.action, route.params, botApi, { sendReply, sendFileToWhatsApp, trackSent });
    if (handled) return;
    // Unhandled actions → fall through to Claude
  }

  // Track incoming message metrics
  recordMessage('in', { tier });

  if (route.type === 'ack') {
    try { await sock.sendMessage(sender, { react: { text: '\uD83D\uDC4D', key: msg.key } }); } catch {}
    log.info({ sender, text: text.slice(0, 50) }, 'Tier 0 acknowledgment — no LLM');
    return;
  }

  if (route.type === 'command') {
    const handled = await runCommandHook(text.trim().toLowerCase(), text, botApi);
    if (handled) return;
    // Unrecognized command → fall through to Claude
  }

  // --- /task handler: plan-then-execute ---
  if (route.taskMode) {
    const msgStart = Date.now();
    const taskDesc = text.replace(/^\/task\s+/i, '').trim();
    log.info({ sender, taskDesc: taskDesc.slice(0, 120) }, 'MSG_IN: Task mode');

    await Promise.all([
      sock.sendMessage(sender, { react: { text: '\u{1F3AF}', key: msg.key } }).catch(() => {}),
      sock.presenceSubscribe(sender).then(() => sock.sendPresenceUpdate('composing', sender)).catch(() => {}),
    ]);

    const clearWatchdog = startComposingWatchdog(sock, sender);
    const tracker = createProgressTracker(sock, sender, taskDesc);
    try {
      addMessage(sender, 'user', text);

      const sendProgress = async (progressText) => {
        // Dashboard only — no WhatsApp messages (avoids ghost bubbles on deletion)
        wsEmit('task:progress', { text: progressText, ts: Date.now() });
        log.info({ progressText: progressText.slice(0, 100) }, 'Task progress');
      };

      const onChunk = async (chunk) => {
        const clean = formatForWhatsApp(chunk);
        if (!clean) return;
        const sent = await sock.sendMessage(sender, { text: clean });
        trackSent(sent);
      };

      const botContext = {
        jid: sender,
        isMcpConnected,
        queueStats: () => botApi?._queue?.stats() || { running: '?', waiting: '?' },
        getTodayNotes,
        getNotesForDate,
        listSkills: () => listSkills(),
        onChunk,
      };

      const result = await executeTaskAsWorkflow(taskDesc, sendProgress, botContext);

      tracker.complete(result.costUsd);
      await tracker.cleanupProgress();
      addMessage(sender, 'assistant', result.reply);
      appendConversation(text, result.reply, { costUsd: result.costUsd });
      checkCostAlert();

      clearWatchdog();
      await sock.sendPresenceUpdate('paused', sender);
      try { await sock.sendMessage(sender, { react: { text: '\u2705', key: msg.key } }); } catch {}
      recordMessage('out', { latencyMs: Date.now() - msgStart, costUsd: result.costUsd });
    } catch (err) {
      clearWatchdog();
      tracker.fail(err);
      await tracker.cleanupProgress();
      log.error({ err: err.message, taskDesc: taskDesc.slice(0, 100) }, 'Task execution failed');
      const errMsg = await sock.sendMessage(sender, { text: `Task failed: ${err.message.slice(0, 200)}` });
      trackSent(errMsg);
      try { await sock.sendMessage(sender, { react: { text: '\u274c', key: msg.key } }); } catch {}
      recordError('task_failed');
    }
    return;
  }

  // --- Lightweight one-shot for Tier 1 (short simple messages) ---
  if (tier === 1) {
    const msgStart = Date.now();
    log.info({ sender, text: text.slice(0, 80), tier }, 'MSG_IN: Tier 1 lightweight');

    await sock.presenceSubscribe(sender).then(() => sock.sendPresenceUpdate('composing', sender)).catch(() => {});

    const tracker = createProgressTracker(sock, sender, text);
    try {
      addMessage(sender, 'user', text);
      const recentHistory = buildHistoryForClaude(sender, 3000); // smaller history budget
      const historyBlock = recentHistory.map(m => `${m.role}: ${m.content}`).join('\n');
      const prompt = `Recent conversation:\n${historyBlock}\n\nRespond to this message concisely (1-3 lines). Match the language (English/Hebrew). This is WhatsApp.\n\nuser: ${text}`;

      const onChunk = async (chunk) => {
        const clean = formatForWhatsApp(chunk);
        if (!clean) return;
        const sent = await sock.sendMessage(sender, { text: clean });
        trackSent(sent);
      };

      const onToolUse = (toolName) => { tracker.trackTool(toolName); };

      const { reply, costUsd } = await chatOneShot(prompt, onChunk, null, { onToolUse });
      tracker.complete(costUsd);
      addMessage(sender, 'assistant', reply);
      appendConversation(text, reply, { costUsd });
      checkCostAlert();

      await sock.sendPresenceUpdate('paused', sender);
      recordMessage('out', { latencyMs: Date.now() - msgStart, costUsd });
    } catch (err) {
      tracker.fail(err);
      log.error({ err: err.message }, 'Tier 1 one-shot failed');
      recordError('tier1_failed');
      // Fall through — don't show error for simple messages
    }
    return;
  }

  // --- Claude conversation flow (Tier 2+) ---
  const msgStart = Date.now();
  const reqId = genRequestId();
  log.info({ sender, textLen: text.length, text: text.slice(0, 120), tier, reqId }, 'MSG_IN: Processing message');

  // React with hourglass + show typing indicator (parallel — independent network calls)
  await Promise.all([
    sock.sendMessage(sender, { react: { text: '\u23f3', key: msg.key } }).catch(() => {}),
    sock.presenceSubscribe(sender).then(() => sock.sendPresenceUpdate('composing', sender)).catch(() => {}),
  ]);

  // Start composing watchdog (90s stuck detection)
  const clearWatchdog = startComposingWatchdog(sock, sender);

  // Progress tracker for long-running tasks
  const tracker = createProgressTracker(sock, sender, text);

  try {
    // For group messages, prefix with sender info so Claude knows who's talking
    const chatText = groupCtx
      ? `[Group message from ${groupCtx.senderName}]: ${text}`
      : text;
    addMessage(sender, 'user', chatText);

    // Streaming chunk callback — format and send text to WhatsApp as it arrives
    const onChunk = async (chunk) => {
      // Strip [CLARIFY: ...] markers so user sees clean question text
      const stripped = chunk.replace(/\[CLARIFY:\s*([\s\S]*?)\]/si, '$1');
      const clean = formatForWhatsApp(stripped);
      if (!clean) return;
      const sent = await sock.sendMessage(sender, { text: clean });
      trackSent(sent);
      log.info({ chunkLen: clean.length }, 'Sent streamed chunk');
    };

    // Tool use progress — tracked internally + dashboard only (no WhatsApp messages)
    const onToolUse = (toolName) => {
      tracker.trackTool(toolName);
      wsEmit('tool:use', { tool: toolName, ts: Date.now() });
    };

    // Get filtered conversation history (skips acks, enforces token budget)
    const history = buildHistoryForClaude(sender);

    // HOOK: preChat pipeline — plugins can modify text/add context or intercept
    const preChatResult = await runPreChatPipeline(chatText, history, botApi);

    // If a plugin handled the message (e.g. proposal response), skip Claude
    if (preChatResult.handled) {
      log.info({ reqId }, 'Message handled by preChat plugin, skipping Claude');
      return;
    }

    // Build bot context for local markers
    const botContext = {
      jid: sender,
      isGroup,
      groupContext: groupCtx || null,
      isMcpConnected,
      queueStats: () => botApi?._queue?.stats() || { running: '?', waiting: '?' },
      getTodayNotes,
      getNotesForDate,
      listSkills: () => listSkills(),
      pluginContext: preChatResult.extraContext || '',
    };

    log.info({ historyLen: history.length, tier, reqId }, 'Calling Claude pipeline (streaming)');
    const { reply, claudeMs, filesToSend, dataMessages, shouldClearHistory, costUsd, inputTokens, outputTokens } = await chat(history, onChunk, botContext, { tier, onToolUse });

    tracker.complete(costUsd);
    // Delete progress/log messages from chat — keep only the final reply
    await tracker.cleanupProgress();
    log.info({ claudeMs, replyLen: reply.length, costUsd: costUsd?.toFixed(4), replyPreview: reply.slice(0, 200) }, 'MSG_REPLY: Claude responded');
    wsEmit('message:reply', { replyLen: reply.length, claudeMs, costUsd: costUsd || 0, ts: Date.now() });

    // Check if Claude wants clarification (only on fresh messages, not re-sends)
    if (!isClarificationResend) {
      const clarification = extractClarification(reply);
      if (clarification) {
        storePendingClarification(sender, {
          originalText: text,
          question: clarification.question,
          tier,
        });
        log.info({ question: clarification.question.slice(0, 60) }, 'Clarification requested by Claude');
      }
    }

    // HOOK: postChat — after Claude responds
    runHook('postChat', text, reply, { claudeMs, filesToSend, costUsd }, botApi);

    // Add full assistant reply to history
    addMessage(sender, 'assistant', reply);

    // Proactive memory saving (background, non-blocking)
    (async () => {
      try {
        const SENSITIVE_RE = /password|token|secret|key|credential|סיסמ|מפתח/i;

        // --- Save from user text ---
        const userSavePatterns = [
          { re: /(?:I (?:prefer|like|want|use|chose|decided|always|never))\s+(.{10,120})/i, type: 'preference' },
          { re: /(?:remember|don't forget|note that|keep in mind|תזכור|אל תשכח|שים לב)\s+(.{10,200})/i, type: 'explicit' },
          { re: /(?:(?:we|I) decided|the plan is|going forward|let's go with|החלטנו|נלך על)\s+(.{10,200})/i, type: 'decision' },
          { re: /(?:deadline|due|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)|דדליין|עד יום)\s*(.{5,100})/i, type: 'deadline' },
          { re: /(?:my (?:name|email|phone|address|number) is|I (?:work at|live in|am from))\s+(.{3,100})/i, type: 'personal' },
          { re: /(?:the project|the repo|the app) (?:is called|is at|lives at|uses)\s+(.{5,150})/i, type: 'project' },
        ];

        if (text.length >= 30 && !SENSITIVE_RE.test(text)) {
          let userSaved = 0;
          for (const { re, type } of userSavePatterns) {
            if (userSaved >= 2) break; // max 2 saves per message
            const match = text.match(re);
            if (match) {
              const content = `[auto-save:${type}] ${text.slice(0, 300)}`;
              await smartIngest(content, ['auto-saved', type], type === 'decision' ? 'decision' : 'fact', 'whatsapp-agent');
              trackSave(content, type, ['auto-saved', type]);
              log.info({ type, len: content.length }, 'Proactive memory save (user)');
              userSaved++;
            }
          }
        }

        // --- Save from Claude's reply (decisions and actions taken) ---
        const replySavePatterns = [
          { re: /(?:I(?:'ve| have)? (?:set up|configured|created|installed|switched to|changed|updated|migrated))\s+(.{10,200})/i, type: 'action' },
          { re: /(?:(?:we|I) (?:should|will) (?:use|go with|switch to|adopt))\s+(.{5,120})/i, type: 'decision' },
          { re: /(?:I'll remember|noted|saved (?:that|this)|I've stored)\s/i, type: 'skip' }, // already saving explicitly
        ];

        if (reply.length >= 40 && !SENSITIVE_RE.test(reply)) {
          for (const { re, type } of replySavePatterns) {
            if (type === 'skip') { if (re.test(reply)) break; else continue; }
            const match = reply.match(re);
            if (match) {
              const content = `[auto-save:${type}:reply] ${reply.slice(0, 300)}`;
              await smartIngest(content, ['auto-saved', type, 'from-reply'], 'decision', 'whatsapp-agent');
              trackSave(content, type, ['auto-saved', type, 'from-reply']);
              log.info({ type, len: content.length }, 'Proactive memory save (reply)');
              break; // max 1 from reply
            }
          }
        }

        // --- Proactive intention setting ---
        // Detect deadlines, reminders, and follow-up triggers in user text
        const intentionPatterns = [
          { re: /(?:by|before|until|due)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|end of (?:day|week|month))/i, type: 'deadline' },
          { re: /(?:remind me|don't let me forget|תזכיר לי|אל תשכח)\s+(.{10,200})/i, type: 'reminder' },
          { re: /(?:דדליין|עד יום|עד ה?(?:שני|שלישי|רביעי|חמישי|שישי|שבת|ראשון)|עד מחר|עד סוף ה?(?:שבוע|חודש|יום))\s*(.{5,100})/i, type: 'deadline' },
          { re: /(?:I need to|I have to|I must|I should|צריך ל|חייב ל|אני חייב)\s+(.{10,150})/i, type: 'task' },
        ];

        for (const { re, type } of intentionPatterns) {
          const match = text.match(re);
          if (match) {
            try {
              const desc = `${type === 'reminder' ? 'Remind the user: ' : ''}${text.slice(0, 300)}`;
              const priority = type === 'deadline' ? 'high' : 'normal';
              await setIntention(desc, { context: [text.slice(0, 200)] }, priority);
              log.info({ type, desc: desc.slice(0, 100) }, 'Proactive intention set');
            } catch (err) {
              log.debug({ err: err.message }, 'Proactive intention set failed');
            }
            break;
          }
        }
      } catch (err) {
        log.debug({ err: err.message }, 'Proactive memory save failed (non-critical)');
      }
    })();

    // Memory feedback detection — check if user is confirming or correcting memories
    try {
      const lastMemories = getLastInjectedMemories();
      if (lastMemories.length > 0) {
        const confirmRe = /\b(exactly|correct|right|yes that's? (?:right|correct|it)|בדיוק|נכון|כן זה נכון|מדויק)\b/i;
        const correctRe = /\b(that's? (?:wrong|not right|incorrect|outdated)|no that's? not|wrong|incorrect|לא נכון|טעות|שגוי|לא מדויק|זה לא נכון)\b/i;
        if (correctRe.test(text)) {
          for (const mem of lastMemories) {
            recordFeedback(mem, 'corrected');
          }
          log.info({ count: lastMemories.length }, 'FEEDBACK: User corrected memories (0.3x penalty applied)');
        } else if (confirmRe.test(text)) {
          for (const mem of lastMemories) {
            recordFeedback(mem, 'confirmed');
          }
          log.info({ count: lastMemories.length }, 'FEEDBACK: User confirmed memories (1.3x boost applied)');
        }
      }
    } catch {}

    // Append to daily notes
    appendConversation(text, reply, { costUsd, inputTokens, outputTokens });

    // Send data messages from local markers (BOT_STATUS, LIST_CRONS, etc.)
    if (dataMessages && dataMessages.length > 0) {
      for (const dataMsg of dataMessages) {
        const dChunks = chunkMessage(dataMsg);
        for (const chunk of dChunks) {
          const sent = await sock.sendMessage(sender, { text: chunk });
          trackSent(sent);
        }
      }
    }

    // Handle clear history from Claude marker
    if (shouldClearHistory) {
      clear(sender);
      resetSession();
      log.info('CLEAR_HISTORY marker: history and session reset');
    }

    // Stop typing indicator + clear watchdog
    clearWatchdog();
    await sock.sendPresenceUpdate('paused', sender);

    // Send files queued by markers (restricted to workspace for security)
    if (filesToSend && filesToSend.length > 0) {
      log.info({ files: filesToSend }, 'Sending files from tool calls');
      for (const filePath of filesToSend) {
        try {
          const sent = await sendFileToWhatsApp(sock, sender, filePath, true);
          trackSent(sent);
        } catch (err) {
          log.error({ err: err.message, filePath }, 'Failed to send file');
          const errSent = await sock.sendMessage(sender, {
            text: `Could not send file "${filePath}": ${err.message}`,
          });
          trackSent(errSent);
        }
      }
    }

    const totalMs = Date.now() - msgStart;
    recordMessage('out', { latencyMs: totalMs, costUsd });
    checkCostAlert();
    log.info({ totalMs, claudeMs, sender, reqId }, 'MSG_OUT: Message fully delivered');

    // React with checkmark on success
    try { await sock.sendMessage(sender, { react: { text: '\u2705', key: msg.key } }); } catch {}
  } catch (err) {
    clearWatchdog();
    tracker.fail(err);
    await tracker.cleanupProgress();
    const errStr = err.message || '';
    const errType = /timeout|timed?\s*out|ETIMEDOUT/i.test(errStr) ? 'timeout'
      : /auth|401|403|credential/i.test(errStr) ? 'auth'
      : /ECONNREFUSED|ECONNRESET|socket|network/i.test(errStr) ? 'network'
      : /spawn|exited|exit code|ENOENT.*claude/i.test(errStr) ? 'claude'
      : 'other';
    recordError(errType);
    const totalMs = Date.now() - msgStart;
    log.error({ err: err.message, totalMs, sender, errType, reqId }, 'MSG_ERR: Claude pipeline failed');
    await sock.sendPresenceUpdate('paused', sender);

    // Friendly error messages based on error type
    let friendlyMsg;
    if (/timeout|timed?\s*out|ETIMEDOUT/i.test(errStr)) {
      friendlyMsg = 'That took too long — try again or simplify your request.';
    } else if (/ECONNREFUSED|ECONNRESET|socket|network/i.test(errStr)) {
      friendlyMsg = 'Connection issue — give me a sec and try again.';
    } else if (/spawn|exited|exit code|ENOENT.*claude/i.test(errStr)) {
      friendlyMsg = 'Something went wrong on my end. Try again in a moment.';
    } else if (/rate.?limit|429|too many/i.test(errStr)) {
      friendlyMsg = 'Hit a rate limit — wait a minute and try again.';
    } else if (/auth|401|403|credential/i.test(errStr)) {
      friendlyMsg = 'Auth issue — the user may need to check the credentials.';
    } else {
      friendlyMsg = `Something broke: ${errStr.slice(0, 100)}\n\nTry again or send /clear to reset.`;
    }

    const errMsg = await sock.sendMessage(sender, { text: friendlyMsg });
    trackSent(errMsg);

    // React with red circle on error
    try { await sock.sendMessage(sender, { react: { text: '\u274c', key: msg.key } }); } catch {}
  }
}

async function handleMediaMessage(sock, msg, sender, contentType) {
  const msgStart = Date.now();
  log.info({ sender, contentType }, 'Received media');

  try {
    // Determine filename
    const mediaMsg = msg.message[contentType];
    let fileName = mediaMsg?.fileName;

    if (!fileName) {
      const extMap = {
        imageMessage: '.jpg',
        videoMessage: '.mp4',
        audioMessage: '.ogg',
        documentMessage: '.bin',
      };
      const ext = extMap[contentType] || '.bin';
      fileName = `${contentType.replace('Message', '')}-${Date.now()}${ext}`;
    }

    // Sanitize filename
    fileName = fileName.replace(/[/\\:*?"<>|]/g, '_');

    // Download the media
    log.info({ fileName }, 'Downloading media');
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger: baileysLogger,
      reuploadRequest: sock.updateMediaMessage,
    });

    // Save to workspace
    mkdirSync(config.workspaceDir, { recursive: true });
    const savePath = join(config.workspaceDir, fileName);
    writeFileSync(savePath, buffer);

    const sizeStr = buffer.length < 1024 ? `${buffer.length}B`
      : buffer.length < 1048576 ? `${(buffer.length / 1024).toFixed(1)}KB`
      : `${(buffer.length / 1048576).toFixed(1)}MB`;

    log.info({ savePath, size: sizeStr }, 'Saved media to workspace');

    const caption = mediaMsg?.caption || '';
    const isImage = contentType === 'imageMessage';
    const isAudio = contentType === 'audioMessage';
    const ext = extname(fileName).toLowerCase();
    const isVoiceNote = isAudio || ext === '.ogg' || ext === '.opus';

    // --- Image: tell Claude to read the image file (vision) ---
    if (isImage) {
      const instruction = caption
        ? `I'm sending you an image. ${caption}\n\nThe image is saved at: ${savePath.replace(/\\/g, '/')}\nUse the Read tool to view it and respond.`
        : `I'm sending you an image. Describe what you see and ask if I need anything specific.\n\nThe image is saved at: ${savePath.replace(/\\/g, '/')}\nUse the Read tool to view it.`;
      addMessage(sender, 'user', instruction);
      recordMessage('in', { tier: 2 });
      log.info({ fileName, size: sizeStr }, 'Image received — routing to Claude vision');
    }
    // --- Voice note: transcribe with Whisper, or fall back to placeholder ---
    else if (isVoiceNote) {
      let instruction;
      const transcript = await transcribeAudio(savePath).catch(() => null);
      if (transcript && transcript.text) {
        instruction = `[Voice message transcribed]\n${transcript.text}`;
        log.info({ fileName, size: sizeStr, chars: transcript.text.length }, 'Voice note transcribed');
      } else {
        const hint = isTranscriptionAvailable() ? 'Transcription failed.' : 'Set OPENAI_API_KEY to enable transcription.';
        instruction = `I sent you a voice message (${sizeStr}). ${hint} Audio saved at: workspace/${fileName}`;
        log.info({ fileName, size: sizeStr, transcribed: false }, 'Voice note received (no transcript)');
      }
      addMessage(sender, 'user', instruction);
      recordMessage('in', { tier: 1 });
    }
    // --- Other files ---
    else {
      const captionNote = caption ? ` with caption: "${caption}"` : '';
      const userNote = `I sent you a file: ${fileName} (${sizeStr}, saved to workspace/${fileName})${captionNote}`;
      addMessage(sender, 'user', userNote);
      recordMessage('in', { tier: 2 });
    }

    // Show typing and get Claude's response
    await sock.presenceSubscribe(sender).then(() => sock.sendPresenceUpdate('composing', sender)).catch(() => {});
    const clearWatchdog = startComposingWatchdog(sock, sender);

    const onChunk = async (chunk) => {
      const clean = formatForWhatsApp(chunk);
      if (!clean) return;
      const sent = await sock.sendMessage(sender, { text: clean });
      trackSent(sent);
    };

    const tier = isImage ? 2 : 1;
    const history = buildHistoryForClaude(sender);
    const botContext = {
      jid: sender,
      isMcpConnected,
      queueStats: () => botApi?._queue?.stats() || { running: '?', waiting: '?' },
      getTodayNotes,
      getNotesForDate,
      listSkills: () => listSkills(),
    };

    log.info({ historyLen: history.length, tier, isImage }, 'Sending to Claude (media, streaming)');
    const { reply, claudeMs, filesToSend, costUsd, inputTokens, outputTokens } = await chat(history, onChunk, botContext, { tier });

    addMessage(sender, 'assistant', reply);
    clearWatchdog();
    await sock.sendPresenceUpdate('paused', sender);

    recordMessage('out', { latencyMs: Date.now() - msgStart, costUsd });
    appendConversation(isImage ? `[image] ${caption || fileName}` : `[file] ${fileName}`, reply, { costUsd, inputTokens, outputTokens });

    if (filesToSend && filesToSend.length > 0) {
      for (const filePath of filesToSend) {
        try {
          const sent = await sendFileToWhatsApp(sock, sender, filePath, true);
          trackSent(sent);
        } catch (err) {
          log.error({ err: err.message, filePath }, 'Failed to send file');
        }
      }
    }

    const totalMs = Date.now() - msgStart;
    log.info({ totalMs, claudeMs, sender, isImage }, 'Media message handled');
    try { await sock.sendMessage(sender, { react: { text: '\u2705', key: msg.key } }); } catch {}
  } catch (err) {
    recordError('whatsapp');
    const totalMs = Date.now() - msgStart;
    log.error({ err: err.message, stack: err.stack, totalMs, sender }, 'Failed to handle media');
    const sent = await sock.sendMessage(sender, {
      text: `Failed to process: ${err.message}`,
    });
    trackSent(sent);
    try { await sock.sendMessage(sender, { react: { text: '\u274c', key: msg.key } }); } catch {}
  }
}
