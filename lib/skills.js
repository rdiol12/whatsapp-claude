import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from './logger.js';

const log = createLogger('skills');
const SKILLS_DIR = join(homedir(), 'whatsapp-claude', 'skills');

// --- Cached skill list (60s TTL) ---
let skillListCache = null;
let skillListCacheTime = 0;
const SKILL_CACHE_TTL = 60_000;

function invalidateSkillCache() {
  skillListCache = null;
  skillListCacheTime = 0;
}

// List skill names (cached with 60s TTL)
export function listSkills() {
  const now = Date.now();
  if (skillListCache && (now - skillListCacheTime) < SKILL_CACHE_TTL) {
    return skillListCache;
  }
  try {
    skillListCache = readdirSync(SKILLS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''))
      .sort();
    skillListCacheTime = now;
    return skillListCache;
  } catch {
    return [];
  }
}

// Add a skill (name + content)
export function addSkill(name, content) {
  const safeName = name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const filePath = join(SKILLS_DIR, `${safeName}.md`);
  writeFileSync(filePath, content, 'utf-8');
  invalidateSkillCache();
  return safeName;
}

// Delete a skill by name
export function deleteSkill(name) {
  const safeName = name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const filePath = join(SKILLS_DIR, `${safeName}.md`);
  try {
    unlinkSync(filePath);
    invalidateSkillCache();
    return true;
  } catch {
    return false;
  }
}

// Get a single skill's content
export function getSkill(name) {
  const safeName = name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const filePath = join(SKILLS_DIR, `${safeName}.md`);
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
