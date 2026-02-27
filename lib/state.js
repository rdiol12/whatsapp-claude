import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { createLogger } from './logger.js';
import { cleanupOrphanedTempFiles } from './resilience.js';
import { kvGet, kvSet } from './db.js';

const log = createLogger('state');
const STATE_DIR = join(config.dataDir, 'state');

// Keep state dir for backward-compat: existing JSON files serve as read fallback
// until all keys have been written at least once to SQLite (M3/M4 completes migration).
mkdirSync(STATE_DIR, { recursive: true });
cleanupOrphanedTempFiles(STATE_DIR);

// --- In-memory cache (write-through to SQLite) ---
// Safe from race conditions: all DB operations are synchronous (better-sqlite3),
// so the single-threaded event loop cannot interleave reads and writes.
const cache = new Map();

function readFromDisk(key) {
  try {
    const raw = readFileSync(join(STATE_DIR, `${key}.json`), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Get a state object by key (e.g., 'agent-loop').
 * SQLite is the primary store; falls back to legacy JSON file on first access
 * if no SQLite entry exists yet (backward-compat during migration).
 */
export function getState(key) {
  if (cache.has(key)) return cache.get(key);
  const fromDb = kvGet(key);
  const data = fromDb !== null ? fromDb : readFromDisk(key);
  cache.set(key, data);
  return data;
}

/**
 * Save a state object to SQLite. Shallow-merges with existing state.
 */
export function setState(key, data) {
  const existing = getState(key);
  const merged = { ...existing, ...data, updatedAt: Date.now() };
  cache.set(key, merged);
  kvSet(key, merged);
  return merged;
}

/**
 * Update a single field in a state object.
 */
export function updateStateField(key, field, value) {
  const existing = getState(key);
  existing[field] = value;
  existing.updatedAt = Date.now();
  cache.set(key, existing);
  kvSet(key, existing);
  return existing;
}

/**
 * Increment a numeric counter in state.
 */
export function incrementState(key, field, amount = 1) {
  const existing = getState(key);
  existing[field] = (existing[field] || 0) + amount;
  existing.updatedAt = Date.now();
  cache.set(key, existing);
  kvSet(key, existing);
  return existing;
}
