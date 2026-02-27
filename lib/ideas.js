/**
 * Ideas — persistent idea tracker for Sela improvements.
 * Stored in data/ideas.json. Dashboard-only feature.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { createLogger } from './logger.js';
import { writeFileAtomic } from './resilience.js';

const log = createLogger('ideas');
const IDEAS_FILE = join(config.dataDir, 'ideas.json');

const CATEGORIES = ['improvement', 'agent-feature'];
const PRIORITIES = ['high', 'medium', 'low'];
const STATUSES = ['proposed', 'in_progress', 'done', 'skipped'];
const MAX_TITLE = 200;
const MAX_DESC = 2000;

let ideas = [];
let nextId = 1;

// --- Persistence ---

export function load() {
  try {
    const raw = readFileSync(IDEAS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    ideas = data.ideas || [];
    nextId = data.nextId || (ideas.length ? Math.max(...ideas.map(i => i.id)) + 1 : 1);
    log.info({ count: ideas.length }, 'Loaded ideas');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.error({ err: err.message }, 'Failed to load ideas');
    }
    ideas = [];
    nextId = 1;
  }
}

function save() {
  try {
    writeFileAtomic(IDEAS_FILE, JSON.stringify({ ideas, nextId }, null, 2));
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save ideas');
  }
}

// --- CRUD ---

export function listIdeas() {
  return ideas.slice();
}

export function addIdea({ title, category, description, priority }) {
  if (!title || !title.trim()) throw new Error('Title is required');
  const cat = CATEGORIES.includes(category) ? category : 'improvement';
  const prio = PRIORITIES.includes(priority) ? priority : 'medium';
  const idea = {
    id: nextId++,
    title: title.trim().slice(0, MAX_TITLE),
    category: cat,
    description: (description || '').trim().slice(0, MAX_DESC),
    priority: prio,
    status: 'proposed',
    updatedAt: new Date().toISOString(),
  };
  ideas.push(idea);
  save();
  log.info({ id: idea.id, title: idea.title }, 'Idea added');
  return idea;
}

export function updateIdea(id, fields) {
  const idx = ideas.findIndex(i => i.id === id);
  if (idx === -1) return null;
  if (fields.title !== undefined) ideas[idx].title = String(fields.title).trim().slice(0, MAX_TITLE) || ideas[idx].title;
  if (fields.description !== undefined) ideas[idx].description = String(fields.description).trim().slice(0, MAX_DESC);
  if (fields.category !== undefined && CATEGORIES.includes(fields.category)) ideas[idx].category = fields.category;
  if (fields.priority !== undefined && PRIORITIES.includes(fields.priority)) ideas[idx].priority = fields.priority;
  if (fields.status !== undefined && STATUSES.includes(fields.status)) ideas[idx].status = fields.status;
  ideas[idx].updatedAt = new Date().toISOString();
  save();
  log.info({ id }, 'Idea updated');
  return ideas[idx];
}

export function removeIdea(id) {
  const idx = ideas.findIndex(i => i.id === id);
  if (idx === -1) return null;
  const [removed] = ideas.splice(idx, 1);
  save();
  log.info({ id }, 'Idea removed');
  return removed;
}

// --- Seed (called once if empty) ---

export function seedIfEmpty(seedData) {
  if (ideas.length > 0) return false;
  if (!Array.isArray(seedData) || seedData.length > 50) return false;
  let count = 0;
  for (const item of seedData) {
    if (!item || typeof item.title !== 'string' || !item.title.trim()) continue;
    addIdea({ title: item.title, category: item.category, description: item.description, priority: item.priority });
    count++;
  }
  log.info({ count }, 'Ideas seeded');
  return true;
}

// Load on import
load();
