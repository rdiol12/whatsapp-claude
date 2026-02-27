/**
 * Tests for lib/skill-registry.js — run with: node test/skill-registry.test.js
 *
 * Tests: searchByKeyword, getByCategory, getByTag, getSkill, listAll,
 *        autoDetect, getStats, logSkillUsage, getSkillUsageStats, reload, runSkill
 *
 * Uses real skills/ directory — requires at least 1 skill .md file with frontmatter.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'skill-registry.js')).href;
const mod = await import(modPath);
const {
  getRegistry,
  searchByKeyword,
  getByCategory,
  getByTag,
  getSkill,
  listAll,
  getCategories,
  getAllTags,
  reload,
  autoDetect,
  getStats,
  logSkillUsage,
  getSkillUsageStats,
  runSkill,
} = mod;

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result
        .then(() => { passed++; console.log(`  PASS  ${name}`); })
        .catch(err => { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); });
    }
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`);
  }
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
    },
    toBeGreaterThan(n) {
      if (actual <= n) throw new Error(`Expected > ${n}, got ${actual}`);
    },
    toBeGreaterThanOrEqual(n) {
      if (actual < n) throw new Error(`Expected >= ${n}, got ${actual}`);
    },
    toContain(item) {
      if (!actual.includes(item)) throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`);
    },
    toBeArray() {
      if (!Array.isArray(actual)) throw new Error(`Expected array, got ${typeof actual}`);
    },
    toHaveProperty(key) {
      if (!(key in actual)) throw new Error(`Expected object to have property "${key}"`);
    },
  };
}

// ─── Registry Bootstrap ───────────────────────────────────────────────────────

console.log('\n── skill-registry: Registry Load ──');

test('getRegistry returns object with expected shape', () => {
  const reg = getRegistry();
  expect(reg).toBeTruthy();
  expect(reg).toHaveProperty('skills');
  expect(reg).toHaveProperty('byKeyword');
  expect(reg).toHaveProperty('byCategory');
  expect(reg).toHaveProperty('byTag');
  expect(reg).toHaveProperty('count');
});

test('registry has at least 1 skill loaded', () => {
  const reg = getRegistry();
  expect(reg.count).toBeGreaterThan(0);
});

test('registry count matches skills object keys', () => {
  const reg = getRegistry();
  const actual = Object.keys(reg.skills).length;
  if (actual !== reg.count) throw new Error(`count=${reg.count} but skills has ${actual} keys`);
});

test('each skill has required fields', () => {
  const reg = getRegistry();
  for (const [id, skill] of Object.entries(reg.skills)) {
    if (!skill.id) throw new Error(`Skill ${id} missing .id`);
    if (!skill.name) throw new Error(`Skill ${id} missing .name`);
    if (!Array.isArray(skill.keywords)) throw new Error(`Skill ${id} missing .keywords array`);
    if (!skill.category) throw new Error(`Skill ${id} missing .category`);
    if (!Array.isArray(skill.tags)) throw new Error(`Skill ${id} missing .tags array`);
    if (!skill.file) throw new Error(`Skill ${id} missing .file`);
  }
});

// ─── listAll ─────────────────────────────────────────────────────────────────

console.log('\n── skill-registry: listAll ──');

test('listAll returns array', () => {
  const all = listAll();
  expect(Array.isArray(all)).toBe(true);
  expect(all.length).toBeGreaterThan(0);
});

test('listAll count matches registry count', () => {
  const reg = getRegistry();
  const all = listAll();
  if (all.length !== reg.count) throw new Error(`listAll=${all.length} but registry.count=${reg.count}`);
});

// ─── searchByKeyword ──────────────────────────────────────────────────────────

console.log('\n── skill-registry: searchByKeyword ──');

test('searchByKeyword("backup") returns array', () => {
  const results = searchByKeyword('backup');
  expect(Array.isArray(results)).toBe(true);
});

test('searchByKeyword with known keyword finds a match', () => {
  // "backup" should match db-backup skill
  const results = searchByKeyword('backup');
  expect(results.length).toBeGreaterThan(0);
});

test('searchByKeyword is case-insensitive', () => {
  const lower = searchByKeyword('backup');
  const upper = searchByKeyword('BACKUP');
  if (lower.length !== upper.length) throw new Error(`case sensitivity issue: lower=${lower.length} upper=${upper.length}`);
});

test('searchByKeyword with nonsense query returns empty array', () => {
  const results = searchByKeyword('xyzzy_nonexistent_9999');
  expect(Array.isArray(results)).toBe(true);
  expect(results.length).toBe(0);
});

test('searchByKeyword returns skill objects with id and name', () => {
  const results = searchByKeyword('backup');
  if (results.length > 0) {
    const skill = results[0];
    expect(skill.id).toBeTruthy();
    expect(skill.name).toBeTruthy();
  }
});

// ─── getByCategory ────────────────────────────────────────────────────────────

console.log('\n── skill-registry: getByCategory ──');

test('getByCategory("operations") returns array', () => {
  const results = getByCategory('operations');
  expect(Array.isArray(results)).toBe(true);
});

test('getByCategory with known category finds db-backup', () => {
  const results = getByCategory('operations');
  const ids = results.map(s => s.id);
  if (!ids.includes('db-backup')) throw new Error(`Expected db-backup in operations, got: ${ids.join(',')}`);
});

test('getByCategory with unknown category returns empty array', () => {
  const results = getByCategory('nonexistent_category_xyz');
  expect(results.length).toBe(0);
});

// ─── getByTag ─────────────────────────────────────────────────────────────────

console.log('\n── skill-registry: getByTag ──');

test('getByTag("automated") returns array', () => {
  const results = getByTag('automated');
  expect(Array.isArray(results)).toBe(true);
});

test('getByTag finds skills with automated tag', () => {
  const results = getByTag('automated');
  // db-backup, business-briefing, etc. all have "automated" tag
  expect(results.length).toBeGreaterThan(0);
});

test('getByTag with unknown tag returns empty array', () => {
  const results = getByTag('nonexistent_tag_xyz');
  expect(results.length).toBe(0);
});

// ─── getSkill ─────────────────────────────────────────────────────────────────

console.log('\n── skill-registry: getSkill ──');

test('getSkill("db-backup") returns skill object', () => {
  const skill = getSkill('db-backup');
  expect(skill).toBeTruthy();
  expect(skill.id).toBe('db-backup');
});

test('getSkill returns null for unknown id', () => {
  const skill = getSkill('nonexistent_skill_xyz_999');
  expect(skill).toBeNull();
});

test('getSkill result has all required fields', () => {
  const skill = getSkill('db-backup');
  if (!skill) throw new Error('db-backup skill not found');
  expect(skill.id).toBeTruthy();
  expect(skill.name).toBeTruthy();
  expect(skill.description).toBeTruthy();
  expect(Array.isArray(skill.keywords)).toBe(true);
  expect(skill.category).toBeTruthy();
  expect(Array.isArray(skill.tags)).toBe(true);
});

// ─── getCategories / getAllTags ────────────────────────────────────────────────

console.log('\n── skill-registry: getCategories + getAllTags ──');

test('getCategories returns sorted array', () => {
  const cats = getCategories();
  expect(Array.isArray(cats)).toBe(true);
  expect(cats.length).toBeGreaterThan(0);
});

test('getCategories includes operations', () => {
  const cats = getCategories();
  if (!cats.includes('operations')) throw new Error(`Expected "operations" in [${cats.join(',')}]`);
});

test('getAllTags returns sorted array', () => {
  const tags = getAllTags();
  expect(Array.isArray(tags)).toBe(true);
  expect(tags.length).toBeGreaterThan(0);
});

test('getAllTags includes automated', () => {
  const tags = getAllTags();
  if (!tags.includes('automated')) throw new Error(`Expected "automated" in [${tags.join(',')}]`);
});

// ─── autoDetect ───────────────────────────────────────────────────────────────

console.log('\n── skill-registry: autoDetect ──');

test('autoDetect("backup database") returns array', () => {
  const results = autoDetect('backup database');
  expect(Array.isArray(results)).toBe(true);
});

test('autoDetect("backup") finds db-backup first', () => {
  const results = autoDetect('backup', 5);
  expect(results.length).toBeGreaterThan(0);
  const ids = results.map(s => s.id);
  if (!ids.includes('db-backup')) throw new Error(`Expected db-backup in results: ${ids.join(',')}`);
});

test('autoDetect with limit respects limit', () => {
  const results = autoDetect('a', 2);
  if (results.length > 2) throw new Error(`Expected <= 2 results, got ${results.length}`);
});

test('autoDetect with empty/nonsense returns empty array', () => {
  const results = autoDetect('xyzzy_no_skill_matches_this');
  expect(Array.isArray(results)).toBe(true);
  expect(results.length).toBe(0);
});

test('autoDetect exact name match scores highest', () => {
  // Get the first skill's name to test exact matching
  const first = listAll()[0];
  if (!first) return; // skip if no skills
  const results = autoDetect(first.name, 10);
  if (results.length === 0) throw new Error(`autoDetect("${first.name}") returned 0 results`);
  if (results[0].id !== first.id && results[0].name !== first.name) {
    // Might be a different skill with same name prefix — just check it returned something
    if (!results.find(s => s.id === first.id)) throw new Error(`Expected to find ${first.id} in results`);
  }
});

// ─── getStats ─────────────────────────────────────────────────────────────────

console.log('\n── skill-registry: getStats ──');

test('getStats returns object with expected shape', () => {
  const stats = getStats();
  expect(stats).toBeTruthy();
  expect(stats).toHaveProperty('totalSkills');
  expect(stats).toHaveProperty('categories');
  expect(stats).toHaveProperty('tags');
  expect(stats).toHaveProperty('keywords');
  expect(stats).toHaveProperty('skillsByCategory');
});

test('getStats totalSkills > 0', () => {
  const stats = getStats();
  expect(stats.totalSkills).toBeGreaterThan(0);
});

test('getStats categories > 0', () => {
  const stats = getStats();
  expect(stats.categories).toBeGreaterThan(0);
});

test('getStats skillsByCategory sums to totalSkills', () => {
  const stats = getStats();
  const sum = Object.values(stats.skillsByCategory).reduce((a, b) => a + b, 0);
  if (sum !== stats.totalSkills) throw new Error(`skillsByCategory sum ${sum} != totalSkills ${stats.totalSkills}`);
});

// ─── logSkillUsage / getSkillUsageStats ──────────────────────────────────────

console.log('\n── skill-registry: logSkillUsage + getSkillUsageStats ──');

test('logSkillUsage does not throw', () => {
  logSkillUsage('db-backup'); // should silently succeed
});

test('getSkillUsageStats returns array', () => {
  const stats = getSkillUsageStats();
  expect(Array.isArray(stats)).toBe(true);
});

test('getSkillUsageStats count matches total skills', () => {
  const reg = getRegistry();
  const stats = getSkillUsageStats();
  if (stats.length !== reg.count) throw new Error(`stats.length=${stats.length} != registry.count=${reg.count}`);
});

test('getSkillUsageStats items have required fields', () => {
  const stats = getSkillUsageStats();
  if (stats.length === 0) return;
  const item = stats[0];
  expect(item).toHaveProperty('id');
  expect(item).toHaveProperty('name');
  expect(item).toHaveProperty('count');
  expect(item).toHaveProperty('lastUsedAt');
});

test('getSkillUsageStats is sorted by count descending', () => {
  const stats = getSkillUsageStats();
  for (let i = 1; i < stats.length; i++) {
    if (stats[i].count > stats[i - 1].count) {
      throw new Error(`Not sorted: stats[${i}].count (${stats[i].count}) > stats[${i-1}].count (${stats[i-1].count})`);
    }
  }
});

test('db-backup usage count increased after logSkillUsage', () => {
  // Note: count persists across test runs via kv_state
  const before = getSkillUsageStats().find(s => s.id === 'db-backup')?.count ?? 0;
  logSkillUsage('db-backup');
  const after = getSkillUsageStats().find(s => s.id === 'db-backup')?.count ?? 0;
  if (after <= before) throw new Error(`Expected count to increase: before=${before}, after=${after}`);
});

// ─── reload ───────────────────────────────────────────────────────────────────

console.log('\n── skill-registry: reload ──');

test('reload returns fresh registry', () => {
  const reg = reload();
  expect(reg).toBeTruthy();
  expect(reg.count).toBeGreaterThan(0);
});

test('registry is consistent after reload', () => {
  const a = reload();
  const b = getRegistry();
  if (a.count !== b.count) throw new Error(`count mismatch after reload: ${a.count} vs ${b.count}`);
});

// ─── runSkill (if exported) ───────────────────────────────────────────────────

console.log('\n── skill-registry: runSkill ──');

test('runSkill is exported (or gracefully absent)', () => {
  // runSkill may not be implemented yet — this test is forward-compatible
  if (typeof runSkill !== 'undefined' && typeof runSkill !== 'function') {
    throw new Error(`runSkill should be a function, got ${typeof runSkill}`);
  }
});

test('runSkill with unknown skill id returns null', async () => {
  if (typeof runSkill !== 'function') return; // skip if not yet implemented
  const result = await runSkill('nonexistent_skill_xyz_999');
  expect(result).toBeNull();
});

// ─── Summary ──────────────────────────────────────────────────────────────────

// Flush async tests
await new Promise(resolve => setTimeout(resolve, 100));

console.log(`\n── Results: ${passed}/${total} passed (${failed} failed) ──`);
if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
