/**
 * User Notes — persistent personal notes/reminders.
 * Stored in data/user-notes.json, injected into bot context.
 * Follows the same load/save pattern as goals.js.
 */

import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { createLogger } from './logger.js';
import { writeFileAtomic } from './resilience.js';
import { smartIngest } from './mcp-gateway.js';
import { getDb } from './db.js';

const log = createLogger('user-notes');
const NOTES_FILE = join(config.dataDir, 'user-notes.json');

let notes = [];

// --- Database operations ---

function noteToDb(note) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO user_notes (content, created_at)
    VALUES (?, ?)
  `).run(note.text, note.createdAt);
  return String(result.lastInsertRowid);
}

function dbNoteToObject(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    text: row.content,
    createdAt: row.created_at,
  };
}

// --- Persistence ---

export function load() {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT id, content, created_at FROM user_notes ORDER BY created_at DESC').all();
    notes = rows.map(dbNoteToObject);
    log.info({ count: notes.length }, 'Loaded user notes from SQLite');

    // On first run, migrate old JSON data to SQLite if it exists
    if (notes.length === 0) {
      try {
        const raw = readFileSync(NOTES_FILE, 'utf-8');
        const data = JSON.parse(raw);
        const oldNotes = data.notes || [];
        for (const note of oldNotes) {
          noteToDb(note);
        }
        const migrated = db.prepare('SELECT id, content, created_at FROM user_notes ORDER BY created_at DESC').all();
        notes = migrated.map(dbNoteToObject);
        log.info({ count: notes.length }, 'Migrated user notes from JSON to SQLite');
      } catch (migErr) {
        if (migErr.code !== 'ENOENT') {
          log.warn({ err: migErr.message }, 'Error migrating old user notes');
        }
      }
    }
  } catch (err) {
    notes = [];
    log.error({ err: err.message }, 'Failed to load user notes from SQLite');
  }
}

function save() {
  try {
    // Each note is saved to DB inline after updates (see noteToDb)
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save user notes');
  }
}

// --- CRUD ---

export function addNote(text) {
  const note = { text: text.trim(), createdAt: Date.now() };
  const id = noteToDb(note);
  note.id = id;
  notes.unshift(note); // newest first
  log.info({ id, textLen: note.text.length }, 'Note added');

  // Auto-index into Vestige for semantic search (async, non-blocking)
  if (note.text.length >= 10) {
    smartIngest(
      `[user-note] ${note.text}`,
      ['user-note', 'personal'], 'personal', 'user-notes'
    ).catch(err => {
      log.debug({ err: err?.message, id }, 'Vestige auto-index failed (non-critical)');
    });
  }

  return note;
}

export function deleteNote(id) {
  const idx = notes.findIndex(n => n.id === id);
  if (idx === -1) return null;
  const [removed] = notes.splice(idx, 1);
  const db = getDb();
  db.prepare('DELETE FROM user_notes WHERE id = ?').run(id);
  log.info({ id }, 'Note deleted');
  return removed;
}

export function listNotes() {
  return notes;
}

/**
 * Build a compact context block for bot injection.
 * Returns recent notes formatted for Claude context, or empty string.
 */
export function getNotesContext() {
  if (notes.length === 0) return '';
  const MAX_NOTES = config.userNotesMaxPerSession;
  const MAX_CHARS = config.userNotesMaxChars;
  const recent = notes.slice(0, MAX_NOTES);
  const lines = recent.map(n => {
    const date = new Date(n.createdAt).toLocaleString('en-CA', {
      timeZone: config.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const text = n.text.length > MAX_CHARS ? n.text.slice(0, MAX_CHARS) + '...' : n.text;
    return `- ${date}: ${text}`;
  });
  return lines.join('\n');
}

// Load on import
load();
