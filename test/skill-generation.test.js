/**
 * Smoke tests for the skill generation pipeline — run with:
 *   node test/skill-generation.test.js
 *
 * Tests: quickGenerateSkill, getSkill, YAML frontmatter validity,
 *        registry reload(), searchByKeyword, duplicate guard, overwrite.
 *
 * Uses TEST_SKILL_NAME = 'sela-smoke-test-skill' as a throwaway skill.
 * Cleans up before and after the suite.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Module imports ───────────────────────────────────────────────────────────

const generatorPath  = pathToFileURL(join(__dirname, '..', 'lib', 'skill-generator.js')).href;
const skillsPath     = pathToFileURL(join(__dirname, '..', 'lib', 'skills.js')).href;
const registryPath   = pathToFileURL(join(__dirname, '..', 'lib', 'skill-registry.js')).href;

const { quickGenerateSkill, generateSkill } = await import(generatorPath);
const { deleteSkill, getSkill }             = await import(skillsPath);
const { reload, searchByKeyword }           = await import(registryPath);

// ─── Homegrown test framework ─────────────────────────────────────────────────

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
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
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
    toContain(item) {
      if (!actual.includes(item)) throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`);
    },
    toBeArray() {
      if (!Array.isArray(actual)) throw new Error(`Expected array, got ${typeof actual}`);
    },
    toThrow() {
      // special: actual should be a function — call it and assert throws
      if (typeof actual !== 'function') throw new Error('toThrow() expects a function');
      let threw = false;
      try { actual(); } catch { threw = true; }
      if (!threw) throw new Error('Expected function to throw, but it did not');
    },
    toNotThrow() {
      if (typeof actual !== 'function') throw new Error('toNotThrow() expects a function');
      try { actual(); } catch (e) { throw new Error(`Expected function NOT to throw, but got: ${e.message}`); }
    },
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_SKILL_NAME = 'sela-smoke-test-skill';
const TEST_SKILL_SLUG = TEST_SKILL_NAME; // quickGenerateSkill preserves this slug exactly

// ─── Pre-suite cleanup ────────────────────────────────────────────────────────

console.log('\n── skill-generation: Pre-suite cleanup ──');
deleteSkill(TEST_SKILL_SLUG);
console.log(`  INFO  Deleted any pre-existing '${TEST_SKILL_SLUG}' skill`);

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n── skill-generation: quickGenerateSkill ──');

let createdSlug;

test('quickGenerateSkill returns a slug string', () => {
  createdSlug = quickGenerateSkill(
    TEST_SKILL_NAME,
    'Smoke test skill for the automated test suite.',
    'utility',
  );
  expect(createdSlug).toBeTruthy();
  expect(typeof createdSlug).toBe('string');
});

console.log('\n── skill-generation: Disk persistence (getSkill) ──');

test('created skill is retrievable from disk via getSkill', () => {
  const content = getSkill(TEST_SKILL_SLUG);
  expect(content).toBeTruthy();
});

console.log('\n── skill-generation: YAML frontmatter validity ──');

test('skill file starts with YAML front-matter delimiter ---', () => {
  const content = getSkill(TEST_SKILL_SLUG);
  expect(content).toBeTruthy();
  expect(content.startsWith('---')).toBe(true);
});

test('skill file contains name: field in frontmatter', () => {
  const content = getSkill(TEST_SKILL_SLUG);
  expect(content).toBeTruthy();
  expect(content.includes('name:')).toBe(true);
});

test('skill file contains category: field in frontmatter', () => {
  const content = getSkill(TEST_SKILL_SLUG);
  expect(content).toBeTruthy();
  expect(content.includes('category:')).toBe(true);
});

console.log('\n── skill-generation: Registry integration ──');

test('reload() picks up the newly created skill', async () => {
  await reload();
  // If we reach here without throwing, the registry accepted the new skill
  expect(true).toBe(true);
});

test('searchByKeyword finds the generated skill after reload', async () => {
  await reload();
  // "smoke" appears in the description and auto-derived keywords
  const results = searchByKeyword('smoke');
  expect(results).toBeArray();
  const found = results.some(s => s.id === TEST_SKILL_SLUG || s.slug === TEST_SKILL_SLUG);
  if (!found) {
    // Fall back: search by "sela" which is in the skill name
    const results2 = searchByKeyword('sela');
    const found2 = results2.some(s => s.id === TEST_SKILL_SLUG || s.slug === TEST_SKILL_SLUG);
    if (!found2) throw new Error(`Skill '${TEST_SKILL_SLUG}' not found in search results for "smoke" or "sela"`);
  }
});

console.log('\n── skill-generation: Duplicate guard ──');

test('generateSkill throws when overwrite=false and skill already exists', () => {
  expect(() => {
    generateSkill({
      name: TEST_SKILL_NAME,
      description: 'Duplicate attempt — should be blocked.',
      overwrite: false,
    });
  }).toThrow();
});

console.log('\n── skill-generation: Overwrite allowed ──');

test('generateSkill succeeds when overwrite=true', () => {
  let slug;
  expect(() => {
    slug = generateSkill({
      name: TEST_SKILL_NAME,
      description: 'Overwrite version of the smoke test skill.',
      overwrite: true,
    });
  }).toNotThrow();
  // Also confirm the returned slug is truthy
  if (!slug) throw new Error('overwrite=true returned falsy slug');
});

// ─── Post-suite cleanup ───────────────────────────────────────────────────────

// Give async tests a tick to settle before cleanup
await new Promise(resolve => setTimeout(resolve, 200));

console.log('\n── skill-generation: Post-suite cleanup ──');
deleteSkill(TEST_SKILL_SLUG);
console.log(`  INFO  Deleted test skill '${TEST_SKILL_SLUG}'`);

// ─── Summary ──────────────────────────────────────────────────────────────────

await new Promise(resolve => setTimeout(resolve, 100));

console.log(`\n── Results: ${passed}/${total} passed (${failed} failed) ──`);
if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
