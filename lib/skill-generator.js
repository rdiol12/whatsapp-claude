/**
 * Skill Generator — dynamically creates skill .md files from a description.
 *
 * Generates well-structured skill files with YAML frontmatter (name, description,
 * keywords, category, tags) and a markdown body from structured inputs.
 * Persists via skills.js addSkill() — no direct FS access here.
 *
 * Usage (programmatic):
 *   import { generateSkill } from './skill-generator.js';
 *   const slug = generateSkill({
 *     name: 'PDF Summarizer',
 *     description: 'Extracts key points from PDF documents.',
 *     keywords: ['pdf', 'summarize', 'document'],
 *     category: 'productivity',
 *     tags: ['document', 'ai'],
 *     body: '## How it works\n\nFetch PDF → extract text → summarize with Claude.',
 *   });
 *   // Returns slug e.g. 'pdf-summarizer', file saved to ~/sela/skills/pdf-summarizer.md
 */

import { addSkill, listSkills } from './skills.js';
import { createLogger } from './logger.js';

const log = createLogger('skill-generator');

// Valid categories aligned with skill-registry.js
const VALID_CATEGORIES = [
  'analytics', 'automation', 'communication', 'content', 'data',
  'developer', 'finance', 'media', 'monitoring', 'productivity',
  'research', 'system', 'utility',
];

/**
 * Generate a skill .md file from structured inputs.
 *
 * @param {object} opts
 * @param {string}   opts.name        - Human-readable skill name (e.g. "PDF Summarizer")
 * @param {string}   opts.description - One-sentence description (shown in registry)
 * @param {string[]} opts.keywords    - Search keywords (3-8 recommended)
 * @param {string}   opts.category    - Category from VALID_CATEGORIES list
 * @param {string[]} [opts.tags]      - Optional extra tags
 * @param {string}   [opts.body]      - Markdown body (default: minimal template)
 * @param {boolean}  [opts.overwrite] - Overwrite if already exists (default: false)
 * @returns {string} The skill slug (filename without .md)
 * @throws {Error}   If name/description missing, or skill exists and overwrite=false
 */
export function generateSkill({ name, description, keywords = [], category = 'utility', tags = [], body = '', overwrite = false } = {}) {
  if (!name || !name.trim()) throw new Error('skill-generator: name is required');
  if (!description || !description.trim()) throw new Error('skill-generator: description is required');

  // Normalise category
  const normCategory = VALID_CATEGORIES.includes(category) ? category : 'utility';

  // Generate slug
  const slug = name.trim().replace(/[^a-z0-9_-]/gi, '-').replace(/-+/g, '-').toLowerCase();

  // Guard: don't overwrite unless explicitly requested
  if (!overwrite) {
    const existing = listSkills();
    if (existing.includes(slug)) {
      throw new Error(`skill-generator: skill '${slug}' already exists — pass overwrite:true to replace`);
    }
  }

  // Build YAML frontmatter
  const kwLine = keywords.length > 0
    ? `keywords: [${keywords.map(k => `"${k}"`).join(', ')}]`
    : 'keywords: []';
  const tagLine = tags.length > 0
    ? `tags: [${tags.map(t => `"${t}"`).join(', ')}]`
    : 'tags: []';

  // Build markdown body (use provided or generate minimal template)
  const markdownBody = body.trim() || `## What it does\n\n${description}\n\n## Usage\n\n_Describe how to invoke this skill._`;

  const content = `---
name: "${name.trim()}"
description: "${description.trim()}"
${kwLine}
category: "${normCategory}"
${tagLine}
---

# ${name.trim()}

${markdownBody}
`;

  const saved = addSkill(slug, content);
  log.info({ slug: saved, category: normCategory, keywords: keywords.length }, 'skill-generator: skill created');
  return saved;
}

/**
 * Quick-generate a minimal skill from just a name and description.
 * Useful for the agent to scaffold a new skill file in one call.
 *
 * @param {string} name         - Skill name
 * @param {string} description  - One-sentence description
 * @param {string} [category]   - Optional category
 * @returns {string}            Slug of created skill
 */
export function quickGenerateSkill(name, description, category = 'utility') {
  // Auto-derive keywords from name + description words (>4 chars, no duplicates)
  const words = `${name} ${description}`.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  const keywords = [...new Set(words)].slice(0, 6);
  return generateSkill({ name, description, keywords, category });
}
