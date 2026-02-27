// Module Loader — discovers and registers optional modules from modules/[name]/index.js.
// Core files use accessor functions which return empty collections when no modules are loaded.
import { readdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import config from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('module-loader');

// ─── Internal registry ──────────────────────────────────────────────────────

const modules = [];                       // [{ name, manifest }]
let briefBuilders = {};                   // { signalType: builderFn }
let signalDetectors = [];                 // [detectFn]
let contextProviders = [];                // [providerFn]
let sonnetSignalTypes = new Set();        // signal types requiring Sonnet
let stateKeyMaps = [];                    // [{ stateKey, map }]
let apiRoutes = [];                       // [{ method, path, handler }]
let dashboardPages = [];                  // [{ path, title, icon, html }]
let messageCategories = {};               // { 'prefix_': 'category' }
let urgentWorkCheckers = [];              // [checkerFn]

// ─── Startup ─────────────────────────────────────────────────────────────────

export async function loadModules() {
  const modulesDir = join(config.projectRoot, 'modules');
  let dirs;
  try {
    dirs = readdirSync(modulesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    log.info('No modules/ directory — running without optional modules');
    return;
  }

  for (const dirName of dirs) {
    const indexPath = join(modulesDir, dirName, 'index.js');
    try {
      const mod = await import(pathToFileURL(indexPath).href);
      const manifest = mod.default;
      if (!manifest?.name) {
        log.warn({ dir: dirName }, 'Module skipped — missing name in manifest');
        continue;
      }

      modules.push({ name: manifest.name, manifest });

      // Register signal detector
      if (typeof manifest.detectSignals === 'function') {
        signalDetectors.push(manifest.detectSignals);
      }

      // Register brief builders
      if (manifest.briefBuilders) {
        Object.assign(briefBuilders, manifest.briefBuilders);
      }

      // Register context providers
      if (Array.isArray(manifest.contextProviders)) {
        contextProviders.push(...manifest.contextProviders);
      }

      // Register Sonnet signal types
      if (Array.isArray(manifest.sonnetSignalTypes)) {
        for (const t of manifest.sonnetSignalTypes) sonnetSignalTypes.add(t);
      }

      // Register state key maps
      if (manifest.stateKeyMap && manifest.stateKey) {
        stateKeyMaps.push({ stateKey: manifest.stateKey, map: manifest.stateKeyMap });
      }

      // Register API routes
      if (Array.isArray(manifest.apiRoutes)) {
        apiRoutes.push(...manifest.apiRoutes);
      }

      // Register dashboard page
      if (manifest.dashboard) {
        dashboardPages.push(manifest.dashboard);
      }

      // Register message category
      if (manifest.signalPrefix && manifest.messageCategory) {
        messageCategories[manifest.signalPrefix] = manifest.messageCategory;
      }

      // Register urgent work checker
      if (typeof manifest.hasUrgentWork === 'function') {
        urgentWorkCheckers.push(manifest.hasUrgentWork);
      }

      log.info({ module: manifest.name }, 'Module loaded');
    } catch (err) {
      log.error({ dir: dirName, err: err.message }, 'Failed to load module');
    }
  }

  log.info({ count: modules.length, names: modules.map(m => m.name) }, 'Module loading complete');
}

// ─── Accessor functions (safe to call before loadModules — return empty) ────

export function getModuleSignalDetectors() { return signalDetectors; }
export function getModuleBriefBuilders() { return briefBuilders; }
export function getModuleContextProviders() { return contextProviders; }
export function getModuleSonnetSignalTypes() { return sonnetSignalTypes; }
export function getModuleStateKeyMaps() { return stateKeyMaps; }
export function getModuleApiRoutes() { return apiRoutes; }
export function getModuleDashboardPages() { return dashboardPages; }
export function getModuleMessageCategories() { return messageCategories; }

export function checkModuleUrgentWork() {
  for (const checker of urgentWorkCheckers) {
    try { if (checker()) return true; } catch {}
  }
  return false;
}

export function getLoadedModules() { return modules.map(m => m.name); }
