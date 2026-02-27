/**
 * Guardian M3: External process watchdog
 * Runs as a SEPARATE PM2 process — independent of the main sela bot.
 * Pings /healthz every 5 minutes. Sends Telegram if bot is unreachable.
 *
 * Why a separate process: the internal heartbeat cron can't detect if the
 * agent-loop itself is dead, since it runs inside the same process.
 */

import { readFileSync, existsSync, openSync, readSync, fstatSync, closeSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import pino from 'pino';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = pino({ name: 'watchdog', level: process.env.LOG_LEVEL || 'info' });
const DATA_DIR = resolve(__dirname, '..', 'data');
const PORT_FILE = resolve(DATA_DIR, '.ipc-port');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ALERT_AFTER_FAILURES = 5;          // alert after 5 consecutive failures
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown between alerts
const CHRONIC_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between chronic memory alerts
const CHRONIC_DEGRADED_THRESHOLD = 6;    // 6 consecutive degraded checks (30min) → alert

let consecutiveFailures = 0;
let consecutiveDegraded = 0;             // track sustained degraded state
let lastAlertAt = 0;
let lastChronicAlertAt = 0;
let wasDown = false;

// ── Telegram helper (standalone — no notify.js dependency) ──────────────────
async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const err = await res.text();
      log.error({ status: res.status, detail: err.slice(0, 100) }, 'Telegram error');
    }
  } catch (err) {
    log.error({ err }, 'Telegram send failed');
  }
}

// ── Read bot port from .ipc-port ────────────────────────────────────────────
function getBotPort() {
  try {
    if (!existsSync(PORT_FILE)) return null;
    const raw = readFileSync(PORT_FILE, 'utf-8').trim();
    const { port, token } = JSON.parse(raw);
    return { port, token };
  } catch {
    return null;
  }
}

// ── Health check ─────────────────────────────────────────────────────────────
async function checkHealth() {
  const ipc = getBotPort();
  if (!ipc) {
    consecutiveFailures++;
    log.warn({ failures: consecutiveFailures }, '.ipc-port missing');
    await maybeAlert('*[Watchdog] Bot unreachable* — `.ipc-port` file missing. Sela may not have started properly.');
    return;
  }

  const { port, token } = ipc;
  const url = `http://127.0.0.1:${port}/healthz`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    const body = await res.json();

    if (res.ok && body.status === 'ok') {
      // Recovery notice
      if (wasDown) {
        log.info('Bot recovered');
        await sendTelegram('*[Watchdog] Sela recovered* ✅ — `/healthz` responding normally again.');
        wasDown = false;
        consecutiveFailures = 0;
      } else if (consecutiveFailures > 0) {
        log.info('Health restored after partial failures');
        consecutiveFailures = 0;
      } else {
        log.info({ heap_pct: body.heap_pct, tier: body.memory_tier || '?', queue: body.queue_waiting }, 'ok');
      }
      // Reset degraded counter on healthy check
      if (consecutiveDegraded > 0) {
        log.info({ degradedChecks: consecutiveDegraded }, 'Memory pressure resolved');
        consecutiveDegraded = 0;
      }
    } else {
      // Degraded — track consecutive degraded checks for chronic memory pressure alerting.
      // Does NOT count toward consecutiveFailures (only unreachable does).
      consecutiveDegraded++;
      const tier = body.memory_tier || 'unknown';
      log.warn({ degraded: consecutiveDegraded, heap_pct: body.heap_pct, tier, mcp: body.mcp, queue: body.queue_waiting }, 'degraded');

      // Alert on sustained degraded state (CHRONIC_DEGRADED_THRESHOLD consecutive = 30min)
      // Uses Memory Guardian tier from /healthz for smarter alerting
      const now = Date.now();
      const isCriticalTier = tier === 'critical' || tier === 'restart';
      const isSustained = consecutiveDegraded >= CHRONIC_DEGRADED_THRESHOLD;
      if ((isCriticalTier || isSustained) && (now - lastChronicAlertAt) > CHRONIC_ALERT_COOLDOWN_MS) {
        lastChronicAlertAt = now;
        const msg = isCriticalTier
          ? `*[Watchdog] Memory CRITICAL* 🔴 — heap ${body.heap_pct}%, tier: ${tier}. Consider restart.`
          : `*[Watchdog] Chronic memory pressure* ⚠️ — degraded for ${consecutiveDegraded * 5}min (heap ${body.heap_pct}%, tier: ${tier})`;
        await sendTelegram(msg);
      }
    }
  } catch (err) {
    consecutiveFailures++;
    log.warn({ err, failures: consecutiveFailures }, 'unreachable');
    await maybeAlert(`*[Watchdog] Sela unreachable* 🚨 — ${consecutiveFailures} consecutive failures.\nError: ${err.message.slice(0, 120)}`);
  }
}

async function maybeAlert(msg) {
  if (consecutiveFailures < ALERT_AFTER_FAILURES) return; // not yet
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) return; // cooldown active
  lastAlertAt = now;
  wasDown = true;
  await sendTelegram(msg);
}

// ── Zombie process detection ────────────────────────────────────────────────
const LOGS_DIR = resolve(__dirname, '..', 'logs');
const DUPLICATE_CHECK_INTERVAL_MS = 60_000; // 1 minute
let zombieKillCount = 0;

function getPm2SelaPid() {
  try {
    const raw = execSync('pm2 jlist', { timeout: 10_000, encoding: 'utf-8' });
    const procs = JSON.parse(raw);
    const sela = procs.find(p => p.name === 'sela' && p.pm2_env?.status === 'online');
    return sela?.pid || null;
  } catch {
    return null;
  }
}

function getTodayLogPath() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return resolve(LOGS_DIR, `app-${date}.log`);
}

function extractRecentPidsFrom440(logPath, windowMs) {
  try {
    if (!existsSync(logPath)) return [];
    const TAIL_BYTES = 64 * 1024;
    const fd = openSync(logPath, 'r');
    const stat = fstatSync(fd);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);

    const lines = buf.toString('utf-8').split('\n');
    const cutoff = Date.now() - windowMs;
    const pids = new Set();

    for (const line of lines) {
      if (!line.includes('"statusCode":440')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.statusCode === 440 && entry.time >= cutoff) {
          pids.add(entry.pid);
        }
      } catch {}
    }
    return [...pids];
  } catch {
    return [];
  }
}

function killPid(pid) {
  // Validate PID is a positive integer to prevent command injection via crafted log entries
  const pidNum = parseInt(pid, 10);
  if (!Number.isInteger(pidNum) || pidNum <= 0) return false;
  try {
    execSync(`taskkill /F /PID ${pidNum}`, { timeout: 5_000, encoding: 'utf-8', shell: 'cmd.exe' });
    return true;
  } catch {
    return false;
  }
}

async function checkDuplicateProcesses() {
  try {
    const pm2Pid = getPm2SelaPid();
    if (!pm2Pid) return;

    const logPath = getTodayLogPath();
    const recentPids = extractRecentPidsFrom440(logPath, 120_000); // last 2 min

    if (recentPids.length < 2) return; // need 2+ PIDs fighting to be a zombie issue

    const zombiePids = recentPids.filter(pid => pid !== pm2Pid);
    if (zombiePids.length === 0) return;

    log.warn({ pm2Pid, zombies: zombiePids }, 'ZOMBIE DETECTED');
    for (const zPid of zombiePids) {
      const killed = killPid(zPid);
      if (killed) {
        zombieKillCount++;
        log.warn({ pid: zPid }, 'Killed zombie sela process');
      }
    }

    // Fix stale .ipc-port if a zombie overwrote it
    try {
      if (existsSync(PORT_FILE)) {
        const portData = JSON.parse(readFileSync(PORT_FILE, 'utf-8'));
        if (portData.pid && portData.pid !== pm2Pid) {
          log.warn({ stalePid: portData.pid, expected: pm2Pid }, 'Stale .ipc-port — restarting sela to fix');
          execSync('pm2 restart sela --update-env', { timeout: 15_000, encoding: 'utf-8' });
          // Also restart dashboard so it picks up the new port
          setTimeout(() => {
            try {
              execSync('pm2 restart sela-dashboard', { timeout: 10_000, encoding: 'utf-8' });
              log.info('Restarted sela-dashboard after stale port fix');
            } catch {}
          }, 5000);
        }
      }
    } catch (e) {
      log.error({ err: e }, 'Failed to fix stale .ipc-port');
    }

    await sendTelegram(
      `*[Watchdog] Zombie sela killed* — ` +
      `${zombiePids.length} duplicate process(es) fighting over WhatsApp. ` +
      `Killed: ${zombiePids.join(', ')}. PM2 pid: ${pm2Pid}`
    );
  } catch (err) {
    log.error({ err }, 'Duplicate check error');
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────
log.info('Started — checking /healthz every 5 min, zombie scan every 1 min');
await checkHealth(); // immediate first check
await checkDuplicateProcesses();
setInterval(checkHealth, CHECK_INTERVAL_MS);
setInterval(checkDuplicateProcesses, DUPLICATE_CHECK_INTERVAL_MS);
