/**
 * Tests for lib/module-loader.js — run with: node test/module-loader.test.js
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => { passed++; console.log(`  PASS  ${name}`); })
        .catch(err => { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); });
    }
    passed++; console.log(`  PASS  ${name}`);
  }
  catch (err) { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

function expect(actual) {
  return {
    toBe(expected) { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy() { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeGreaterThan(n) { if (actual <= n) throw new Error(`Expected ${actual} > ${n}`); },
    toBeInstanceOf(cls) { if (!(actual instanceof cls)) throw new Error(`Expected instance of ${cls.name}`); },
  };
}

const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'module-loader.js')).href;
const mod = await import(modPath);

// ---------------------------------------------------------------------------
// Pre-loadModules: all accessors return empty collections
// ---------------------------------------------------------------------------
console.log('\n=== Accessor defaults (before loadModules) ===');

test('getModuleSignalDetectors returns array', () => {
  expect(Array.isArray(mod.getModuleSignalDetectors())).toBe(true);
});

test('getModuleBriefBuilders returns object', () => {
  expect(typeof mod.getModuleBriefBuilders()).toBe('object');
});

test('getModuleContextProviders returns array', () => {
  expect(Array.isArray(mod.getModuleContextProviders())).toBe(true);
});

test('getModuleSonnetSignalTypes returns Set', () => {
  expect(mod.getModuleSonnetSignalTypes()).toBeInstanceOf(Set);
});

test('getModuleStateKeyMaps returns array', () => {
  expect(Array.isArray(mod.getModuleStateKeyMaps())).toBe(true);
});

test('getModuleApiRoutes returns array', () => {
  expect(Array.isArray(mod.getModuleApiRoutes())).toBe(true);
});

test('getModuleDashboardPages returns array', () => {
  expect(Array.isArray(mod.getModuleDashboardPages())).toBe(true);
});

test('getModuleMessageCategories returns object', () => {
  expect(typeof mod.getModuleMessageCategories()).toBe('object');
});

test('checkModuleUrgentWork returns false when no modules', () => {
  expect(mod.checkModuleUrgentWork()).toBe(false);
});

test('getLoadedModules returns empty array', () => {
  expect(mod.getLoadedModules().length).toBe(0);
});

// ---------------------------------------------------------------------------
// Post-loadModules: hattrick module loaded
// ---------------------------------------------------------------------------
console.log('\n=== After loadModules (hattrick present) ===');

await mod.loadModules();

test('hattrick module loaded', () => {
  expect(mod.getLoadedModules().includes('hattrick')).toBe(true);
});

test('signal detectors include hattrick', () => {
  expect(mod.getModuleSignalDetectors().length).toBeGreaterThan(0);
});

test('brief builders include hattrick types', () => {
  const builders = mod.getModuleBriefBuilders();
  expect(typeof builders.hattrick_match_prep).toBe('function');
  expect(typeof builders.hattrick_economy_check).toBe('function');
});

test('context providers include buildWeeklyPlan', () => {
  expect(mod.getModuleContextProviders().length).toBeGreaterThan(0);
});

test('sonnet signal types include hattrick types', () => {
  const types = mod.getModuleSonnetSignalTypes();
  expect(types.has('hattrick_match_prep')).toBe(true);
  expect(types.has('hattrick_autonomous_bid')).toBe(true);
});

test('state key maps include hattrick-cycle', () => {
  const maps = mod.getModuleStateKeyMaps();
  expect(maps.length).toBeGreaterThan(0);
  expect(maps[0].stateKey).toBe('hattrick-cycle');
  expect(maps[0].map.hattrick_match_prep).toBe('lastMatchPrepAt');
});

test('API routes include hattrick endpoints', () => {
  const routes = mod.getModuleApiRoutes();
  expect(routes.length).toBe(3);
  expect(routes.some(r => r.path === '/hattrick' && r.method === 'GET')).toBe(true);
  expect(routes.some(r => r.path === '/hattrick/cycle' && r.method === 'POST')).toBe(true);
  expect(routes.some(r => r.path === '/hattrick/refresh' && r.method === 'POST')).toBe(true);
});

test('dashboard pages include hattrick', () => {
  const pages = mod.getModuleDashboardPages();
  expect(pages.length).toBe(1);
  expect(pages[0].path).toBe('/hattrick');
  expect(pages[0].title).toBe('Hattrick');
});

test('message categories include hattrick', () => {
  const cats = mod.getModuleMessageCategories();
  expect(cats['hattrick_']).toBe('hattrick');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
if (failed > 0) process.exit(1);
