import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { createLogger } from './logger.js';
import { logSkillUsage } from './skill-registry.js';
import config from './config.js';

const log = createLogger('skills');
const SKILLS_DIR = config.skillsDir;
const MAX_SKILL_SIZE = 8_000; // 8KB — prevents blowing up the system prompt

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
  if (content && content.length > MAX_SKILL_SIZE) {
    throw new Error(`Skill content too large (${content.length} chars, max ${MAX_SKILL_SIZE}). Trim it down.`);
  }
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

// Get a single skill's content (capped to MAX_SKILL_SIZE)
export function getSkill(name) {
  const safeName = name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const filePath = join(SKILLS_DIR, `${safeName}.md`);
  try {
    const content = readFileSync(filePath, 'utf-8');
    try { logSkillUsage(safeName); } catch {}
    if (content.length > MAX_SKILL_SIZE) {
      return content.slice(0, MAX_SKILL_SIZE) + '\n\n[...truncated — skill exceeds size limit]';
    }
    return content;
  } catch {
    return null;
  }
}
