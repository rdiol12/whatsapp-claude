import pino from 'pino';
import { mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { randomBytes } from 'crypto';
import config from './config.js';

const logsDir = config.logsDir;
mkdirSync(logsDir, { recursive: true });

const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '7', 10);

function dailyLogPath() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return resolve(logsDir, `app-${date}.log`);
}

/**
 * Clean up old log files beyond retention period.
 */
function cleanOldLogs() {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400_000;
    const files = readdirSync(logsDir).filter(f => f.startsWith('app-') && f.endsWith('.log'));
    for (const f of files) {
      try {
        const st = statSync(join(logsDir, f));
        if (st.mtimeMs < cutoff) {
          unlinkSync(join(logsDir, f));
        }
      } catch {}
    }
  } catch {}
}

// Clean old logs on startup and daily
cleanOldLogs();
setInterval(cleanOldLogs, 86400_000).unref();

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { pid: process.pid },
}, pino.transport({
  targets: [
    {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
        messageFormat: '[{subsystem}]: {msg}',
      },
      level: process.env.LOG_LEVEL || 'info',
    },
    {
      target: 'pino/file',
      options: { destination: dailyLogPath() },
      level: process.env.LOG_LEVEL || 'info',
    },
  ],
}));

/**
 * Generate a short request ID for tracing across async operations.
 */
export function genRequestId() {
  return randomBytes(4).toString('hex');
}

let errorHook = null;

// Register a hook to be called for error/warn level logs (to route to SQLite)
export function registerErrorHook(hookFn) {
  errorHook = hookFn;
}

export function createLogger(subsystem) {
  const child = logger.child({ subsystem });

  // Wrap the child logger to intercept error/warn levels
  const originalWarn = child.warn.bind(child);
  const originalError = child.error.bind(child);

  child.warn = function(obj, msg, ...args) {
    if (errorHook) {
      try {
        const message = typeof obj === 'string' ? obj : msg;
        const context = typeof obj === 'object' ? obj : {};
        errorHook('warning', subsystem, message, null, context);
      } catch {}
    }
    return originalWarn(obj, msg, ...args);
  };

  child.error = function(obj, msg, ...args) {
    if (errorHook) {
      try {
        const message = typeof obj === 'string' ? obj : msg;
        const context = typeof obj === 'object' ? obj : {};
        const stack = context?.err?.stack || null;
        errorHook('error', subsystem, message, stack, context);
      } catch {}
    }
    return originalError(obj, msg, ...args);
  };

  return child;
}

export default logger;
