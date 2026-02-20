import { writeFileSync, renameSync, unlinkSync } from 'fs';
import { createLogger } from './logger.js';

const log = createLogger('resilience');

/**
 * Atomic file write: write to temp file, then rename.
 * Rename is atomic on NTFS and most POSIX filesystems.
 */
export function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
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
