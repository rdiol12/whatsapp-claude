/**
 * Executable companion for skills/health-monitor.md
 *
 * Returns a structured system health snapshot:
 * - Process memory (RSS, heap used/total, external)
 * - SQLite DB file size
 * - Recent error counts from the errors table
 * - System info (platform, free mem, load average)
 * - Process uptime
 *
 * Called via: runSkill('health-monitor', context)
 * Result: { status, memory, database, errors, system, process, checkedAt }
 */

import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '../data/sela.db');

/**
 * Compute overall health status based on findings.
 * @param {number} criticalErrors
 * @param {number} recentErrors
 * @param {number} heapUsedMB
 * @param {number} heapTotalMB
 */
function computeStatus(criticalErrors, recentErrors, heapUsedMB, heapTotalMB) {
  if (criticalErrors > 0) return 'critical';
  if (recentErrors > 5) return 'degraded';
  if (heapTotalMB > 0 && heapUsedMB / heapTotalMB > 0.9) return 'degraded';
  return 'ok';
}

export async function run(context = {}) {
  const mem = process.memoryUsage();
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const externalMB = Math.round(mem.external / 1024 / 1024);

  // DB file size
  const dbSizeMB = fs.existsSync(DB_PATH)
    ? Math.round(fs.statSync(DB_PATH).size / 1024 / 1024 * 10) / 10
    : null;

  // Recent errors from SQLite (lazy import to avoid circular deps)
  let recentErrorCount = 0;
  let criticalErrorCount = 0;
  try {
    const { getErrors } = await import('../lib/db.js');
    const recentErrors = getErrors(20, 0, 'error');
    const criticalErrors = getErrors(10, 0, 'critical');
    recentErrorCount = recentErrors.length;
    criticalErrorCount = criticalErrors.length;
  } catch {
    // db not available — skip
  }

  // System
  const loadAvg = os.loadavg(); // [1min, 5min, 15min]
  const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);

  const status = computeStatus(criticalErrorCount, recentErrorCount, heapUsedMB, heapTotalMB);

  return {
    status,
    memory: {
      rssMB,
      heapUsedMB,
      heapTotalMB,
      heapPct: heapTotalMB > 0 ? Math.round(heapUsedMB / heapTotalMB * 100) : 0,
      externalMB,
    },
    database: {
      sizeMB: dbSizeMB,
      path: DB_PATH,
    },
    errors: {
      recentErrors: recentErrorCount,
      criticalErrors: criticalErrorCount,
    },
    system: {
      platform: os.platform(),
      arch: os.arch(),
      freeMemMB,
      totalMemMB,
      memUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      loadAvg1m: Math.round(loadAvg[0] * 100) / 100,
      loadAvg5m: Math.round(loadAvg[1] * 100) / 100,
    },
    process: {
      uptimeMins: Math.round(process.uptime() / 60),
      pid: process.pid,
      nodeVersion: process.version,
    },
    checkedAt: new Date().toISOString(),
  };
}
