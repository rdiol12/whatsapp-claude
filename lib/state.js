import { readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { createLogger } from './logger.js';
import { writeFileAtomic } from './resilience.js';

const log = createLogger('state');
const STATE_DIR = join(config.dataDir, 'state');

// Ensure state dir exists
mkdirSync(STATE_DIR, { recursive: true });

// --- In-memory cache (write-through) ---
const cache = new Map();

function readFromDisk(key) {
  try {
    const raw = readFileSync(join(STATE_DIR, `${key}.json`), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeToDisk(key, data) {
  try {
    writeFileAtomic(join(STATE_DIR, `${key}.json`), JSON.stringify(data, null, 2));
  } catch (err) {
    log.error({ key, err: err.message }, 'Failed to save state');
  }
}

/**
 * Get a state object by key (e.g., 'heartbeat', 'cost-tracker').
 * Returns {} if not found. Reads from disk only on first access per key.
 */
export function getState(key) {
  if (cache.has(key)) return cache.get(key);
  const data = readFromDisk(key);
  cache.set(key, data);
  return data;
}

/**
 * Save a state object. Merges with existing state (shallow merge).
 */
export function setState(key, data) {
  const existing = getState(key);
  const merged = { ...existing, ...data, updatedAt: Date.now() };
  cache.set(key, merged);
  writeToDisk(key, merged);
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
  writeToDisk(key, existing);
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
  writeToDisk(key, existing);
  return existing;
}
