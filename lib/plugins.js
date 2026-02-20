import { readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { homedir } from 'os';
import { createLogger } from './logger.js';
import { getState, setState } from './state.js';

const log = createLogger('plugins');
const PLUGINS_DIR = join(homedir(), 'whatsapp-claude', 'plugins');

const HOOK_NAMES = [
  'onStartup', 'onShutdown', 'onMessage', 'onCommand',
  'preChat', 'postChat', 'onCronRun', 'onCronError',
];

let plugins = []; // { name, meta, module, hooks, enabled }

function getDisabledSet() {
  const s = getState('plugins-disabled');
  return new Set(s.list || []);
}

function setDisabledSet(set) {
  setState('plugins-disabled', { list: [...set] });
}

/**
 * Load all .js plugins from the plugins/ directory.
 * Respects metadata (export const meta) and disabled state.
 */
export async function loadPlugins(botApi) {
  mkdirSync(PLUGINS_DIR, { recursive: true });

  let files;
  try {
    files = readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));
  } catch {
    files = [];
  }

  if (files.length === 0) {
    log.info('No plugins found');
    return;
  }

  const disabled = getDisabledSet();

  for (const file of files) {
    const name = file.replace(/\.js$/, '');
    try {
      const filePath = join(PLUGINS_DIR, file);
      const mod = await import(pathToFileURL(filePath).href);

      const meta = mod.meta || { name, version: '0.0.0', description: '', priority: 100 };
      if (!meta.name) meta.name = name;
      if (meta.priority == null) meta.priority = 100;

      const hooks = {};
      for (const hookName of HOOK_NAMES) {
        if (typeof mod[hookName] === 'function') {
          hooks[hookName] = mod[hookName];
        }
      }

      const enabled = !disabled.has(name);
      plugins.push({ name, meta, module: mod, hooks, enabled });
      log.info({ plugin: name, hooks: Object.keys(hooks), priority: meta.priority, enabled }, 'Plugin loaded');
    } catch (err) {
      log.error({ plugin: name, err: err.message }, 'Failed to load plugin');
    }
  }

  // Sort by priority (lower = runs first)
  plugins.sort((a, b) => (a.meta.priority || 100) - (b.meta.priority || 100));

  // Call onStartup for enabled plugins
  for (const p of plugins) {
    if (p.enabled && p.hooks.onStartup) {
      try {
        await p.hooks.onStartup(botApi);
      } catch (err) {
        log.error({ plugin: p.name, err: err.message }, 'Plugin onStartup failed');
      }
    }
  }

  log.info({ count: plugins.length, enabled: plugins.filter(p => p.enabled).length }, 'Plugins loaded');
}

/**
 * Shut down all plugins.
 */
export async function shutdownPlugins() {
  for (const p of plugins) {
    if (p.enabled && p.hooks.onShutdown) {
      try {
        await p.hooks.onShutdown();
      } catch (err) {
        log.error({ plugin: p.name, err: err.message }, 'Plugin onShutdown failed');
      }
    }
  }
  plugins = [];
}

/**
 * Enable or disable a plugin by name. Returns the new state or null if not found.
 */
export function setPluginEnabled(name, enabled) {
  const p = plugins.find(pl => pl.name === name);
  if (!p) return null;

  p.enabled = enabled;
  const disabled = getDisabledSet();
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  setDisabledSet(disabled);

  log.info({ plugin: name, enabled }, 'Plugin toggled');
  return { name, enabled };
}

/**
 * List all loaded plugins with their metadata and status.
 */
export function listPlugins() {
  return plugins.map(p => ({
    name: p.name,
    enabled: p.enabled,
    version: p.meta.version || '0.0.0',
    description: p.meta.description || '',
    priority: p.meta.priority || 100,
    hooks: Object.keys(p.hooks),
  }));
}

/**
 * Run a synchronous hook on all enabled plugins. Errors are caught per-plugin.
 */
export function runHook(name, ...args) {
  for (const p of plugins) {
    if (p.enabled && p.hooks[name]) {
      try {
        p.hooks[name](...args);
      } catch (err) {
        log.error({ plugin: p.name, hook: name, err: err.message }, 'Plugin hook error');
      }
    }
  }
}

/**
 * Run an async hook on all enabled plugins. Returns first truthy result (for onCommand).
 */
export async function runHookAsync(name, ...args) {
  for (const p of plugins) {
    if (p.enabled && p.hooks[name]) {
      try {
        const result = await p.hooks[name](...args);
        if (result) return result;
      } catch (err) {
        log.error({ plugin: p.name, hook: name, err: err.message }, 'Plugin async hook error');
      }
    }
  }
  return false;
}

/**
 * Run preChat hook as a pipeline — each plugin can modify text/context.
 * Returns { text, extraContext } after all plugins have processed.
 */
export async function runPreChatPipeline(text, history, botApi) {
  let current = { text, extraContext: '' };
  for (const p of plugins) {
    if (p.enabled && p.hooks.preChat) {
      try {
        const result = await p.hooks.preChat(current.text, history, botApi);
        if (result && typeof result === 'object') {
          if (result.text) current.text = result.text;
          if (result.extraContext) current.extraContext += '\n' + result.extraContext;
        }
      } catch (err) {
        log.error({ plugin: p.name, hook: 'preChat', err: err.message }, 'Plugin preChat error');
      }
    }
  }
  return current;
}

/**
 * Run onCommand hook — returns true if any plugin handled the command.
 */
export async function runCommandHook(cmd, text, botApi) {
  return runHookAsync('onCommand', cmd, text, botApi);
}
