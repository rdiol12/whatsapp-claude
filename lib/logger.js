import pino from 'pino';
import { mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

const logsDir = resolve(homedir(), 'whatsapp-claude', 'logs');
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

export function createLogger(subsystem) {
  return logger.child({ subsystem });
}

export default logger;
