import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  getContentType,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'fs';
import { join, extname, resolve, isAbsolute } from 'path';
import config from './config.js';
import { chat, chatOneShot, resetSession } from './claude.js';
import { formatForWhatsApp } from './formatter.js';
import { routeMessage } from './router.js';
import { getMessages, addMessage, clear, buildHistoryForClaude, trackTopic } from './history.js';
import { notify } from './notify.js';
import { listSkills } from './skills.js';
import { setSendFn, getCronSummary } from './crons.js';
import { appendConversation, getTodayNotes, getNotesForDate } from './daily-notes.js';
import { isConnected as isMcpConnected, smartIngest, setIntention } from './mcp-gateway.js';
import { createLogger, genRequestId } from './logger.js';
import { runHook, runHookAsync, runCommandHook, runPreChatPipeline, listPlugins, setPluginEnabled } from './plugins.js';
import { recordMessage, recordError, getHealthSnapshot } from './metrics.js';
import { checkCostAlert, formatCostReport } from './cost-analytics.js';
import { executeTask, getActiveTask } from './task-planner.js';

const log = createLogger('whatsapp');
const baileysLogger = pino({ level: 'warn' });

const MAX_CHUNK = config.maxChunk;
const COMPOSING_TIMEOUT_MS = config.composingTimeout;
const sentMessageIds = new Map(); // Track bot-sent messages { id → timestamp } to avoid loops

/** Track a sent message to avoid echo loops. */
function trackSent(result) {
  if (result?.key?.id) sentMessageIds.set(result.key.id, Date.now());
}
let currentSock = null; // Exposed for cron delivery

// --- Smart message batching (2s debounce) ---
const BATCH_DELAY_MS = config.batchDelay;
const pendingBatches = new Map(); // sender → { texts: [], timer, latestMsg }

// Prune sentMessageIds every 60s — remove entries older than 2 minutes
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [id, ts] of sentMessageIds) {
    if (ts < cutoff) sentMessageIds.delete(id);
  }
}, 60_000).unref();

async function sendWhatsAppMessage(text) {
  if (!currentSock) {
    log.warn('sendWhatsAppMessage called but no socket connected');
    return;
  }
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    const sent = await currentSock.sendMessage(config.allowedJid, { text: chunk });
    trackSent(sent);
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

function resolveFilePath(filePath, restrictToWorkspace = false) {
  let resolved;
  if (isAbsolute(filePath)) {
    resolved = resolve(filePath);
  } else {
    resolved = resolve(config.workspaceDir, filePath);
  }

  // When restricted (e.g. [SEND_FILE] markers from Claude), enforce workspace boundary
  if (restrictToWorkspace) {
    const workspacePrefix = resolve(config.workspaceDir);
    if (!resolved.startsWith(workspacePrefix)) {
      throw new Error(`Path "${filePath}" is outside workspace`);
    }
  }

  return resolved;
}

async function sendFileToWhatsApp(sock, jid, filePath, restrictToWorkspace = false) {
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

function chunkMessage(text) {
  if (text.length <= MAX_CHUNK) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > MAX_CHUNK) {
    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf('\n\n', MAX_CHUNK);
    if (splitIdx < MAX_CHUNK * 0.3) {
      // No good paragraph break, try single newline
      splitIdx = remaining.lastIndexOf('\n', MAX_CHUNK);
    }
    if (splitIdx < MAX_CHUNK * 0.3) {
      // No good newline, try space
      splitIdx = remaining.lastIndexOf(' ', MAX_CHUNK);
    }
    if (splitIdx < MAX_CHUNK * 0.3) {
      // Hard cut
      splitIdx = MAX_CHUNK;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

// --- Shared action helpers ---

async function sendReply(sock, sender, text) {
  const chunks = chunkMessage(text);
  for (const chunk of chunks) {
    const sent = await sock.sendMessage(sender, { text: chunk });
    trackSent(sent);
  }
}

async function executeAction(sock, sender, action, params = {}, botApi) {
  switch (action) {
    case 'clear':
      clear(sender);
      resetSession();
      await sendReply(sock, sender, 'History cleared, session reset.');
      return true;

    case 'help': {
      const help = `*I understand natural language!* Just talk to me normally.

Here's what I can do:
- Check bot status — "how are you?" / "מה המצב?"
- Show cron jobs — "show crons" / "מה מתוזמן?"
- Today's notes — "what happened today?" / "סיכום היום"
- List files — "show files" / "מה יש בתיקייה?"
- List skills — "what can you do?" / "מה אתה יודע?"
- Send files — "send me report.pdf" / "תשלח את הקובץ"
- Save URLs — "save this: https://..." / "שמור את הלינק"
- Clear history — "start fresh" / "נקה היסטוריה"
- Run multi-step tasks — "/task check all crons and fix broken ones"
- Manage crons, skills, code, memory — just ask!

_Shortcuts: /clear /status /crons /today /files /cost /export /task /tasks /plugins_`;
      await sendReply(sock, sender, help);
      return true;
    }

    case 'status': {
      const qStats = botApi?._queue?.stats() || { running: '?', waiting: '?' };
      const mcp = isMcpConnected() ? 'connected' : 'disconnected';
      const h = getHealthSnapshot();
      const t = h.tier_breakdown;
      const status = [
        `*Bot Status*`,
        `Uptime: ${h.uptime}`,
        `Memory: ${h.memory_mb}MB (heap: ${h.heap_mb}MB)`,
        `Model: ${config.claudeModel}`,
        `Queue: ${qStats.running} running, ${qStats.waiting} waiting`,
        `Vestige MCP: ${mcp}`,
        `Crons: ${getCronSummary().split('\n').length} jobs`,
        ``,
        `*Session stats:*`,
        `Messages: ${h.messages_in} in / ${h.messages_out} out`,
        `Claude calls: ${h.claude_calls}`,
        `Errors: ${h.errors}`,
        `Avg latency: ${h.avg_latency_ms}ms`,
        `Cost: $${h.cost_usd_session}`,
        `Tiers: T0:${t.t0} T1:${t.t1} T2:${t.t2} T3:${t.t3}`,
        h.last_message ? `Last msg: ${new Date(h.last_message).toLocaleTimeString('en-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' })}` : '',
      ].filter(Boolean).join('\n');
      await sendReply(sock, sender, status);
      return true;
    }

    case 'cost': {
      const period = params.period || 'today';
      await sendReply(sock, sender, formatCostReport(period));
      return true;
    }

    case 'export': {
      const messages = getMessages(sender);
      if (messages.length === 0) {
        await sendReply(sock, sender, 'No conversation history to export.');
        return true;
      }
      const lines = messages.map(m => {
        const time = m.ts ? new Date(m.ts).toLocaleTimeString('en-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }) : '??:??';
        const date = m.ts ? new Date(m.ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }) : '';
        const role = m.role === 'user' ? 'Ron' : 'Bot';
        return `[${date} ${time}] ${role}: ${m.content}`;
      });
      const header = `# Conversation Export\n# ${messages.length} messages\n# Exported: ${new Date().toISOString()}\n\n`;
      const content = header + lines.join('\n\n---\n\n');
      const exportPath = join(config.workspaceDir, `export-${Date.now()}.md`);
      try {
        mkdirSync(config.workspaceDir, { recursive: true });
        writeFileSync(exportPath, content);
        const sent = await sendFileToWhatsApp(sock, sender, exportPath, false);
        trackSent(sent);
        await sendReply(sock, sender, `Exported ${messages.length} messages.`);
      } catch (err) {
        await sendReply(sock, sender, `Export failed: ${err.message}`);
      }
      return true;
    }

    case 'plugins': {
      const all = listPlugins();
      if (all.length === 0) {
        await sendReply(sock, sender, 'No plugins loaded.');
      } else {
        const lines = all.map(p => {
          const status = p.enabled ? 'on' : 'off';
          const hooks = p.hooks.length > 0 ? p.hooks.join(', ') : 'none';
          return `${p.enabled ? '\u2705' : '\u26AA'} *${p.name}* v${p.version} [${status}]\n   ${p.description || 'No description'}\n   Hooks: ${hooks} | Priority: ${p.priority}`;
        });
        await sendReply(sock, sender, `*Plugins (${all.length}):*\n\n${lines.join('\n\n')}`);
      }
      return true;
    }

    case 'plugin-manage': {
      const { subCmd, name } = params;
      if (!subCmd || !name) {
        await sendReply(sock, sender, 'Usage: /plugin enable|disable <name>');
        return true;
      }
      if (subCmd !== 'enable' && subCmd !== 'disable') {
        await sendReply(sock, sender, `Unknown sub-command "${subCmd}". Use: /plugin enable|disable <name>`);
        return true;
      }
      const result = setPluginEnabled(name, subCmd === 'enable');
      if (!result) {
        await sendReply(sock, sender, `Plugin "${name}" not found.`);
      } else {
        await sendReply(sock, sender, `Plugin "${name}" ${result.enabled ? 'enabled' : 'disabled'}.`);
      }
      return true;
    }

    case 'tasks': {
      const task = getActiveTask();
      if (!task || !task.taskId) {
        await sendReply(sock, sender, 'No active or recent tasks.');
      } else {
        const elapsed = task.durationMs ? `${(task.durationMs / 1000).toFixed(0)}s` : `${((Date.now() - task.startedAt) / 1000).toFixed(0)}s`;
        const lines = [
          `*Task:* ${task.description?.slice(0, 100) || '(unknown)'}`,
          `*Status:* ${task.status || 'unknown'}`,
          `*Steps:* ${task.succeeded ?? '?'}/${task.steps ?? '?'} (${task.failed || 0} failed)`,
          `*Duration:* ${elapsed}`,
          task.costUsd ? `*Cost:* $${task.costUsd.toFixed(4)}` : '',
        ].filter(Boolean);
        await sendReply(sock, sender, lines.join('\n'));
      }
      return true;
    }

    case 'crons': {
      const summary = getCronSummary();
      await sendReply(sock, sender, `*Cron Jobs:*\n${summary}`);
      return true;
    }

    case 'today': {
      let notes;
      if (params.date) {
        notes = getNotesForDate(params.date) || `No notes for ${params.date}.`;
      } else {
        notes = getTodayNotes() || 'No notes yet today.';
      }
      await sendReply(sock, sender, notes);
      return true;
    }

    case 'files': {
      try {
        const files = readdirSync(config.workspaceDir);
        if (files.length === 0) {
          await sendReply(sock, sender, 'Workspace is empty.');
        } else {
          const listing = files.map(f => {
            try {
              const st = statSync(join(config.workspaceDir, f));
              const size = st.size < 1024 ? `${st.size}B`
                : st.size < 1048576 ? `${(st.size / 1024).toFixed(1)}KB`
                : `${(st.size / 1048576).toFixed(1)}MB`;
              return `• ${f} (${size})`;
            } catch { return `• ${f}`; }
          }).join('\n');
          await sendReply(sock, sender, `*Workspace files (${files.length}):*\n${listing}`);
        }
      } catch (err) {
        await sendReply(sock, sender, `Error: ${err.message}`);
      }
      return true;
    }

    case 'skills': {
      const names = listSkills();
      const reply = names.length
        ? `*Skills (${names.length}):*\n${names.map(n => `• ${n}`).join('\n')}`
        : 'No skills loaded.';
      await sendReply(sock, sender, reply);
      return true;
    }

    case 'send': {
      const file = params.file;
      if (!file) {
        await sendReply(sock, sender, 'Usage: /send <filename>');
        return true;
      }
      try {
        const sent = await sendFileToWhatsApp(sock, sender, file, true);
        trackSent(sent);
      } catch (err) {
        await sendReply(sock, sender, `Could not send: ${err.message}`);
      }
      return true;
    }

    default:
      return false;
  }
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

  function connectSocket() {
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      logger: baileysLogger,
      browser: ['WhatsApp Claude Bot', 'Chrome', '22.0'],
    });

    currentSock = sock;
    setSendFn(sendWhatsAppMessage);
    if (botApi) botApi.send = sendWhatsAppMessage;

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
          notify('🔴 *WhatsApp Claude Bot* logged out. Needs QR re-scan.');
          process.exit(1);
        }

        log.warn({ statusCode }, 'Disconnected, reconnecting in 3s...');
        notify('⚠️ *WhatsApp Claude Bot* disconnected. Reconnecting...');
        setTimeout(connectSocket, 3000);
      } else if (connection === 'open') {
        log.info('Connected successfully!');
        notify('🟢 *WhatsApp Claude Bot* is online.');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
      if (type !== 'notify') return;

      for (const msg of msgs) {
        const sender = msg.key?.remoteJid;
        if (!sender) continue;
        if (sentMessageIds.has(msg.key.id)) { sentMessageIds.delete(msg.key.id); continue; }
        if (!msg.message) continue;

        // Group messages: only respond when @mentioned or replied to
        if (sender.endsWith('@g.us')) {
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
          const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;
          const botJid = sock.user?.id?.replace(/:\d+@/, '@') || '';
          const isMentioned = mentions.some(jid => jid === botJid || jid?.replace(/:\d+@/, '@') === botJid);
          const isReplyToBot = quotedParticipant === botJid || quotedParticipant?.replace(/:\d+@/, '@') === botJid;
          const allowedGroups = (process.env.ALLOWED_GROUPS || '').split(',').filter(Boolean);
          const groupAllowed = allowedGroups.length === 0 || allowedGroups.some(g => sender.includes(g));

          if (!groupAllowed || (!isMentioned && !isReplyToBot)) continue;

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
        log.warn({ sender }, 'Ignored message from unauthorized');
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
  const text = msg.message?.conversation
    || msg.message?.extendedTextMessage?.text;
  if (!text) return;

  log.info({ sender, text: text.slice(0, 100) }, 'Incoming message');

  // Track conversation topics for context enrichment
  trackTopic(sender, text);

  // HOOK: onMessage — every message received
  runHook('onMessage', { sender, text, msg }, botApi);

  // --- Message routing (classifier → intent → action → Claude) ---
  const route = routeMessage(text);
  const tier = route.tier;

  if (route.type === 'action') {
    const handled = await executeAction(sock, sender, route.action, route.params, botApi);
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
    try {
      addMessage(sender, 'user', text);

      const sendProgress = async (progressText) => {
        const sent = await sock.sendMessage(sender, { text: progressText });
        trackSent(sent);
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

      const result = await executeTask(taskDesc, sendProgress, botContext);

      addMessage(sender, 'assistant', result.reply);
      appendConversation(text, result.reply, { costUsd: result.costUsd });
      checkCostAlert();

      clearWatchdog();
      await sock.sendPresenceUpdate('paused', sender);
      try { await sock.sendMessage(sender, { react: { text: '\u2705', key: msg.key } }); } catch {}
      recordMessage('out', { latencyMs: Date.now() - msgStart, costUsd: result.costUsd });
    } catch (err) {
      clearWatchdog();
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

      const { reply, costUsd } = await chatOneShot(prompt, onChunk);
      addMessage(sender, 'assistant', reply);
      appendConversation(text, reply, { costUsd });
      checkCostAlert();

      await sock.sendPresenceUpdate('paused', sender);
      recordMessage('out', { latencyMs: Date.now() - msgStart, costUsd });
    } catch (err) {
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

  try {
    // For group messages, prefix with sender info so Claude knows who's talking
    const chatText = groupCtx
      ? `[Group message from ${groupCtx.senderName}]: ${text}`
      : text;
    addMessage(sender, 'user', chatText);

    // Streaming chunk callback — format and send text to WhatsApp as it arrives
    const onChunk = async (chunk) => {
      const clean = formatForWhatsApp(chunk);
      if (!clean) return;
      const sent = await sock.sendMessage(sender, { text: clean });
      trackSent(sent);
      log.info({ chunkLen: clean.length }, 'Sent streamed chunk');
    };

    // Tool use progress callback — throttled to avoid message spam
    let lastToolMsg = 0;
    const TOOL_LABELS = {
      Bash: 'Running command...', Read: 'Reading files...', Write: 'Writing files...',
      Edit: 'Editing files...', Glob: 'Searching files...', Grep: 'Searching code...',
      WebSearch: 'Searching the web...', WebFetch: 'Fetching URL...',
      search: 'Searching memory...', smart_ingest: null, // silent
      intention: null, session_checkpoint: null,
    };
    const onToolUse = async (toolName) => {
      const now = Date.now();
      if (now - lastToolMsg < 10_000) return; // throttle: max 1 per 10s
      const label = TOOL_LABELS[toolName];
      if (label === null) return; // silent tools
      const progressText = label || `Using ${toolName}...`;
      lastToolMsg = now;
      try {
        const sent = await sock.sendMessage(sender, { text: `_${progressText}_` });
        trackSent(sent);
      } catch {}
    };

    // Get filtered conversation history (skips acks, enforces token budget)
    const history = buildHistoryForClaude(sender);

    // HOOK: preChat pipeline — plugins can modify text/add context
    const preChatResult = await runPreChatPipeline(chatText, history, botApi);

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

    log.info({ claudeMs, replyLen: reply.length, costUsd: costUsd?.toFixed(4), replyPreview: reply.slice(0, 200) }, 'MSG_REPLY: Claude responded');

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
              const desc = `${type === 'reminder' ? 'Remind Ron: ' : ''}${text.slice(0, 300)}`;
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
      friendlyMsg = 'Auth issue — Ron may need to check the credentials.';
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
    // --- Voice note: ask Claude to describe what to do (we note it's audio) ---
    else if (isVoiceNote) {
      const instruction = `I sent you a voice message (${sizeStr}). The audio file is saved at: workspace/${fileName}\n\nSince you can't listen to audio directly, just acknowledge you received a voice note and let me know you're ready for a text version of what I said.`;
      addMessage(sender, 'user', instruction);
      recordMessage('in', { tier: 1 });
      log.info({ fileName, size: sizeStr }, 'Voice note received');
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
