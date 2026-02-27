/**
 * lib/db.js — SQLite database singleton via better-sqlite3.
 *
 * Provides the shared database connection and schema initialization.
 * All tables are created here; individual modules (goals.js, crons.js, etc.)
 * import `getDb()` and query against it.
 *
 * Migration plan:
 *   M1 (this file): schema + singleton
 *   M2: migrate history.js, goals.js, crons.js, user-notes.js
 *   M3: migrate remaining state files
 *   M4: one-time import of existing JSON data
 */

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';
import { notify } from './notify.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const log = createLogger('db');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'sela.db');

let _db = null;

// ─── Singleton ───────────────────────────────────────────────────────────────

export function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');   // concurrent reads + crash-safe writes
    _db.pragma('foreign_keys = ON');
    _db.pragma('synchronous = NORMAL'); // fsync after WAL checkpoint, not every write
    initSchema(_db);
    log.info({ path: DB_PATH }, 'SQLite database opened');
  }
  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
    log.info('SQLite database closed');
  }
}

// ─── Schema ──────────────────────────────────────────────────────────────────

function initSchema(db) {
  db.exec(`
    -- Key-value store: replaces data/state/*.json files
    CREATE TABLE IF NOT EXISTS kv_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,           -- JSON serialized
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- Conversation history: replaces data/conversations.json
    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,           -- full JSON blob (backward compat)
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- Goals: replaces data/goals.json
    CREATE TABLE IF NOT EXISTS goals (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      priority    TEXT NOT NULL DEFAULT 'medium',
      progress    INTEGER NOT NULL DEFAULT 0,
      milestones  TEXT NOT NULL DEFAULT '[]',  -- JSON array
      log         TEXT NOT NULL DEFAULT '[]',  -- JSON array
      linked_topics TEXT NOT NULL DEFAULT '[]', -- JSON array
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- Crons: replaces data/crons.json
    CREATE TABLE IF NOT EXISTS crons (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      schedule    TEXT NOT NULL,
      tz          TEXT NOT NULL DEFAULT 'Asia/Jerusalem', -- runtime timezone from config.timezone
      prompt      TEXT NOT NULL,
      delivery    TEXT NOT NULL DEFAULT 'announce',
      model       TEXT,
      created_at  INTEGER NOT NULL,
      state       TEXT NOT NULL DEFAULT '{}'   -- JSON: nextRun, lastRun, lastStatus, etc.
    );

    -- User notes: replaces data/user-notes.json
    CREATE TABLE IF NOT EXISTS user_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      content    TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    -- Message history: replaces the messages portion of conversations
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role       TEXT NOT NULL,        -- 'user' | 'assistant'
      content    TEXT NOT NULL,
      ts         INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      metadata   TEXT                 -- optional JSON (model, cost, etc.)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, ts);

    -- Cost tracking: replaces data/costs.jsonl
    CREATE TABLE IF NOT EXISTS costs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT,
      model      TEXT,
      input_tokens  INTEGER,
      output_tokens INTEGER,
      cache_read INTEGER,
      cost_usd   REAL NOT NULL,
      duration_ms INTEGER,
      cron_id    TEXT,
      session_id TEXT,
      ts         INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_costs_ts ON costs (ts);

    -- Errors: track failures, exceptions, and issues
    CREATE TABLE IF NOT EXISTS errors (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      severity   TEXT NOT NULL DEFAULT 'error',  -- 'info', 'warning', 'error', 'critical'
      module     TEXT NOT NULL,                  -- where error occurred (e.g., 'goals.js', 'crons.js')
      message    TEXT NOT NULL,
      stack      TEXT,                           -- stack trace if available
      context    TEXT,                           -- JSON: request_id, session_id, etc.
      resolved   INTEGER NOT NULL DEFAULT 0,     -- 1 = acknowledged/fixed
      ts         INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_errors_ts ON errors (ts);
    CREATE INDEX IF NOT EXISTS idx_errors_severity ON errors (severity, ts);

    -- Reply outcomes: link each bot message to user's next response
    CREATE TABLE IF NOT EXISTS reply_outcomes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_msg_id    TEXT NOT NULL,          -- random hex ID assigned at send time
      signal        TEXT,                   -- what context triggered the reply (e.g. 'agent_cycle', 'cron')
      sentiment     TEXT,                   -- 'positive', 'negative', or NULL
      user_response TEXT,                   -- user's reply text (max 200 chars), NULL if no response
      window_ms     INTEGER,                -- ms between bot send and user reply
      ts            INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_reply_outcomes_ts ON reply_outcomes (ts);

    -- Reasoning journal: hypothesis → evidence → conclusion tracking (Phase 1)
    CREATE TABLE IF NOT EXISTS reasoning_journal (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_num    INTEGER NOT NULL,
      hypothesis   TEXT NOT NULL,
      evidence     TEXT NOT NULL DEFAULT '[]',
      conclusion   TEXT,
      status       TEXT NOT NULL DEFAULT 'open',
      signal_type  TEXT,
      confidence   REAL NOT NULL DEFAULT 0.5,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      concluded_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_reasoning_status ON reasoning_journal(status, created_at);

    -- Capability gaps: tracks repeated "I can't do X" patterns (Phase 6)
    CREATE TABLE IF NOT EXISTS capability_gaps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      topic       TEXT NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1,
      last_seen   INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      first_seen  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      status      TEXT NOT NULL DEFAULT 'detected',
      skill_slug  TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_gaps_topic ON capability_gaps(topic, status);

    -- Experiments: A/B testing framework for agent behavior (Phase 7)
    CREATE TABLE IF NOT EXISTS experiments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      hypothesis       TEXT NOT NULL,
      metric           TEXT NOT NULL,
      baseline_value   REAL,
      current_value    REAL,
      duration_hours   INTEGER NOT NULL DEFAULT 168,
      revert_threshold REAL NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      change_description TEXT,
      revert_action    TEXT,
      conclusion       TEXT,
      reasoning_id     INTEGER,
      started_at       INTEGER,
      concluded_at     INTEGER,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);
  `);

  // Additive migrations (idempotent — safe to run every startup)
  try { db.exec('ALTER TABLE reply_outcomes ADD COLUMN classification TEXT'); } catch {}
  try { db.exec("ALTER TABLE goals ADD COLUMN category TEXT NOT NULL DEFAULT 'project'"); } catch {}
  try { db.exec('ALTER TABLE goals ADD COLUMN parent_goal_id TEXT'); } catch {}

  // FTS5 full-text search index for message history (f8a2329d — conversation search)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS messages_fts_insert
        AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_delete
        AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END;

      CREATE TRIGGER IF NOT EXISTS messages_fts_update
        AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
    `);
    // Populate FTS index for any existing rows (idempotent via content= external table)
    const ftsCount = db.prepare('SELECT COUNT(*) as cnt FROM messages_fts').get().cnt;
    if (ftsCount === 0) {
      const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages').get().cnt;
      if (msgCount > 0) {
        db.exec("INSERT INTO messages_fts(rowid, content) SELECT id, content FROM messages");
        log.info({ rows: msgCount }, 'FTS5 index populated for messages');
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, 'FTS5 migration skipped (non-fatal)');
  }
}

// ─── kv_state helpers (direct replacement for lib/state.js) ─────────────────

export function kvGet(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM kv_state WHERE key = ?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function kvSet(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), Date.now());
}

export function kvDelete(key) {
  getDb().prepare('DELETE FROM kv_state WHERE key = ?').run(key);
}

// ─── Error logging helpers ───────────────────────────────────────────────────

export function logError(severity, module, message, stack = null, context = null, sendAlert = true) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO errors (severity, module, message, stack, context)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    severity,
    module,
    message,
    stack,
    context ? JSON.stringify(context) : null
  );

  // Send Telegram alert for critical errors
  if (sendAlert && severity === 'critical') {
    try {
      const alertMsg = `🚨 *CRITICAL ERROR*\n*Module:* ${module}\n*Message:* ${message.slice(0, 200)}`;
      notify(alertMsg);
    } catch (e) {
      log.error({ err: e.message }, 'Failed to send error alert');
    }
  }

  return result;
}

export function getErrors(limit = 50, offset = 0, severity = null) {
  const db = getDb();
  const query = severity
    ? 'SELECT * FROM errors WHERE severity = ? ORDER BY ts DESC LIMIT ? OFFSET ?'
    : 'SELECT * FROM errors ORDER BY ts DESC LIMIT ? OFFSET ?';
  const params = severity ? [severity, limit, offset] : [limit, offset];
  return db.prepare(query).all(...params);
}

export function markErrorResolved(errorId) {
  const db = getDb();
  return db.prepare('UPDATE errors SET resolved = 1 WHERE id = ?').run(errorId);
}

// ─── Cost tracking helpers ───────────────────────────────────────────────────

/**
 * Write a cost entry to the SQLite costs table.
 * Called from claude.js alongside the existing JSONL write (dual-write phase).
 */
export function insertCost({ type, model, inputTokens, outputTokens, cacheRead, costUsd, durationMs, cronId, sessionId, ts } = {}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO costs (type, model, input_tokens, output_tokens, cache_read, cost_usd, duration_ms, cron_id, session_id, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    type ?? null,
    model ?? null,
    inputTokens ?? 0,
    outputTokens ?? 0,
    cacheRead ?? 0,
    costUsd ?? 0,
    durationMs ?? null,
    cronId ?? null,
    sessionId ?? null,
    ts ?? Date.now()
  );
}

/**
 * Summarise costs from SQLite. Returns {total, count, inputTokens, outputTokens} for a time range.
 * @param {number} sinceMs  Unix timestamp (ms) — only rows at or after this time
 */
export function getCostsSince(sinceMs) {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(cost_usd), 0) as total,
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(cache_read), 0) as cacheRead
    FROM costs WHERE ts >= ?
  `).get(sinceMs);
  return row;
}

/**
 * Get per-day cost breakdown from SQLite.
 * Groups entries by calendar day in Israel time (UTC+2).
 *
 * @param {number} sinceMs   Unix timestamp (ms) — start of range
 * @param {number} [untilMs] Unix timestamp (ms) — end of range (optional, defaults to now)
 * @returns {Array<{ day: string, costUsd: number, inputTokens: number, outputTokens: number, cacheRead: number, count: number }>}
 */
export function getCostsByDay(sinceMs, untilMs = null) {
  const db = getDb();
  const query = untilMs
    ? `SELECT date(ts/1000.0, 'unixepoch', '+2 hours') as day,
         COALESCE(SUM(cost_usd), 0) as costUsd,
         COALESCE(SUM(input_tokens), 0) as inputTokens,
         COALESCE(SUM(output_tokens), 0) as outputTokens,
         COALESCE(SUM(cache_read), 0) as cacheRead,
         COUNT(*) as count
       FROM costs WHERE ts >= ? AND ts <= ?
       GROUP BY day ORDER BY day DESC`
    : `SELECT date(ts/1000.0, 'unixepoch', '+2 hours') as day,
         COALESCE(SUM(cost_usd), 0) as costUsd,
         COALESCE(SUM(input_tokens), 0) as inputTokens,
         COALESCE(SUM(output_tokens), 0) as outputTokens,
         COALESCE(SUM(cache_read), 0) as cacheRead,
         COUNT(*) as count
       FROM costs WHERE ts >= ?
       GROUP BY day ORDER BY day DESC`;
  const params = untilMs ? [sinceMs, untilMs] : [sinceMs];
  return db.prepare(query).all(...params);
}

/**
 * Get the earliest timestamp (ms) of any cost entry in SQLite.
 * Returns null if the table is empty.
 */
export function getEarliestCostTs() {
  const db = getDb();
  const row = db.prepare('SELECT MIN(ts) as minTs FROM costs').get();
  return row?.minTs ?? null;
}

/**
 * Bulk insert cost entries (for one-time JSONL import).
 * Wraps inserts in a transaction for speed.
 *
 * @param {Array<object>} entries  Array of cost entry objects (same shape as insertCost)
 * @returns {number}  Number of rows inserted
 */
export function bulkInsertCosts(entries) {
  if (!entries || entries.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO costs (type, model, input_tokens, output_tokens, cache_read, cost_usd, duration_ms, cron_id, session_id, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows) => {
    let count = 0;
    for (const e of rows) {
      stmt.run(
        e.type ?? null,
        e.model ?? null,
        e.inputTokens ?? 0,
        e.outputTokens ?? 0,
        e.cacheRead ?? 0,
        e.costUsd ?? 0,
        e.durationMs ?? null,
        e.cronId ?? null,
        e.sessionId ?? null,
        e.ts ?? Date.now()
      );
      count++;
    }
    return count;
  });
  return insertMany(entries);
}

// ─── Reply outcome helpers ────────────────────────────────────────────────────

export function logReplyOutcome({ botMsgId, signal, sentiment, classification, userResponse, windowMs }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO reply_outcomes (bot_msg_id, signal, sentiment, classification, user_response, window_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(botMsgId, signal || null, sentiment || null, classification || null, userResponse || null, windowMs || null);
}

export function getReplyOutcomeStats(days = 7) {
  const db = getDb();
  const since = Date.now() - days * 86400_000;
  const rows = db.prepare('SELECT sentiment, COUNT(*) as cnt FROM reply_outcomes WHERE ts >= ? GROUP BY sentiment').all(since);
  const total = db.prepare('SELECT COUNT(*) as cnt FROM reply_outcomes WHERE ts >= ?').get(since)?.cnt || 0;
  const bySignal = db.prepare('SELECT signal, COUNT(*) as cnt, SUM(CASE WHEN sentiment = \'positive\' THEN 1 ELSE 0 END) as pos FROM reply_outcomes WHERE ts >= ? GROUP BY signal').all(since);
  return { total, breakdown: rows, bySignal };
}

/**
 * Aggregate reply_outcomes by message classification type and topic.
 * Returns per-type and per-topic positive/negative/neutral rates.
 * Only rows with a classification JSON are included.
 */
export function aggregateReplyPatterns(days = 30) {
  const db = getDb();
  const since = Date.now() - days * 86400_000;
  const rows = db.prepare(
    'SELECT classification, sentiment FROM reply_outcomes WHERE ts >= ? AND classification IS NOT NULL'
  ).all(since);

  const byType = {};   // { question: { pos, neg, total }, ... }
  const byTopic = {};  // { goals: { pos, neg, total }, ... }

  for (const row of rows) {
    let cls;
    try { cls = JSON.parse(row.classification); } catch { continue; }
    const { type, topics = [] } = cls;
    const sentiment = row.sentiment; // 'positive', 'negative', or null

    if (type) {
      if (!byType[type]) byType[type] = { positive: 0, negative: 0, neutral: 0 };
      if (sentiment === 'positive') byType[type].positive++;
      else if (sentiment === 'negative') byType[type].negative++;
      else byType[type].neutral++;
    }

    for (const topic of topics) {
      if (!byTopic[topic]) byTopic[topic] = { positive: 0, negative: 0, neutral: 0 };
      if (sentiment === 'positive') byTopic[topic].positive++;
      else if (sentiment === 'negative') byTopic[topic].negative++;
      else byTopic[topic].neutral++;
    }
  }

  return { total: rows.length, byType, byTopic };
}
