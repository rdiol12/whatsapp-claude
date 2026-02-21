/**
 * User Notes — persistent personal notes/reminders.
 * Stored in data/user-notes.json, injected into bot context.
 * Follows the same load/save pattern as goals.js.
 */

import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import config from './config.js';
import { createLogger } from './logger.js';
import { writeFileAtomic } from './resilience.js';

const log = createLogger('user-notes');
const NOTES_FILE = join(config.dataDir, 'user-notes.json');

let notes = [];

// --- Persistence ---

export function load() {
  try {
    const raw = readFileSync(NOTES_FILE, 'utf-8');
    const data = JSON.parse(raw);
    notes = data.notes || [];
    log.info({ count: notes.length }, 'Loaded user notes');
  } catch (err) {
    notes = [];
    if (err.code === 'ENOENT') {
      log.info('No user-notes file, starting fresh');
    } else {
      log.warn({ err: err.message }, 'User-notes file corrupted, starting fresh');
    }
  }
}

function save() {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileAtomic(NOTES_FILE, JSON.stringify({ notes }, null, 2));
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save user notes');
  }
}

// --- CRUD ---

export function addNote(text) {
  const id = randomBytes(4).toString('hex');
  const note = { id, text: text.trim(), createdAt: Date.now() };
  notes.unshift(note); // newest first
  save();
  log.info({ id, textLen: note.text.length }, 'Note added');
  return note;
}

export function deleteNote(id) {
  const idx = notes.findIndex(n => n.id === id);
  if (idx === -1) return null;
  const [removed] = notes.splice(idx, 1);
  save();
  log.info({ id }, 'Note deleted');
  return removed;
}

export function listNotes() {
  return notes;
}

/**
 * Build a compact context block for bot injection.
 * Returns last 10 notes formatted for Claude context, or empty string.
 */
export function getNotesContext() {
  if (notes.length === 0) return '';
  const MAX_NOTES = 5;
  const MAX_CHARS = 200;
  const recent = notes.slice(0, MAX_NOTES);
  const lines = recent.map(n => {
    const date = new Date(n.createdAt).toLocaleString('en-CA', {
      timeZone: 'Asia/Jerusalem',
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
