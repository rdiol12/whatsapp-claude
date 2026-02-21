import { readFileSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { createLogger } from './logger.js';
import { writeFileAtomic } from './resilience.js';

const log = createLogger('history');
const HISTORY_FILE = join(config.dataDir, 'conversations.json');

// --- History compression ---
const COMPRESS_THRESHOLD = 40;
const KEEP_RAW = 10;

// In-memory store keyed by JID
let store = {};

// --- Debounced persistence ---
let dirty = false;
let saveTimer = null;
const SAVE_DEBOUNCE_MS = 5000;

function scheduleSave() {
  dirty = true;
  if (!saveTimer) {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) { save(); dirty = false; }
    }, SAVE_DEBOUNCE_MS);
    saveTimer.unref();
  }
}

/** Flush pending writes immediately (call on shutdown). */
export function flushHistory() {
  if (dirty) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    save();
    dirty = false;
  }
}

// --- Topic tracking ---
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can', 'may', 'might',
  'and', 'or', 'but', 'if', 'then', 'that', 'this', 'these', 'those', 'what', 'how',
  'why', 'when', 'where', 'who', 'which', 'just', 'also', 'very', 'really', 'please',
  'check', 'show', 'tell', 'give', 'let', 'make', 'get', 'about', 'with', 'from',
  'into', 'some', 'any', 'all', 'not', 'you', 'your', 'want', 'need', 'like',
]);
const recentTopics = new Map(); // jid → string[]

export function trackTopic(jid, text) {
  // Extract meaningful words: capitalized words, long words, known project names
  const words = text.match(/\b[A-Z][a-z]{3,}\b|\b\w{5,}\b/g) || [];
  const filtered = words
    .map(w => w.toLowerCase())
    .filter(w => !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .slice(0, 3);
  if (filtered.length === 0) return;
  const topics = recentTopics.get(jid) || [];
  topics.push(...filtered);
  // Keep unique, last 10
  recentTopics.set(jid, [...new Set(topics)].slice(-10));
}

export function getRecentTopics(jid) {
  return recentTopics.get(jid) || [];
}

export function load() {
  try {
    const raw = readFileSync(HISTORY_FILE, 'utf-8');
    store = JSON.parse(raw);
    log.info('Loaded conversation history');
  } catch (err) {
    store = {};
    if (err.code === 'ENOENT') {
      log.info('Starting fresh (no history file)');
    } else {
      // Corruption or parse error — log details for debugging
      let fileSize;
      try { fileSize = statSync(HISTORY_FILE).size; } catch { fileSize = 'unknown'; }
      const preview = typeof err.message === 'string' ? err.message : String(err);
      log.warn({ err: preview, fileSize }, 'History file corrupted, starting fresh');
    }
  }
}

function save(jid) {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileAtomic(HISTORY_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    const storeSize = jid && store[jid] ? store[jid].length : undefined;
    log.error({ err: err.message, jid, storeSize }, 'Failed to save conversation');
  }
}

export function getMessages(jid) {
  return store[jid] || [];
}

export function addMessage(jid, role, content) {
  if (!store[jid]) store[jid] = [];

  store[jid].push({ role, content, ts: Date.now() });

  // Trim to max history
  if (store[jid].length > config.maxHistory) {
    const removeCount = store[jid].length - config.maxHistory;
    const droppedRoles = store[jid].slice(0, removeCount).map(m => m.role);
    store[jid] = store[jid].slice(-config.maxHistory);
    log.warn({ jid, removed: removeCount, remaining: store[jid].length, droppedRoles }, 'Conversation trimmed');
  }

  // Ensure first message is always "user" role (Anthropic API requirement)
  let leadingRemoved = 0;
  while (store[jid].length > 0 && store[jid][0].role !== 'user') {
    store[jid].shift();
    leadingRemoved++;
  }
  if (leadingRemoved > 0) {
    log.warn({ jid, removed: leadingRemoved, remaining: store[jid].length }, 'Leading non-user messages removed');
  }

  // Compress older messages when conversation grows long
  if (store[jid].length > COMPRESS_THRESHOLD) {
    compressOlderMessages(jid);
  }

  scheduleSave();
}

// Acknowledgment pattern — messages that don't add context
const ACK_RE = /^(ok|okay|k|sure|thanks|thx|thank you|cool|nice|got it|yep|yea|nah|lol|haha|np|ty|gg|bet|word|aight|אוקיי?|תודה|סבבה|יפה|טוב|בסדר|לול|חחח|נייס|אחלה|מעולה|תותח|קול|\[acknowledged\])[\s!.]*$/i;

// Patterns that indicate the assistant message contains a decision or action
const DECISION_RE = /\b(decided|chose|using|switched|set up|configured|created|deleted|installed|will use|going with|plan is)\b|החלטנו|נלך על|הגדרתי|יצרתי|מחקתי|שינו?תי/i;

/**
 * Compress older messages into a recap, keeping the last KEEP_RAW messages raw.
 * Called when conversation exceeds COMPRESS_THRESHOLD messages.
 */
function compressOlderMessages(jid) {
  const msgs = store[jid];
  if (!msgs || msgs.length <= KEEP_RAW) return;

  // Already has a compressed recap at the front — skip if recent enough
  if (msgs[0]?._compressed && msgs.length <= COMPRESS_THRESHOLD + 5) return;

  const toCompress = msgs.slice(0, msgs.length - KEEP_RAW);
  const toKeep = msgs.slice(msgs.length - KEEP_RAW);

  // Extract topic words (capitalized or long words, skip stopwords)
  const topicSet = new Set();
  for (const m of toCompress) {
    const words = m.content.match(/\b[A-Z][a-z]{3,}\b|\b\w{5,}\b/g) || [];
    for (const w of words) {
      const lower = w.toLowerCase();
      if (!STOPWORDS.has(lower) && !/^\d+$/.test(lower)) topicSet.add(lower);
    }
  }
  const topics = [...topicSet].slice(0, 15);

  // Extract decision sentences
  const decisions = [];
  for (const m of toCompress) {
    if (m.role === 'assistant' && DECISION_RE.test(m.content)) {
      // Take first sentence containing a decision keyword
      const sentences = m.content.split(/[.!?\n]+/).filter(s => DECISION_RE.test(s));
      for (const s of sentences) {
        const trimmed = s.trim().slice(0, 120);
        if (trimmed.length > 10) decisions.push(trimmed);
      }
    }
  }
  const uniqueDecisions = [...new Set(decisions)].slice(0, 8);

  // Sample exchanges: every 5th user-assistant pair, max 5
  const samples = [];
  for (let i = 0; i < toCompress.length - 1 && samples.length < 5; i += 10) {
    if (toCompress[i]?.role === 'user' && toCompress[i + 1]?.role === 'assistant') {
      const q = toCompress[i].content.slice(0, 80);
      const a = toCompress[i + 1].content.slice(0, 80);
      samples.push(`Q: ${q}\nA: ${a}`);
    }
  }

  // Build recap
  const parts = [`[Conversation summary: ${toCompress.length} messages compressed]`];
  if (topics.length > 0) parts.push(`Topics: ${topics.join(', ')}`);
  if (uniqueDecisions.length > 0) parts.push(`Key decisions:\n- ${uniqueDecisions.join('\n- ')}`);
  if (samples.length > 0) parts.push(`Sample exchanges:\n${samples.join('\n---\n')}`);
  const recap = parts.join('\n');

  // Replace compressed messages with a single recap message
  store[jid] = [
    { role: 'user', content: recap, ts: Date.now(), _compressed: true },
    ...toKeep,
  ];

  log.info({ jid, compressed: toCompress.length, kept: toKeep.length, recapLen: recap.length }, 'History compressed');
  scheduleSave();
}

/** Estimate tokens — Hebrew/code averages ~3.3 chars/token, English ~4 */
function estimateTokens(text) {
  const hebrewChars = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const ratio = hebrewChars > text.length * 0.3 ? 3.3 : 4;
  return Math.ceil(text.length / ratio);
}

/**
 * Build a filtered history for Claude. Removes low-value messages
 * to maximize context quality within a token budget.
 * - Always includes last 5 messages
 * - Skips acknowledgments from older messages (unless they confirm a decision)
 * - Summarizes gaps where acks were removed
 */
export function buildHistoryForClaude(jid, maxTokens = 8000) {
  const raw = store[jid] || [];
  if (raw.length <= 5) return raw.map(m => ({ role: m.role, content: m.content }));

  const recent = raw.slice(-5); // always keep last 5
  const older = raw.slice(0, -5);

  const filtered = [];
  let skipped = 0;

  for (let i = 0; i < older.length; i++) {
    const msg = older[i];
    const isAck = msg.role === 'user' && ACK_RE.test(msg.content.trim());
    const isAckReply = msg.role === 'assistant' && msg.content === '[acknowledged]';

    if (isAck || isAckReply) {
      // Keep acks that confirm a decision in the previous assistant message
      const prev = i > 0 ? older[i - 1] : null;
      if (isAck && prev?.role === 'assistant' && DECISION_RE.test(prev.content)) {
        // This ack confirms a decision — keep it
        if (skipped > 0) {
          filtered.push({ role: 'user', content: `[${skipped} brief exchanges]` });
          skipped = 0;
        }
        filtered.push({ role: msg.role, content: msg.content });
        continue;
      }
      skipped++;
      continue;
    }

    // If we skipped some, note the gap
    if (skipped > 0) {
      filtered.push({ role: 'user', content: `[${skipped} brief exchanges]` });
      skipped = 0;
    }

    filtered.push({ role: msg.role, content: msg.content });
  }

  if (skipped > 0) {
    filtered.push({ role: 'user', content: `[${skipped} brief exchanges]` });
  }

  const result = [...filtered, ...recent.map(m => ({ role: m.role, content: m.content }))];

  // Token budget enforcement
  let totalTokens = result.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  while (totalTokens > maxTokens && result.length > 5) {
    const removed = result.shift();
    totalTokens -= estimateTokens(removed.content);
  }

  // Ensure first message is user role
  while (result.length > 0 && result[0].role !== 'user') {
    result.shift();
  }

  return result;
}

export function clear(jid) {
  const prevLen = store[jid]?.length || 0;
  store[jid] = [];
  // Clear is explicit — flush immediately
  dirty = true;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  save();
  dirty = false;
  log.info({ jid, previousLen: prevLen }, 'History cleared');
}
