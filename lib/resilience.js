import { writeFileSync, renameSync, unlinkSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from './logger.js';

const log = createLogger('resilience');

/**
 * Atomic file write: write to temp file, then rename.
 * Rename is atomic on NTFS and most POSIX filesystems.
 */
export function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, data, { flush: true });
    renameSync(tmp, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Clean up orphaned .tmp files from previous crashes.
 * Call once at startup for directories that use writeFileAtomic.
 */
export function cleanupOrphanedTempFiles(dir) {
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (f.includes('.tmp.')) {
        try {
          unlinkSync(join(dir, f));
          log.info({ file: f }, 'Cleaned up orphaned temp file');
        } catch {}
      }
    }
  } catch {}
}

/**
 * Classify an error as transient (retryable) or permanent (not retryable).
 */
export function classifyError(err) {
  const msg = (err.message || '').toLowerCase();

  // Permanent: auth failures, bad input, missing files, Claude-reported errors
  if (err.isPermanent) return 'permanent';
  if (err.code === 'ENOENT') return 'permanent';
  if (msg.includes('auth') || msg.includes('unauthorized') || msg.includes('forbidden')) return 'permanent';
  if (msg.includes('invalid') || msg.includes('bad request')) return 'permanent';
  if (msg.includes('logged out') || msg.includes('re-scan')) return 'permanent';
  // Permanent: validation errors — missing required params can never be fixed by retrying
  if (msg.includes('is required') || msg.includes('are required')) return 'permanent';
  if (msg.includes('access denied') || msg.includes('outside sela') || msg.includes('outside workspace')) return 'permanent';
  // Permanent: blocked commands, module resolution failures — retrying will never help
  if (msg.includes('blocked:') || msg.includes('destructive command')) return 'permanent';
  if (msg.includes('cannot find module') || msg.includes('module_not_found')) return 'permanent';

  // Transient: timeouts, exit codes, connection issues
  if (msg.includes('timeout')) return 'transient';
  if (msg.includes('exited')) return 'transient';
  if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('epipe')) return 'transient';
  if (msg.includes('socket hang up') || msg.includes('network')) return 'transient';

  // Default: treat unknown errors as transient (safer to retry)
  return 'transient';
}

/**
 * Retry a function with exponential backoff.
 * Only retries on transient errors.
 */
export async function retry(fn, { retries = 3, baseMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);
      if (kind === 'permanent') {
        log.warn({ attempt, err: err.message, kind }, 'Permanent error, not retrying');
        throw err;
      }
      if (attempt < retries - 1) {
        const delayMs = baseMs * Math.pow(2, attempt);
        log.warn({ attempt, retries, delayMs, err: err.message }, 'Transient error, retrying');
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}
