/**
 * Skill Registry — Auto-indexed skill metadata from YAML frontmatter.
 *
 * Reads all skill .md files, parses frontmatter, builds searchable index.
 * Supports queries by keyword, category, tag, and name.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getState, setState } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, '../skills');

let registry = null;

/**
 * Parse YAML frontmatter from markdown file.
 * Returns object with metadata if found, null otherwise.
 * Handles: inline arrays [a, b], YAML list items (- val), quoted/unquoted strings, JSON objects.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const meta = {};

  const lines = yaml.split('\n');
  let currentKey = null;

  for (const line of lines) {
    // YAML list item (continuation of previous key): "  - value"
    if (/^\s+-\s+/.test(line) && currentKey) {
      const val = line.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, '').trim();
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      if (val) meta[currentKey].push(val);
      continue;
    }

    // Reset list context on non-list, non-empty lines
    if (line.trim() && !/^\s+-/.test(line)) currentKey = null;

    if (!line.trim()) continue;

    // Inline arrays: keywords: [a, b, c]
    const arrayMatch = line.match(/^(\w+):\s*\[(.*?)\]/);
    if (arrayMatch) {
      currentKey = arrayMatch[1];
      meta[currentKey] = arrayMatch[2]
        .split(',')
        .map(v => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }

    // JSON objects: metadata: {...}
    const jsonMatch = line.match(/^(\w+):\s*(\{[\s\S]*\})$/);
    if (jsonMatch) {
      currentKey = jsonMatch[1];
      try {
        meta[currentKey] = JSON.parse(jsonMatch[2]);
      } catch {
        meta[currentKey] = jsonMatch[2];
      }
      continue;
    }

    // Quoted strings: name: "value"
    const stringMatch = line.match(/^(\w+):\s*"((?:[^"\\]|\\.)*)"$/);
    if (stringMatch) {
      currentKey = stringMatch[1];
      meta[currentKey] = stringMatch[2];
      continue;
    }

    // Key with empty value (list follows): keywords:
    const listStartMatch = line.match(/^(\w+):\s*$/);
    if (listStartMatch) {
      currentKey = listStartMatch[1];
      meta[currentKey] = [];
      continue;
    }

    // Unquoted values: key: value
    const simpleMatch = line.match(/^(\w+):\s+(.+)$/);
    if (simpleMatch) {
      currentKey = simpleMatch[1];
      meta[currentKey] = simpleMatch[2];
    }
  }

  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * Load and index all skills from disk.
 */
function buildRegistry() {
  const skills = {};
  const byKeyword = {};
  const byCategory = {};
  const byTag = {};

  if (!fs.existsSync(SKILLS_DIR)) {
    return { skills, byKeyword, byCategory, byTag, count: 0 };
  }

  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'));

  for (const file of files) {
    const filePath = path.join(SKILLS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const meta = parseFrontmatter(content);

    if (!meta || !meta.name) continue;

    const skill = {
      id: path.basename(file, '.md'),
      name: meta.name,
      description: meta.description || '',
      keywords: meta.keywords || [],
      category: meta.category || 'uncategorized',
      tags: meta.tags || [],
      file,
    };

    skills[skill.id] = skill;

    // Index by keyword
    for (const kw of skill.keywords) {
      if (!byKeyword[kw]) byKeyword[kw] = [];
      byKeyword[kw].push(skill.id);
    }

    // Index by category
    if (!byCategory[skill.category]) byCategory[skill.category] = [];
    byCategory[skill.category].push(skill.id);

    // Index by tag
    for (const tag of skill.tags) {
      if (!byTag[tag]) byTag[tag] = [];
      byTag[tag].push(skill.id);
    }
  }

  return { skills, byKeyword, byCategory, byTag, count: Object.keys(skills).length };
}

/**
 * Get or build the registry (lazy-loaded, cached).
 */
export function getRegistry() {
  if (!registry) {
    registry = buildRegistry();
  }
  return registry;
}

/**
 * Search skills by keyword (case-insensitive, partial match).
 */
export function searchByKeyword(keyword) {
  const reg = getRegistry();
  const lower = keyword.toLowerCase();
  const results = [];

  for (const [kw, ids] of Object.entries(reg.byKeyword)) {
    if (kw.toLowerCase().includes(lower)) {
      results.push(...ids);
    }
  }

  // Remove duplicates and return full skill objects
  return [...new Set(results)].map(id => reg.skills[id]);
}

/**
 * Get all skills in a category.
 */
export function getByCategory(category) {
  const reg = getRegistry();
  const ids = reg.byCategory[category] || [];
  return ids.map(id => reg.skills[id]);
}

/**
 * Get all skills with a specific tag.
 */
export function getByTag(tag) {
  const reg = getRegistry();
  const ids = reg.byTag[tag] || [];
  return ids.map(id => reg.skills[id]);
}

/**
 * Get a specific skill by ID.
 */
export function getSkill(id) {
  const reg = getRegistry();
  return reg.skills[id] || null;
}

/**
 * List all skills.
 */
export function listAll() {
  const reg = getRegistry();
  return Object.values(reg.skills);
}

/**
 * Get all categories.
 */
export function getCategories() {
  const reg = getRegistry();
  return Object.keys(reg.byCategory).sort();
}

/**
 * Get all tags.
 */
export function getAllTags() {
  const reg = getRegistry();
  return Object.keys(reg.byTag).sort();
}

/**
 * Reload registry from disk (useful if skills change).
 */
export function reload() {
  registry = null;
  return getRegistry();
}

/**
 * Auto-detect relevant skills for a given query/context.
 * Returns top N skills sorted by relevance.
 */
export function autoDetect(query, limit = 5) {
  const reg = getRegistry();
  const queryLower = query.toLowerCase();
  const scores = {};

  for (const [id, skill] of Object.entries(reg.skills)) {
    let score = 0;

    // Exact name match (highest priority)
    if (skill.name.toLowerCase() === queryLower) score += 100;
    else if (skill.name.toLowerCase().includes(queryLower)) score += 50;

    // Keyword matches
    for (const kw of skill.keywords) {
      if (kw.toLowerCase() === queryLower) score += 30;
      else if (kw.toLowerCase().includes(queryLower)) score += 10;
    }

    // Description match
    if (skill.description.toLowerCase().includes(queryLower)) score += 5;

    scores[id] = score;
  }

  return Object.entries(scores)
    .filter(([_, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => reg.skills[id]);
}

/**
 * Get registry stats (for debugging/monitoring).
 */
export function getStats() {
  const reg = getRegistry();
  return {
    totalSkills: reg.count,
    categories: Object.keys(reg.byCategory).length,
    tags: Object.keys(reg.byTag).length,
    keywords: Object.keys(reg.byKeyword).length,
    skillsByCategory: Object.keys(reg.byCategory).reduce((acc, cat) => {
      acc[cat] = reg.byCategory[cat].length;
      return acc;
    }, {}),
  };
}

/**
 * Log a skill invocation. Called each time a skill is fetched/used.
 * Persists usage counts to kv_state for weekly reporting.
 */
export function logSkillUsage(skillId) {
  try {
    const usage = getState('skill-usage') || {};
    if (!usage[skillId]) usage[skillId] = { count: 0, lastUsedAt: null };
    usage[skillId].count++;
    usage[skillId].lastUsedAt = Date.now();
    setState('skill-usage', usage);
  } catch {}
}

/**
 * Returns all skills sorted by usage count descending.
 * Unused skills (count=0) appear at the end — surfaces dead skills for pruning.
 */
export function getSkillUsageStats() {
  try {
    const reg = getRegistry();
    const usage = getState('skill-usage') || {};
    return Object.values(reg.skills).map(skill => ({
      id: skill.id,
      name: skill.name,
      category: skill.category,
      count: usage[skill.id]?.count || 0,
      lastUsedAt: usage[skill.id]?.lastUsedAt || null,
    })).sort((a, b) => b.count - a.count);
  } catch { return []; }
}

/**
 * Run the executable companion for a skill.
 *
 * If skills/{id}.js exists, it is dynamically imported and its `run(context)`
 * function is called. Companion files are opt-in — most skills are prompt-only
 * (.md) and return null here, which callers treat as "no programmatic action."
 *
 * @param {string} skillId - Skill identifier (filename without extension)
 * @param {object} context - Optional context passed to the companion's run()
 * @returns {Promise<object|null>} Result from companion, or null if none found
 */
export async function runSkill(skillId, context = {}) {
  const skill = getSkill(skillId);
  if (!skill) return null;

  const companionPath = path.join(SKILLS_DIR, `${skillId}.js`);
  if (!fs.existsSync(companionPath)) return null;

  try {
    const { run } = await import(pathToFileURL(companionPath).href);
    if (typeof run !== 'function') return null;
    logSkillUsage(skillId);
    return await run(context);
  } catch (err) {
    return { error: err.message, skillId };
  }
}
