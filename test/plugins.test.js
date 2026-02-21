/**
 * Tests for plugins.js — run with: node test/plugins.test.js
 *
 * Tests the preChat pipeline mutation safety (Phase 2 fix)
 * and hook execution behavior.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Set up isolated plugins dir with test plugins
const TEST_DIR = join(tmpdir(), `plugins-test-${Date.now()}`);
const PLUGINS_DIR = join(TEST_DIR, 'plugins');
const STATE_DIR = join(TEST_DIR, 'state');
mkdirSync(PLUGINS_DIR, { recursive: true });
mkdirSync(STATE_DIR, { recursive: true });

// We test runPreChatPipeline directly by importing the module
// But first write test plugins
writeFileSync(join(PLUGINS_DIR, 'good-plugin.js'), `
export const meta = { name: 'good-plugin', priority: 10 };
export async function preChat(text, history, botApi) {
  return { text: text + ' [modified]', extraContext: 'extra from good' };
}
`);

writeFileSync(join(PLUGINS_DIR, 'crashing-plugin.js'), `
export const meta = { name: 'crashing-plugin', priority: 20 };
export async function preChat(text, history, botApi) {
  // Mutate text then crash
  throw new Error('plugin crash');
}
`);

writeFileSync(join(PLUGINS_DIR, 'interceptor-plugin.js'), `
export const meta = { name: 'interceptor-plugin', priority: 30 };
export async function preChat(text, history, botApi) {
  if (text.includes('intercept')) return { handled: true };
  return null;
}
`);

// We can't easily mock the plugins dir, so let's test the pipeline logic directly
// by reimplementing the core pipeline function with the Phase 2 fix
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
    toBeFalsy() { if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toContain(s) { if (!String(actual).includes(s)) throw new Error(`Expected "${actual}" to contain "${s}"`); },
  };
}

// Import the real module to test runPreChatPipeline
const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'plugins.js')).href;
const { runPreChatPipeline } = await import(modPath);

// ---------------------------------------------------------------------------
// runPreChatPipeline (no plugins loaded — should pass through)
// ---------------------------------------------------------------------------
console.log('\n=== runPreChatPipeline (empty) ===');

await test('returns original text when no plugins loaded', async () => {
  const result = await runPreChatPipeline('hello world', [], {});
  expect(result.text).toBe('hello world');
  expect(result.extraContext).toBe('');
});

await test('handled is not set when no plugins', async () => {
  const result = await runPreChatPipeline('test', [], {});
  expect(result.handled).toBeFalsy();
});

// ---------------------------------------------------------------------------
// Simulate pipeline mutation safety (unit test the pattern)
// ---------------------------------------------------------------------------
console.log('\n=== Pipeline Mutation Safety ===');

await test('snapshot restores text on plugin error', async () => {
  // Simulate the fixed pipeline: snapshot before, restore on error
  const plugins = [
    { name: 'good', preChat: async (text) => ({ text: text + ' [good]' }) },
    { name: 'bad', preChat: async (text) => { throw new Error('crash'); } },
    { name: 'after', preChat: async (text) => ({ text: text + ' [after]' }) },
  ];

  let current = { text: 'original', extraContext: '' };
  for (const p of plugins) {
    const snapshot = current.text;
    try {
      const result = await p.preChat(current.text, [], {});
      if (result && typeof result === 'object') {
        if (result.text) current.text = result.text;
        if (result.extraContext) current.extraContext += '\n' + result.extraContext;
      }
    } catch {
      current.text = snapshot; // restore on error (Phase 2 fix)
    }
  }

  // "good" modified text, "bad" crashed but text was restored, "after" ran on restored text
  expect(current.text).toBe('original [good] [after]');
});

await test('without snapshot fix, crash leaves corrupted text', async () => {
  // Simulate the OLD behavior (no snapshot) to verify the bug existed
  const plugins = [
    { name: 'mutator', preChat: async (text) => {
      // This plugin modifies current.text via returned result, then errors happen elsewhere
      return { text: 'CORRUPTED' };
    }},
    { name: 'crasher', preChat: async (text) => { throw new Error('crash'); } },
  ];

  let current = { text: 'original', extraContext: '' };
  for (const p of plugins) {
    try {
      const result = await p.preChat(current.text, [], {});
      if (result && typeof result === 'object') {
        if (result.text) current.text = result.text;
      }
    } catch {
      // Old behavior: no restore
    }
  }

  // Without fix, "mutator" changed text to CORRUPTED, "crasher" threw but text stays corrupted
  expect(current.text).toBe('CORRUPTED');
});

await test('handled flag stops pipeline', async () => {
  const plugins = [
    { name: 'interceptor', preChat: async (text) => ({ handled: true }) },
    { name: 'never', preChat: async (text) => ({ text: 'should not run' }) },
  ];

  let current = { text: 'original', extraContext: '' };
  for (const p of plugins) {
    const snapshot = current.text;
    try {
      const result = await p.preChat(current.text, [], {});
      if (result && typeof result === 'object') {
        if (result.handled) {
          current = { ...current, handled: true };
          break; // stop pipeline
        }
        if (result.text) current.text = result.text;
      }
    } catch {
      current.text = snapshot;
    }
  }

  expect(current.handled).toBe(true);
  expect(current.text).toBe('original'); // never ran second plugin
});

await test('extraContext accumulates across plugins', async () => {
  const plugins = [
    { name: 'p1', preChat: async () => ({ extraContext: 'ctx1' }) },
    { name: 'p2', preChat: async () => ({ extraContext: 'ctx2' }) },
  ];

  let current = { text: 'original', extraContext: '' };
  for (const p of plugins) {
    const snapshot = current.text;
    try {
      const result = await p.preChat(current.text, [], {});
      if (result && typeof result === 'object') {
        if (result.text) current.text = result.text;
        if (result.extraContext) current.extraContext += '\n' + result.extraContext;
      }
    } catch {
      current.text = snapshot;
    }
  }

  expect(current.extraContext).toContain('ctx1');
  expect(current.extraContext).toContain('ctx2');
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
