#!/usr/bin/env node
/**
 * Bot Dashboard — 3-panel control center on localhost:4242.
 * Proxies all /api/* requests to bot-ipc (random port).
 * Designed for Tailscale Serve exposure (no auth needed).
 */

import http from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { config } from 'dotenv';
import { LOGIN_HTML, AGENT_HTML, REVIEW_HTML, COST_ANALYTICS_HTML, BOARD_HTML, HISTORY_HTML, ERRORS_HTML, APPROVALS_HTML, IDEAS_HTML, CALENDAR_HTML, MEMORIES_HTML, PROJECTS_HTML, projectBoardHtml } from './lib/dashboard-html/index.js';
import { loadModules, getModuleDashboardPages } from './lib/module-loader.js';
import { getProject } from './lib/projects.js';

// Load .env for DASHBOARD_SECRET
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
config({ path: join(PROJECT_ROOT, '.env') });

const DASHBOARD_PORT = 4242;
const DATA_DIR = join(PROJECT_ROOT, 'data');
const PORT_FILE = join(DATA_DIR, '.ipc-port');
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET || '';
// Random session token — changes each restart, invalidating old cookies (more secure than deterministic hash)
const SESSION_TOKEN = DASHBOARD_SECRET ? randomBytes(32).toString('hex') : '';
// Timezone for client-side injection (mirrors lib/config.js logic)
const SELA_TZ = process.env.TIMEZONE || process.env.TZ || 'Asia/Jerusalem';
/** Inject window.__SELA_TZ and module nav links into an HTML page string */
function injectTZ(html) {
  let out = html.replace('</head>', `<script>window.__SELA_TZ=${JSON.stringify(SELA_TZ)}</script>\n</head>`);
  // Inject module nav links (evaluated at request time, after loadModules)
  const pages = getModuleDashboardPages();
  if (pages.length > 0) {
    // Escape HTML entities to prevent XSS via malicious module metadata
    const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    // Validate path starts with / and contains no dangerous chars
    const safePath = p => /^\/[a-zA-Z0-9\-_/]+$/.test(p) ? p : '#';
    const desktopLinks = pages.map(p => `<a href="${safePath(p.path)}" class="refresh-btn" style="text-decoration:none" title="${esc(p.title)}">${esc(p.icon)} ${esc(p.title)}</a>`).join('\n    ');
    const mobileLinks = pages.map(p => `<a href="${safePath(p.path)}" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">${esc(p.icon)}</span> ${esc(p.title)}</a>`).join('\n  ');
    out = out.replace('<!--MODULE_NAV_DESKTOP-->', desktopLinks);
    out = out.replace('<!--MODULE_NAV_MOBILE-->', mobileLinks);
  } else {
    out = out.replace('<!--MODULE_NAV_DESKTOP-->', '');
    out = out.replace('<!--MODULE_NAV_MOBILE-->', '');
  }
  return out;
}

if (!DASHBOARD_SECRET) {
  console.warn('WARNING: DASHBOARD_SECRET not set — dashboard has NO authentication!');
  console.warn('Set DASHBOARD_SECRET in .env to enable login protection.');
}

// --- Login rate limiting ---
const loginAttempts = new Map(); // ip → { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60_000; // 5 minutes

function checkLoginRate(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return true;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return false;
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) { loginAttempts.delete(ip); return true; }
  return entry.count < MAX_LOGIN_ATTEMPTS;
}

function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: null };
  entry.count++;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) entry.lockedUntil = Date.now() + LOCKOUT_MS;
  loginAttempts.set(ip, entry);
}

function clearLoginFailures(ip) { loginAttempts.delete(ip); }

// Prune stale entries every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginAttempts) {
    if (e.lockedUntil && now >= e.lockedUntil) loginAttempts.delete(ip);
  }
}, 600_000).unref();

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k] = v.join('=');
  });
  return cookies;
}

function isAuthenticated(req) {
  if (!DASHBOARD_SECRET) return true; // no auth configured
  const cookies = parseCookies(req);
  return cookies.dash_session === SESSION_TOKEN;
}


function getIpcConfig() {
  try {
    const raw = readFileSync(PORT_FILE, 'utf-8').trim();
    if (raw.startsWith('{')) {
      const config = JSON.parse(raw);
      return { port: config.port, token: config.token };
    }
    return { port: parseInt(raw), token: null };
  } catch {
    return null;
  }
}

function proxyToIpc(req, res, targetPath, targetMethod) {
  const ipcConfig = getIpcConfig();
  if (!ipcConfig) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bot offline' }));
    return;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (ipcConfig.token) {
    headers['Authorization'] = `Bearer ${ipcConfig.token}`;
  }

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: ipcConfig.port,
    path: targetPath,
    method: targetMethod || req.method,
    headers,
    timeout: 35000,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'application/json',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bot offline' }));
  });
  proxyReq.on('timeout', () => { proxyReq.destroy(); });

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Agent Dashboard</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>🤖</text></svg>">
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@400;500;700;800&display=swap');

  :root {
    --bg: #0a0a0f;
    --surface: #111118;
    --surface2: #16161f;
    --border: #1e1e2e;
    --border2: #2a2a3e;
    --text: #e2e2f0;
    --text2: #8888aa;
    --text3: #444466;
    --accent: #7c6af7;
    --accent2: #a78bfa;
    --green: #22d3a0;
    --yellow: #f59e0b;
    --red: #f43f5e;
    --cyan: #22d3ee;
    --font-display: 'Syne', sans-serif;
    --font-mono: 'JetBrains Mono', monospace;
    --radius: 8px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.6;
    min-height: 100vh;
    overflow-x: hidden;
  }

  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 9999;
    opacity: 0.35;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header-left { display: flex; align-items: center; gap: 12px; }

  .logo {
    width: 30px; height: 30px;
    background: linear-gradient(135deg, var(--accent), var(--cyan));
    border-radius: 7px;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--font-display);
    font-weight: 800; font-size: 15px; color: white;
    box-shadow: 0 0 16px rgba(124,106,247,0.35);
  }

  .header-title { font-family: var(--font-display); font-weight: 700; font-size: 16px; letter-spacing: -0.3px; }
  .header-sub { color: var(--text3); font-size: 10px; margin-top: 1px; }
  .header-right { display: flex; align-items: center; gap: 14px; }

  .status-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--green); box-shadow: 0 0 7px var(--green);
    animation: pulse 2s ease-in-out infinite;
  }
  .status-dot.offline { background: var(--red); box-shadow: 0 0 7px var(--red); animation: none; }

  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  @keyframes spin { to{transform:rotate(360deg)} }
  @keyframes fadeUp { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
  @keyframes slideIn { from{transform:translateX(16px);opacity:0} to{transform:translateX(0);opacity:1} }

  .refresh-btn {
    background: var(--surface2); border: 1px solid var(--border);
    color: var(--text2); padding: 5px 12px; border-radius: var(--radius);
    cursor: pointer; font-family: var(--font-mono); font-size: 11px;
    transition: all 0.15s; display: flex; align-items: center; gap: 5px;
  }
  .refresh-btn:hover { border-color: var(--accent); color: var(--accent2); }

  .last-updated { color: var(--text3); font-size: 10px; }

  .layout {
    display: grid;
    grid-template-columns: 320px 1fr;
    height: calc(100vh - 61px);
  }

  .panel {
    border-right: 1px solid var(--border);
    overflow-y: auto; padding: 18px;
    display: flex; flex-direction: column; gap: 14px;
  }
  .panel:last-child { border-right: none; }

  ::-webkit-scrollbar { width: 3px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 2px; }

  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 14px;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: var(--border2); }

  .card-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 11px;
  }

  .card-title {
    font-family: var(--font-display); font-weight: 600; font-size: 11px;
    text-transform: uppercase; letter-spacing: 1.2px; color: var(--text2);
    display: flex; align-items: center; gap: 7px;
  }
  .card-title .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }

  .card-action {
    background: none; border: 1px solid var(--border); color: var(--text3);
    padding: 3px 9px; border-radius: 4px; cursor: pointer;
    font-family: var(--font-mono); font-size: 10px; transition: all 0.15s;
  }
  .card-action:hover { border-color: var(--accent); color: var(--accent2); }

  .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }

  .metric {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 6px; padding: 9px 11px;
  }
  .metric-label { color: var(--text3); font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; }
  .metric-value { font-size: 17px; font-weight: 700; letter-spacing: -0.8px; }
  .metric-value.green { color: var(--green); }
  .metric-value.accent { color: var(--accent2); }
  .metric-value.red { color: var(--red); }
  .metric-sub { color: var(--text3); font-size: 9px; margin-top: 1px; }

  .cron-item {
    padding: 9px 11px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 6px;
    margin-bottom: 5px; transition: all 0.15s;
  }
  .cron-item:hover { border-color: var(--border2); }
  .cron-item.disabled { opacity: 0.4; }
  .cron-top { display: flex; align-items: center; gap: 8px; }

  .cron-ring {
    width: 28px; height: 28px; position: relative;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .cron-ring svg { position: absolute; inset: 0; transform: rotate(-90deg); }
  .cron-ring .rate { position: relative; z-index: 1; font-size: 7px; font-weight: 700; }

  .cron-info { flex: 1; min-width: 0; }
  .cron-name { font-size: 12px; font-weight: 600; }
  .cron-meta { color: var(--text3); font-size: 10px; margin-top: 3px; line-height: 1.5; }

  .cron-actions { display: flex; gap: 3px; flex-shrink: 0; }

  .icon-btn {
    background: none; border: 1px solid var(--border); color: var(--text3);
    width: 24px; height: 24px; border-radius: 4px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; transition: all 0.15s;
  }
  .icon-btn:hover { border-color: var(--accent); color: var(--accent2); }
  .icon-btn.danger:hover { border-color: var(--red); color: var(--red); }

  .notes-feed {
    display: flex; flex-direction: column; gap: 5px;
    overflow-y: auto;
  }
  @media (max-width: 900px) {
    .notes-feed { max-height: 500px; }
  }

  .note-entry {
    padding: 8px 10px; background: var(--surface2);
    border-left: 2px solid var(--border2);
    border-radius: 0 4px 4px 0; font-size: 11px;
    line-height: 1.5; color: var(--text2);
    animation: fadeUp 0.25s ease;
    cursor: pointer; transition: all 0.15s;
  }
  .note-entry:hover { border-left-color: var(--accent); }
  .note-time { color: var(--accent); font-weight: 500; }

  .user-note-input { display: flex; gap: 6px; margin-bottom: 10px; }
  .user-note-input .input { flex: 1; }

  .user-note-item {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 10px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 6px;
    margin-bottom: 5px; animation: fadeUp 0.2s ease;
  }
  .user-note-text { flex: 1; font-size: 12px; line-height: 1.5; color: var(--text); word-break: break-word; }
  .user-note-time { color: var(--text3); font-size: 10px; white-space: nowrap; flex-shrink: 0; }

  .goal-item {
    padding: 11px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 6px;
    margin-bottom: 7px; cursor: pointer; transition: all 0.15s;
  }
  .goal-item:hover { border-color: var(--border2); }

  .goal-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 7px; margin-bottom: 7px; }
  .goal-title { font-weight: 500; font-size: 12px; flex: 1; }

  .badge {
    font-size: 9px; padding: 2px 5px; border-radius: 3px;
    text-transform: uppercase; letter-spacing: 0.4px; flex-shrink: 0;
  }
  .badge.high { background: rgba(244,63,94,0.12); color: var(--red); border: 1px solid rgba(244,63,94,0.18); }
  .badge.medium { background: rgba(245,158,11,0.12); color: var(--yellow); border: 1px solid rgba(245,158,11,0.18); }
  .badge.low { background: rgba(34,211,160,0.08); color: var(--green); border: 1px solid rgba(34,211,160,0.12); }

  .status-badge {
    display: inline-block; font-size: 9px; padding: 2px 7px; border-radius: 3px;
    text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600;
  }
  .status-badge.s-draft { background: rgba(136,136,170,0.12); color: var(--text3); border: 1px solid rgba(136,136,170,0.18); }
  .status-badge.s-pending { background: rgba(245,158,11,0.12); color: var(--yellow); border: 1px solid rgba(245,158,11,0.18); }
  .status-badge.s-active { background: rgba(124,106,247,0.12); color: var(--accent2); border: 1px solid rgba(124,106,247,0.18); }
  .status-badge.s-in_progress { background: rgba(34,211,238,0.12); color: var(--cyan); border: 1px solid rgba(34,211,238,0.18); }
  .status-badge.s-blocked { background: rgba(245,158,11,0.18); color: #f97316; border: 1px solid rgba(249,115,22,0.25); }
  .status-badge.s-completed { background: rgba(34,211,160,0.12); color: var(--green); border: 1px solid rgba(34,211,160,0.18); }
  .status-badge.s-abandoned { background: rgba(244,63,94,0.12); color: var(--red); border: 1px solid rgba(244,63,94,0.18); }

  .goal-transitions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 14px; }
  .goal-transitions button {
    font-family: var(--font-mono); font-size: 10px; padding: 5px 10px;
    border-radius: 5px; border: 1px solid var(--border2); background: var(--surface2);
    color: var(--text2); cursor: pointer; transition: all 0.15s; font-weight: 500;
  }
  .goal-transitions button:hover { border-color: var(--accent); color: var(--text); }
  .goal-transitions button.t-pending { color: var(--yellow); border-color: rgba(245,158,11,0.3); }
  .goal-transitions button.t-pending:hover { background: rgba(245,158,11,0.1); }
  .goal-transitions button.t-active { color: var(--accent2); border-color: rgba(124,106,247,0.3); }
  .goal-transitions button.t-active:hover { background: rgba(124,106,247,0.1); }
  .goal-transitions button.t-in_progress { color: var(--cyan); border-color: rgba(34,211,238,0.3); }
  .goal-transitions button.t-in_progress:hover { background: rgba(34,211,238,0.1); }
  .goal-transitions button.t-blocked { color: #f97316; border-color: rgba(249,115,22,0.3); }
  .goal-transitions button.t-blocked:hover { background: rgba(249,115,22,0.1); }
  .goal-transitions button.t-completed { color: var(--green); border-color: rgba(34,211,160,0.3); }
  .goal-transitions button.t-completed:hover { background: rgba(34,211,160,0.1); }
  .goal-transitions button.t-abandoned { color: var(--red); border-color: rgba(244,63,94,0.3); }
  .goal-transitions button.t-abandoned:hover { background: rgba(244,63,94,0.1); }

  .progress-bar { height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; margin-bottom: 5px; }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--cyan));
    border-radius: 2px; transition: width 0.6s ease;
  }

  .goal-meta { color: var(--text3); font-size: 10px; display: flex; gap: 8px; flex-wrap: wrap; }

  .soul-editor {
    width: 100%; background: var(--surface2); border: 1px solid var(--border);
    border-radius: 6px; padding: 11px; color: var(--text);
    font-family: var(--font-mono); font-size: 11px; line-height: 1.7;
    resize: vertical; min-height: 180px; outline: none; transition: border-color 0.15s;
  }
  .soul-editor:focus { border-color: var(--accent); }

  .btn {
    padding: 6px 13px; border-radius: var(--radius); cursor: pointer;
    font-family: var(--font-mono); font-size: 11px; border: 1px solid;
    transition: all 0.15s; display: inline-flex; align-items: center; gap: 5px;
  }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
  .btn-primary:hover { background: var(--accent2); border-color: var(--accent2); }
  .btn-ghost { background: transparent; border-color: var(--border); color: var(--text2); }
  .btn-ghost:hover { border-color: var(--border2); color: var(--text); }

  .tabs {
    display: flex; gap: 2px; background: var(--surface2);
    padding: 3px; border-radius: 6px; border: 1px solid var(--border);
    margin-bottom: 14px;
  }
  .tab {
    flex: 1; padding: 5px 10px; border-radius: 4px; border: none;
    background: none; color: var(--text3); font-family: var(--font-mono);
    font-size: 10px; cursor: pointer; transition: all 0.15s; text-align: center;
  }
  .tab.active { background: var(--surface); color: var(--text); border: 1px solid var(--border2); }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  .review-item {
    padding: 9px 11px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px;
  }
  .review-date { color: var(--accent); font-size: 10px; margin-bottom: 3px; }
  .review-notes { color: var(--text2); font-size: 11px; line-height: 1.5; }

  .outcome-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-bottom: 11px; }
  .outcome-stat { text-align: center; padding: 9px 5px; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; }
  .outcome-stat-value { font-size: 20px; font-weight: 700; letter-spacing: -1px; color: var(--accent2); }
  .outcome-stat-label { color: var(--text3); font-size: 9px; text-transform: uppercase; letter-spacing: 0.4px; margin-top: 2px; }

  .workflow-item {
    padding: 9px 11px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px; cursor: pointer;
  }
  .workflow-item:hover { border-color: var(--accent); }
  .wf-header { display: flex; align-items: center; gap: 9px; }
  .wf-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .wf-dot.running { background: var(--green); box-shadow: 0 0 5px var(--green); animation: pulse 1.5s infinite; }
  .wf-dot.pending { background: var(--yellow); }
  .wf-dot.paused { background: var(--yellow); }
  .wf-dot.failed { background: var(--red); }
  .wf-dot.completed { background: var(--text3); }
  .wf-dot.cancelled { background: var(--text3); }
  .wf-meta { color: var(--text3); font-size: 10px; margin-top: 4px; display: flex; gap: 12px; }
  .wf-steps { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
  .wf-step { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 11px; }
  .wf-step-icon { width: 14px; text-align: center; flex-shrink: 0; }
  .wf-step-desc { color: var(--text2); flex: 1; }
  .wf-step-time { color: var(--text3); font-size: 10px; }
  .wf-error { color: var(--red); font-size: 11px; margin-top: 6px; padding: 5px 8px; background: rgba(239,68,68,0.1); border-radius: 4px; }
  .wf-actions { display: flex; gap: 6px; margin-top: 6px; }
  .wf-actions button { font-size: 10px; padding: 3px 8px; border: 1px solid var(--border); background: var(--surface1); color: var(--text2); border-radius: 4px; cursor: pointer; }
  .wf-actions button:hover { border-color: var(--accent); color: var(--accent); }

  .proposal-item {
    padding: 9px 11px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 6px; margin-bottom: 5px;
  }
  .proposal-topic { font-size: 11px; margin-bottom: 3px; }
  .proposal-meta { display: flex; align-items: center; gap: 7px; font-size: 10px; color: var(--text3); }
  .p-badge { padding: 1px 5px; border-radius: 3px; font-size: 9px; }
  .p-badge.approved { background: rgba(34,211,160,0.1); color: var(--green); }
  .p-badge.rejected { background: rgba(244,63,94,0.1); color: var(--red); }
  .p-badge.pending { background: rgba(245,158,11,0.1); color: var(--yellow); }

  .history-date-item {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 11px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 6px;
    margin-bottom: 5px; cursor: pointer; transition: all 0.15s;
  }
  .history-date-item:hover { border-color: var(--border2); background: var(--surface); }
  .history-date-item.selected { border-color: var(--accent); }
  .history-date-label { flex: 1; font-size: 12px; font-weight: 500; }
  .history-date-cost { color: var(--accent2); font-size: 11px; font-weight: 600; }
  .history-date-turns { color: var(--text3); font-size: 10px; }

  .toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 9998; display: flex; flex-direction: column; gap: 6px; }
  .toast {
    background: var(--surface2); border: 1px solid var(--border2);
    padding: 9px 14px; border-radius: var(--radius); font-size: 12px; color: var(--text);
    animation: slideIn 0.2s ease; display: flex; align-items: center; gap: 7px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  }
  .toast.success { border-color: rgba(34,211,160,0.25); }
  .toast.error { border-color: rgba(244,63,94,0.25); }

  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.65);
    z-index: 200; display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(4px); opacity: 0; pointer-events: none; transition: opacity 0.2s;
  }
  .modal-overlay.open { opacity: 1; pointer-events: all; }
  .modal {
    background: var(--surface); border: 1px solid var(--border2);
    border-radius: 10px; padding: 22px; width: 480px; max-width: 92vw;
    max-height: 80vh; overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 40px rgba(124,106,247,0.06);
    transform: translateY(10px); transition: transform 0.2s;
  }
  .modal-overlay.open .modal { transform: translateY(0); }
  .modal-title {
    font-family: var(--font-display); font-weight: 700; font-size: 15px;
    margin-bottom: 14px; display: flex; align-items: center; justify-content: space-between;
  }
  .modal-close { background: none; border: none; color: var(--text3); cursor: pointer; font-size: 17px; transition: color 0.15s; }
  .modal-close:hover { color: var(--text); }

  .input {
    width: 100%; background: var(--surface2); border: 1px solid var(--border);
    border-radius: 6px; padding: 7px 11px; color: var(--text);
    font-family: var(--font-mono); font-size: 12px; outline: none; transition: border-color 0.15s;
  }
  .input:focus { border-color: var(--accent); }

  .section-label {
    font-family: var(--font-display); font-size: 9px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 1.5px; color: var(--text3);
    padding: 6px 0 5px; border-bottom: 1px solid var(--border); margin-bottom: 9px;
  }

  .empty { color: var(--text3); font-size: 11px; text-align: center; padding: 16px; }
  .loading { color: var(--text3); font-size: 11px; display: flex; align-items: center; gap: 7px; }
  .spinner { width: 11px; height: 11px; border: 2px solid var(--border2); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }

  .row { display: flex; justify-content: space-between; align-items: center; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 11px; }
  .row:last-child { border-bottom: none; }
  .row-label { color: var(--text3); }

  .svc-item {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 9px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 6px;
    margin-bottom: 4px; font-size: 11px;
  }
  .svc-dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
  }
  .svc-dot.connected, .svc-dot.running, .svc-dot.active { background: var(--green); box-shadow: 0 0 5px var(--green); }
  .svc-dot.disconnected, .svc-dot.disabled { background: var(--red); }
  .svc-name { flex: 1; color: var(--text2); }
  .svc-status { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; }
  .svc-status.connected, .svc-status.running, .svc-status.active { color: var(--green); }
  .svc-status.disconnected { color: var(--red); }
  .svc-status.disabled { color: var(--text3); }

  /* Burger menu — mobile only */
  .burger {
    display: none; background: none; border: 1px solid var(--border);
    color: var(--text2); width: 32px; height: 32px; border-radius: 6px;
    cursor: pointer; flex-direction: column; align-items: center;
    justify-content: center; gap: 4px; transition: all 0.15s;
  }
  .burger span {
    display: block; width: 16px; height: 1.5px; background: var(--text2);
    border-radius: 1px; transition: all 0.2s;
  }
  .burger:hover { border-color: var(--accent); }
  .burger:hover span { background: var(--accent2); }
  .burger.open span:nth-child(1) { transform: translateY(5.5px) rotate(45deg); }
  .burger.open span:nth-child(2) { opacity: 0; }
  .burger.open span:nth-child(3) { transform: translateY(-5.5px) rotate(-45deg); }

  .mobile-nav {
    display: none; position: fixed; top: 61px; left: 0; right: 0;
    background: var(--surface); border-bottom: 1px solid var(--border2);
    z-index: 99; flex-direction: column; padding: 8px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.5);
  }
  .mobile-nav.open { display: flex; }
  .mobile-nav-item {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 14px; border-radius: 6px; border: none;
    background: none; color: var(--text2); font-family: var(--font-mono);
    font-size: 12px; cursor: pointer; transition: all 0.15s; text-align: left;
  }
  .mobile-nav-item:hover, .mobile-nav-item.active { background: var(--surface2); color: var(--text); }
  .mobile-nav-item .nav-icon {
    width: 28px; height: 28px; border-radius: 6px;
    background: var(--surface2); border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; flex-shrink: 0;
  }
  .mobile-nav-item.active .nav-icon { border-color: var(--accent); background: rgba(124,106,247,0.1); }

  .header-right { flex-shrink: 0; }

  @media (max-width: 900px) {
    .burger { display: flex; }
    .header { padding: 14px 16px; gap: 8px; }
    .header-sub { display: none; }
    .header-right { gap: 8px; }
    .header-right .refresh-btn { display: none; }
    .header-right .last-updated { display: none; }
    .layout { grid-template-columns: 1fr; height: auto; }
    .panel { border-right: none; border-bottom: 1px solid var(--border); display: none; padding: 12px; }
    .panel.mobile-active { display: flex; }
    #kanbanBoard { grid-template-columns: 1fr !important; }
  }

  /* Kanban columns */
  .kanban-col { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 8px; min-height: 120px; }
  .kanban-col-header { display: flex; align-items: center; justify-content: space-between; padding: 4px 6px 8px; }
  .kanban-col-label { font-family: var(--font-display); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .kanban-col-count { font-size: 10px; color: var(--text3); background: var(--bg); padding: 1px 6px; border-radius: 3px; }
  .kanban-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 9px 10px; margin-bottom: 6px; animation: fadeUp 0.2s ease; }
  .kanban-card:hover { border-color: var(--border2); }
  .kanban-card-title { font-size: 12px; font-weight: 500; margin-bottom: 4px; }
  .kanban-card-meta { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; }
  .kanban-card-actions { display: flex; gap: 3px; flex-wrap: wrap; }
  .kanban-card-actions button { background: var(--surface2); border: 1px solid var(--border); color: var(--text3); padding: 2px 7px; border-radius: 3px; cursor: pointer; font-family: var(--font-mono); font-size: 9px; transition: all 0.15s; }
  .kanban-card-actions button:hover { border-color: var(--accent); color: var(--accent2); }

  /* Activity timeline */
  .act-entry { padding: 8px 10px; background: var(--surface2); border-left: 2px solid var(--border2); border-radius: 0 4px 4px 0; margin-bottom: 5px; animation: fadeUp 0.2s ease; }
  .act-entry.proposal { border-left-color: var(--accent); }
  .act-entry.cost { border-left-color: var(--green); }
  .act-entry.system { border-left-color: var(--yellow); }
  .act-entry.interaction { border-left-color: var(--cyan); }
  .act-badge { display: inline-block; font-size: 9px; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; margin-right: 6px; }
  .act-badge.proposal { background: rgba(124,106,247,0.15); color: var(--accent2); }
  .act-badge.cost { background: rgba(34,211,160,0.12); color: var(--green); }
  .act-badge.system { background: rgba(245,158,11,0.12); color: var(--yellow); }
  .act-badge.interaction { background: rgba(34,211,238,0.12); color: var(--cyan); }

  /* Approvals */
  .approval-card { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 11px; margin-bottom: 7px; animation: fadeUp 0.2s ease; }
  .approval-card:hover { border-color: var(--border2); }
  .approval-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .approval-title { font-size: 12px; font-weight: 500; flex: 1; }
  .approval-source { font-size: 9px; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; flex-shrink: 0; }
  .approval-source.agent { background: rgba(124,106,247,0.15); color: var(--accent2); }
  .approval-source.manual { background: var(--surface); color: var(--text3); border: 1px solid var(--border); }
  .confidence-bar { height: 3px; border-radius: 2px; background: var(--border); overflow: hidden; margin: 4px 0; }
  .confidence-fill { height: 100%; border-radius: 2px; transition: width 0.3s; }
  .approval-actions { display: flex; gap: 4px; margin-top: 6px; }
  .approval-actions button { padding: 3px 10px; border-radius: 4px; cursor: pointer; font-family: var(--font-mono); font-size: 10px; border: 1px solid var(--border); transition: all 0.15s; }
  .btn-approve { background: rgba(34,211,160,0.12); color: var(--green); }
  .btn-approve:hover { background: rgba(34,211,160,0.25); border-color: var(--green); }
  .btn-reject { background: rgba(244,63,94,0.12); color: var(--red); }
  .btn-reject:hover { background: rgba(244,63,94,0.25); border-color: var(--red); }
  .badge-pattern { font-size: 9px; color: var(--text3); background: var(--bg); padding: 1px 5px; border-radius: 3px; }
</style>
</head>
<body>

<header class="header">
  <div class="header-left">
    <div class="logo">A</div>
    <div>
      <div class="header-title">Agent Dashboard</div>
      <div class="header-sub">sela control center</div>
    </div>
  </div>
  <div class="header-right">
    <div class="status-dot" id="statusDot"></div>
    <span class="last-updated" id="lastUpdated">&mdash;</span>
    <a href="/projects" class="refresh-btn" style="text-decoration:none" title="Projects">&#x1f4c1; Projects</a>
    <a href="/board" class="refresh-btn" style="text-decoration:none" title="Goals Board">&#x25a6; Board</a>
    <a href="/agent" class="refresh-btn" style="text-decoration:none" title="Agent Loop Monitor">&loz; Agent</a>
    <a href="/calendar" class="refresh-btn" style="text-decoration:none" title="Calendar &amp; Crons">&#x1f4c5; Calendar</a>
    <a href="/memories" class="refresh-btn" style="text-decoration:none" title="Memory Browser">&#x1f9e0; Memory</a>
    <!--MODULE_NAV_DESKTOP-->
    <a href="/logout" class="refresh-btn" style="text-decoration:none;font-size:10px;padding:4px 9px" title="Sign out">&raquo; Logout</a>
    <button class="burger" id="burgerBtn" onclick="toggleMobileNav()">
      <span></span><span></span><span></span>
    </button>
  </div>
</header>

<nav class="mobile-nav" id="mobileNav">
  <button class="mobile-nav-item active" onclick="showPanel(0, this)"><span class="nav-icon">&para;</span> Status &amp; Health</button>
  <button class="mobile-nav-item" onclick="showPanel(1, this)"><span class="nav-icon">&equiv;</span> Notes &amp; Soul</button>
  <a href="/projects" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">&#x1f4c1;</span> Projects</a>
  <a href="/board" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">&#x25a6;</span> Goals Board</a>
  <a href="/analytics" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">&dollar;</span> Cost Analytics</a>
  <a href="/agent" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">&loz;</span> Agent Loop</a>
  <a href="/review" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">&Delta;</span> Code Review</a>
  <a href="/history" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">&#x23f0;</span> History</a>
  <a href="/calendar" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">&#x1f4c5;</span> Calendar</a>
  <a href="/memories" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">&#x1f9e0;</span> Memories</a>
  <a href="/approvals" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">&#x2713;</span> Approvals</a>
  <a href="/ideas" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">&#9733;</span> Ideas</a>
  <!--MODULE_NAV_MOBILE-->
  <a href="/errors" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">&#x26a0;</span> Errors</a>
  <a href="/logout" class="mobile-nav-item" style="text-decoration:none"><span class="nav-icon">&raquo;</span> Logout</a>
</nav>

<div class="layout">

  <!-- LEFT: Status + Crons -->
  <div class="panel mobile-active" id="panel-0">

    <div class="card">
      <div class="card-header">
        <div class="card-title"><span class="dot"></span>Bot Status</div>
      </div>
      <div class="metrics" id="statusMetrics">
        <div class="loading"><div class="spinner"></div> Loading...</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title"><span class="dot"></span>Runtime</div>
      </div>
      <div id="runtimeInfo"><div class="loading"><div class="spinner"></div></div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title"><span class="dot"></span>Services</div>
        <button class="card-action" onclick="loadServices()">&circlearrowright;</button>
      </div>
      <div id="serviceList"><div class="loading"><div class="spinner"></div></div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title"><span class="dot"></span>Cron Jobs</div>
        <button class="card-action" onclick="openModal('addCronModal')">+ Add</button>
      </div>
      <div id="cronList"><div class="loading"><div class="spinner"></div> Loading...</div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title"><span class="dot"></span>Cron Health</div>
        <button class="card-action" onclick="loadCronHealth()">&circlearrowright;</button>
      </div>
      <div id="cronHealthList"><div class="empty">No health data yet</div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title"><span class="dot"></span>Test Suite</div>
        <button class="card-action" onclick="runTests()" id="testRunBtn">&triangleright; Run All</button>
      </div>
      <div id="testResults"><div class="loading"><div class="spinner"></div> Loading...</div></div>
    </div>

  </div>

  <!-- CENTER: Tabs -->
  <div class="panel" id="panel-1" style="border-right:1px solid var(--border)">

    <div class="tabs">
      <button class="tab active" onclick="switchTab('notes')">Notes</button>
      <button class="tab" onclick="switchTab('memory')">Memory</button>
      <button class="tab" onclick="switchTab('soul')">Soul</button>
      <button class="tab" onclick="switchTab('activity')">Activity</button>
      <button class="tab" onclick="switchTab('workflows')">Workflows</button>
      <button class="tab" onclick="switchTab('outcomes')">Outcomes</button>
    </div>

    <!-- Notes -->
    <div class="tab-content active" id="tab-notes">
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="dot"></span>My Notes</div>
          <button class="card-action" onclick="loadUserNotes()">&circlearrowright;</button>
        </div>
        <div class="user-note-input">
          <input class="input" id="userNoteInput" type="text" placeholder="Add a note..." onkeydown="if(event.key==='Enter')addUserNote()">
          <button class="btn btn-primary" onclick="addUserNote()" style="padding:6px 10px">Add</button>
        </div>
        <div id="userNoteList"><div class="empty">No notes yet</div></div>
      </div>
    </div>

    <!-- Memory Browser -->
    <div class="tab-content" id="tab-memory">
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="dot"></span>Memory Search</div>
          <button class="card-action" onclick="loadMemoryTimeline()">&circlearrowright; Recent</button>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:11px">
          <input class="input" id="memSearchInput" type="text" placeholder="Search memories..." onkeydown="if(event.key==='Enter')searchMemories()">
          <button class="btn btn-primary" onclick="searchMemories()" style="padding:6px 10px;flex-shrink:0">Search</button>
        </div>
        <div id="memStats" style="margin-bottom:8px"></div>
        <div id="memResults"><div class="empty">Search or browse recent memories</div></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-header">
          <div class="card-title"><span class="dot"></span>Ingest Memory</div>
        </div>
        <textarea class="input" id="memIngestContent" placeholder="Enter content to remember..." style="min-height:60px;resize:vertical;margin-bottom:8px"></textarea>
        <div style="display:flex;gap:6px">
          <input class="input" id="memIngestTags" type="text" placeholder="Tags (comma-separated)" style="flex:1">
          <select class="input" id="memIngestType" style="width:auto;padding:6px 8px">
            <option value="fact">Fact</option>
            <option value="preference">Preference</option>
            <option value="event">Event</option>
            <option value="decision">Decision</option>
          </select>
          <button class="btn btn-primary" onclick="ingestMemory()" style="flex-shrink:0">Save</button>
        </div>
      </div>
    </div>

    <!-- Soul -->
    <div class="tab-content" id="tab-soul">
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="dot"></span>Proactive Behavior</div>
          <div style="display:flex;gap:5px;">
            <button class="card-action" onclick="rollbackSoul()">&hookleftarrow; Rollback</button>
            <button class="card-action" onclick="runReview()">&zap; Review</button>
          </div>
        </div>
        <textarea class="soul-editor" id="soulEditor" placeholder="Loading..."></textarea>
        <div style="display:flex;gap:7px;margin-top:8px;">
          <button class="btn btn-primary" onclick="saveSoul()">Save to SOUL.md</button>
          <button class="btn btn-ghost" onclick="loadSoul()">&circlearrowright; Reload</button>
        </div>
        <div style="margin-top:7px;color:var(--text3);font-size:10px;">Changes reload within 5 min &middot; session resets automatically</div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-header">
          <div class="card-title"><span class="dot"></span>Review History</div>
        </div>
        <div id="reviewHistory"><div class="loading"><div class="spinner"></div></div></div>
      </div>
    </div>

    <!-- Activity Log -->
    <div class="tab-content" id="tab-activity">
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="dot"></span>Live Activity</div>
          <div style="display:flex;gap:6px">
            <button class="card-action" onclick="snapshotActivity()">&#x1f4f7; Snapshot</button>
            <button class="card-action" onclick="loadActivity()">&circlearrowright;</button>
          </div>
        </div>
        <div class="metrics" id="activityStats" style="margin-bottom:12px">
          <div class="metric"><div class="metric-label">Uptime</div><div class="metric-value accent" id="actUptime">&mdash;</div></div>
          <div class="metric"><div class="metric-label">Today's Cost</div><div class="metric-value green" id="actCost">&mdash;</div></div>
          <div class="metric"><div class="metric-label">Queue</div><div class="metric-value" id="actQueue">&mdash;</div></div>
          <div class="metric"><div class="metric-label">MCP</div><div class="metric-value" id="actMcp">&mdash;</div></div>
        </div>
        <div id="activityTimeline" class="notes-feed" style="max-height:440px;overflow-y:auto">
          <div class="empty">No activity yet &mdash; click Snapshot to capture</div>
        </div>
      </div>
    </div>

    <div class="tab-content" id="tab-workflows">
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="dot"></span>Active Workflows</div>
          <button class="card-action" onclick="loadWorkflows()">&circlearrowright;</button>
        </div>
        <div id="workflowList"><div class="loading"><div class="spinner"></div></div></div>
      </div>
    </div>

    <!-- Outcomes -->
    <div class="tab-content" id="tab-outcomes">
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="dot"></span>Outcome Learning (7d)</div>
          <button class="card-action" onclick="loadOutcomes()">&circlearrowright;</button>
        </div>
        <div class="outcome-stats" id="outcomeStats">
          <div class="loading"><div class="spinner"></div></div>
        </div>
        <div id="proposalList"></div>
      </div>
    </div>

    <!-- History -->
  </div>

  <!-- Goals panel removed — merged into Board tab -->
</div>

<!-- Toasts -->
<div class="toast-container" id="toastContainer"></div>

<!-- Add Cron Modal -->
<div class="modal-overlay" id="addCronModal">
  <div class="modal">
    <div class="modal-title">
      Add Cron Job
      <button class="modal-close" onclick="closeModal('addCronModal')">&times;</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div>
        <div style="color:var(--text3);font-size:10px;margin-bottom:3px;">Name</div>
        <input class="input" id="cronName" type="text" placeholder="my-daily-brief">
      </div>
      <div>
        <div style="color:var(--text3);font-size:10px;margin-bottom:3px;">Schedule (cron expression)</div>
        <input class="input" id="cronSchedule" type="text" placeholder="0 9 * * 1-5">
      </div>
      <div>
        <div style="color:var(--text3);font-size:10px;margin-bottom:3px;">Prompt</div>
        <textarea class="input" id="cronPrompt" placeholder="What should run at this time?" style="min-height:70px;resize:vertical;"></textarea>
      </div>
      <div style="display:flex;gap:7px;">
        <button class="btn btn-primary" onclick="addCron()" style="flex:1">Add Cron</button>
        <button class="btn btn-ghost" onclick="closeModal('addCronModal')">Cancel</button>
      </div>
    </div>
  </div>
</div>

<!-- Goal Modal -->
<div class="modal-overlay" id="goalModal">
  <div class="modal">
    <div class="modal-title">
      <span id="goalModalTitle">Goal</span>
      <button class="modal-close" onclick="closeModal('goalModal')">&times;</button>
    </div>
    <div id="goalModalContent"></div>
  </div>
</div>

<script>
  const API = '/api';

  async function api(path, opts = {}) {
    const r = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (!r.ok) throw new Error(r.status + '');
    return r.json();
  }

  function toast(msg, type) {
    type = type || 'info';
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    var color = type === 'success' ? 'var(--green)' : type === 'error' ? 'var(--red)' : 'var(--accent2)';
    var icon = type === 'success' ? '\\u2713' : type === 'error' ? '\\u2715' : '\\u2139';
    el.innerHTML = '<span style="color:' + color + '">' + icon + '</span>' + msg;
    document.getElementById('toastContainer').appendChild(el);
    setTimeout(function() { el.remove(); }, 3000);
  }

  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }

  // --- Mobile burger menu ---
  function toggleMobileNav() {
    var btn = document.getElementById('burgerBtn');
    var nav = document.getElementById('mobileNav');
    btn.classList.toggle('open');
    nav.classList.toggle('open');
  }

  function showPanel(idx, el) {
    document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('mobile-active'); });
    var panel = document.getElementById('panel-' + idx);
    if (panel) panel.classList.add('mobile-active');
    document.querySelectorAll('.mobile-nav-item').forEach(function(i) { i.classList.remove('active'); });
    if (el) el.classList.add('active');
    // Close menu
    document.getElementById('burgerBtn').classList.remove('open');
    document.getElementById('mobileNav').classList.remove('open');
    // Scroll to top
    window.scrollTo(0, 0);
  }

  function switchTab(name) {
    var names = ['notes','memory','soul','activity','workflows','outcomes'];
    document.querySelectorAll('.tab').forEach(function(t,i) { t.classList.toggle('active', names[i] === name); });
    document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
    document.getElementById('tab-' + name).classList.add('active');
    if (name === 'memory') loadMemoryTimeline();
    if (name === 'soul') { loadSoul(); loadReviewHistory(); }
    if (name === 'activity') loadActivity();
    if (name === 'workflows') loadWorkflows();
    if (name === 'outcomes') loadOutcomes();
  }

  function cronRing(rate) {
    var r = 10, c = 2 * Math.PI * r;
    var filled = (rate / 100) * c;
    var color = rate >= 50 ? 'var(--green)' : rate >= 20 ? 'var(--yellow)' : 'var(--red)';
    return '<div class="cron-ring">' +
      '<svg width="28" height="28" viewBox="0 0 28 28">' +
        '<circle cx="14" cy="14" r="' + r + '" fill="none" stroke="var(--border)" stroke-width="2"/>' +
        '<circle cx="14" cy="14" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="2" ' +
          'stroke-dasharray="' + filled.toFixed(1) + ' ' + (c-filled).toFixed(1) + '" stroke-linecap="round"/>' +
      '</svg>' +
      '<span class="rate" style="color:' + color + '">' + rate + '%</span>' +
    '</div>';
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var ms = Date.now() - ts;
    if (ms < 60000) return Math.round(ms/1000) + 's ago';
    if (ms < 3600000) return Math.round(ms/60000) + 'm ago';
    if (ms < 86400000) return Math.round(ms/3600000) + 'h ago';
    return Math.round(ms/86400000) + 'd ago';
  }

  function fmt(n) {
    if (!n) return '0';
    return n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n);
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // --- Status ---
  async function loadStatus() {
    try {
      var d = await api('/status');
      document.getElementById('statusDot').className = 'status-dot';
      document.getElementById('statusMetrics').innerHTML =
        '<div class="metric"><div class="metric-label">Uptime</div><div class="metric-value accent">' + (d.uptime||'\\u2014') + '</div></div>' +
        '<div class="metric"><div class="metric-label">Memory</div><div class="metric-value">' + (d.memory_mb ? d.memory_mb+'MB' : '\\u2014') + '</div><div class="metric-sub">RSS</div></div>' +
        '<div class="metric"><div class="metric-label">Model</div><div class="metric-value" style="font-size:12px">' + (d.model||'\\u2014') + '</div></div>' +
        '<div class="metric"><div class="metric-label">Cost</div><div class="metric-value accent">$' + (d.cost_usd_session||0).toFixed(3) + '</div><div class="metric-sub">session</div></div>';
      document.getElementById('runtimeInfo').innerHTML =
        '<div class="row"><span class="row-label">Vestige MCP</span><span style="color:' + (d.vestige_mcp==='connected'?'var(--green)':'var(--red)') + '">' + (d.vestige_mcp==='connected'?'\\u25cf connected':'\\u25cb disconnected') + '</span></div>' +
        '<div class="row"><span class="row-label">Queue</span><span>' + ((d.queue&&d.queue.running)||0) + ' running \\u00b7 ' + ((d.queue&&d.queue.waiting)||0) + ' waiting</span></div>' +
        '<div class="row"><span class="row-label">Crons</span><span>' + (d.cron_count||0) + ' jobs</span></div>';
    } catch (e) {
      document.getElementById('statusDot').className = 'status-dot offline';
      document.getElementById('statusMetrics').innerHTML = '<div class="empty" style="grid-column:span 2">Bot offline</div>';
    }
  }

  // --- Crons ---
  async function loadCrons() {
    try {
      var results = await Promise.allSettled([api('/crons'), api('/outcomes')]);
      var cronData = results[0], outcomeData = results[1];
      var crons = (cronData.value && cronData.value.crons) || (cronData.value) || [];
      var engagement = (outcomeData.value && outcomeData.value.cronEngagement) || {};
      if (!crons.length) { document.getElementById('cronList').innerHTML = '<div class="empty">No cron jobs</div>'; return; }
      document.getElementById('cronList').innerHTML = crons.map(function(c) {
        var eng = engagement[c.id] || {};
        var rate = eng.engagementRate != null ? eng.engagementRate : (eng.deliveries ? Math.round((eng.engagements/eng.deliveries)*100) : 100);
        var runs = eng.deliveries || 0;
        var nextStr = c.nextRun ? new Date(c.nextRun).toLocaleString('en-IL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:(window.__SELA_TZ||'UTC')}) : '';
        var lastStr = c.lastRun ? timeAgo(c.lastRun) : '';
        return '<div class="cron-item ' + (c.enabled===false?'disabled':'') + '">' +
          '<div class="cron-top">' +
            cronRing(rate) +
            '<div class="cron-name">' + esc(c.name) + '</div>' +
            '<div class="cron-actions">' +
              '<button class="icon-btn" title="Run" onclick="runCron(\\'' + c.id + '\\')">\\u25b6</button>' +
              '<button class="icon-btn" title="Toggle" onclick="toggleCron(\\'' + c.id + '\\')">' + (c.enabled!==false?'\\u23f8':'\\u25b7') + '</button>' +
              '<button class="icon-btn danger" title="Delete" onclick="deleteCron(\\'' + c.id + '\\',\\'' + esc(c.name).replace(/'/g,"\\\\'") + '\\')">\\u2715</button>' +
            '</div>' +
          '</div>' +
          '<div class="cron-meta">' +
            esc(c.schedule) +
            (nextStr ? ' \\u00b7 next: ' + nextStr : '') +
            (lastStr ? ' \\u00b7 ran: ' + lastStr : '') +
          '</div>' +
        '</div>';
      }).join('');
    } catch (e) {
      document.getElementById('cronList').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  async function runCron(id) {
    try { await api('/crons/' + id + '/run', {method:'POST'}); toast('Cron triggered','success'); }
    catch(e) { toast(e.message,'error'); }
  }

  async function toggleCron(id) {
    try { await api('/crons/' + id + '/toggle', {method:'POST'}); toast('Toggled','success'); loadCrons(); }
    catch(e) { toast(e.message,'error'); }
  }

  async function deleteCron(id, name) {
    if (!confirm('Delete "' + name + '"?')) return;
    try { await api('/crons/' + id + '/delete', {method:'POST'}); toast('Deleted','success'); loadCrons(); }
    catch(e) { toast(e.message,'error'); }
  }

  async function addCron() {
    var name = document.getElementById('cronName').value.trim();
    var schedule = document.getElementById('cronSchedule').value.trim();
    var prompt = document.getElementById('cronPrompt').value.trim();
    if (!name||!schedule||!prompt) { toast('Fill all fields','error'); return; }
    try {
      await api('/crons', {method:'POST', body: JSON.stringify({name:name,schedule:schedule,prompt:prompt})});
      toast('Cron added','success'); closeModal('addCronModal'); loadCrons();
    } catch(e) { toast(e.message,'error'); }
  }

  // --- Notes ---
  function toggleNote(id) {
    var body = document.getElementById('notebody-' + id);
    var arrow = document.getElementById('notearrow-' + id);
    if (!body) return;
    if (body.style.display === 'block') {
      body.style.display = 'none';
      if (arrow) arrow.textContent = '\\u25b6';
    } else {
      body.style.display = 'block';
      if (arrow) arrow.textContent = '\\u25bc';
    }
  }

  function parseNoteLines(raw) {
    var lines = raw.split('\\n').filter(function(l) { return l.trim().startsWith('-'); });
    var boldRe = new RegExp('\\\\*\\\\*(.+?)\\\\*\\\\*', 'g');
    return lines.map(function(l, i) {
      var cleaned = l.replace(/^-\\s*/,'');
      var timeMatch = cleaned.match(/\\*\\*(.+?)\\*\\*/);
      var time = timeMatch ? timeMatch[1] : '??';
      var rest = cleaned.replace(boldRe, '').trim();
      var preview = rest.length > 55 ? rest.slice(0, 52) + '...' : rest;
      var full = cleaned.replace(boldRe, '<span class="note-time">$1</span>');
      return { time: time, preview: preview, full: full, idx: i };
    });
  }

  function renderNoteEntries(notes, prefix) {
    return notes.map(function(n) {
      var id = prefix + n.idx;
      return '<div class="note-entry" onclick="toggleNote(\\'' + id + '\\')" style="margin-bottom:4px">' +
        '<span id="notearrow-' + id + '" style="color:var(--text3);font-size:9px;margin-right:6px">\\u25b6</span>' +
        '<span class="note-time">' + esc(n.time) + '</span> ' +
        '<span style="color:var(--text3);font-size:10px">' + esc(n.preview) + '</span>' +
        '<div id="notebody-' + id + '" style="display:none;margin-top:6px;padding:6px 8px;background:var(--surface);border-radius:4px;font-size:11px;line-height:1.6;color:var(--text)">' + n.full + '</div>' +
      '</div>';
    }).join('');
  }



  // --- User Notes ---
  async function loadUserNotes() {
    try {
      var d = await api('/user-notes');
      var notes = d.notes || [];
      if (!notes.length) { document.getElementById('userNoteList').innerHTML = '<div class="empty">No notes yet</div>'; return; }
      document.getElementById('userNoteList').innerHTML = notes.map(function(n, i) {
        var date = new Date(n.createdAt);
        var timeStr = date.toLocaleString('en-IL', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:(window.__SELA_TZ||'UTC')});
        var preview = n.text.length > 45 ? n.text.slice(0, 42) + '...' : n.text;
        var uid = 'unote-' + i;
        return '<div class="user-note-item" style="cursor:pointer;flex-wrap:wrap" onclick="toggleNote(\\'' + uid + '\\')">' +
          '<span id="notearrow-' + uid + '" style="color:var(--text3);font-size:9px">\\u25b6</span>' +
          '<span class="user-note-time">' + timeStr + '</span>' +
          '<span style="flex:1;font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(preview) + '</span>' +
          '<button class="icon-btn danger" title="Delete" onclick="event.stopPropagation();deleteUserNote(\\'' + n.id + '\\')" style="flex-shrink:0">\\u2715</button>' +
          '<div id="notebody-' + uid + '" style="display:none;width:100%;margin-top:6px;padding:6px 8px;background:var(--surface);border-radius:4px;font-size:12px;line-height:1.6;color:var(--text)">' + esc(n.text) + '</div>' +
        '</div>';
      }).join('');
    } catch(e) {
      document.getElementById('userNoteList').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  async function addUserNote() {
    var input = document.getElementById('userNoteInput');
    var text = input.value.trim();
    if (!text) return;
    try {
      await api('/user-notes', {method:'POST', body: JSON.stringify({text: text})});
      input.value = '';
      toast('Note added','success');
      loadUserNotes();
    } catch(e) { toast(e.message,'error'); }
  }

  async function deleteUserNote(id) {
    try {
      await api('/user-notes/' + id + '/delete', {method:'POST'});
      toast('Note deleted','success');
      loadUserNotes();
    } catch(e) { toast(e.message,'error'); }
  }

  // --- Goals ---
  // loadGoals is now handled by loadTasks (Board tab)
  async function loadGoals() { loadTasks(); }

  async function showGoal(id) {
    openModal('goalModal');
    document.getElementById('goalModalContent').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      var d = await api('/goals/' + id);
      var g = d.goal || d;
      document.getElementById('goalModalTitle').textContent = g.title;
      var html = '<div style="margin-bottom:11px;">' +
        '<div class="progress-bar" style="height:5px;margin-bottom:6px;"><div class="progress-fill" style="width:' + (g.progress||0) + '%"></div></div>' +
        '<div style="color:var(--text3);font-size:10px;display:flex;align-items:center;gap:8px;">' +
          '<span class="status-badge s-' + (g.status||'active') + '">' + (g.status||'active').replace('_',' ') + '</span>' +
          (g.progress||0) + '% \\u00b7 ' + (g.category||'general') + ' \\u00b7 ' + (g.priority||'medium') +
        '</div>' +
      '</div>';
      if (g.description) html += '<div style="color:var(--text2);font-size:12px;margin-bottom:14px;line-height:1.6">' + esc(g.description) + '</div>';
      if (g.milestones && g.milestones.length) {
        html += '<div class="section-label">Milestones</div>';
        g.milestones.forEach(function(m) {
          var metaLine = '';
          if (m.status === 'completed') {
            var parts = [];
            if (m.completedBy) parts.push(m.completedBy);
            if (m.completedAt) parts.push(new Date(m.completedAt).toLocaleString('en-IL', {timeZone:(window.__SELA_TZ||'UTC'), month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false}));
            if (parts.length) metaLine = '<div style="font-size:10px;color:var(--text3);margin:1px 0 4px 24px;opacity:0.7">' + esc(parts.join(' \\u00b7 ')) + '</div>';
          }
          html += '<div class="row">' +
            '<span style="color:' + (m.status==='completed'?'var(--green)':'var(--text3)') + '">' + (m.status==='completed'?'\\u2713':'\\u25cb') + '</span>' +
            '<span style="flex:1;margin-left:8px;' + (m.status==='completed'?'text-decoration:line-through;color:var(--text3)':'') + '">' + esc(m.title) + '</span>' +
          '</div>' + metaLine;
        });
      }
      if (g.retrospective) {
        html += '<div class="section-label" style="margin-top:14px">Retrospective</div>' +
          '<div style="color:var(--text2);font-size:12px;line-height:1.7;padding:9px;background:var(--surface2);border-radius:6px;border:1px solid var(--border)">' + esc(g.retrospective) + '</div>';
      }
      // Transition buttons
      var goalTransitions = {
        draft: ['pending', 'active', 'abandoned'],
        pending: ['active', 'abandoned'],
        active: ['in_progress', 'pending', 'blocked', 'abandoned'],
        in_progress: ['pending', 'blocked', 'completed', 'abandoned'],
        blocked: ['in_progress', 'pending', 'abandoned'],
        completed: [],
        abandoned: []
      };
      // Priority selector
      var prios = ['low','medium','high','critical'];
      html += '<div class="section-label" style="margin-top:14px">Priority</div><div style="display:flex;gap:6px;flex-wrap:wrap">';
      prios.forEach(function(p) {
        var colors = {low:'var(--text3)',medium:'var(--cyan)',high:'var(--yellow)',critical:'var(--red)'};
        var active = (g.priority||'medium') === p;
        html += '<button style="padding:4px 12px;border-radius:4px;border:1px solid ' + (active ? colors[p] : 'var(--border)') + ';background:' + (active ? colors[p]+'22' : 'var(--surface2)') + ';color:' + (active ? colors[p] : 'var(--text3)') + ';cursor:pointer;font-size:11px;font-weight:' + (active?'600':'400') + '" onclick="changeGoalPriority(\\'' + g.id + '\\',\\'' + p + '\\')">' + p + '</button>';
      });
      html += '</div>';

      var btnLabels = { pending: 'Under Review', active: 'Activate', in_progress: 'Start Work', blocked: 'Block', completed: 'Complete', abandoned: 'Abandon' };
      var allowed = goalTransitions[g.status] || [];
      if (allowed.length) {
        html += '<div class="section-label" style="margin-top:14px">Change Status</div><div class="goal-transitions">';
        allowed.forEach(function(s) {
          html += '<button class="t-' + s + '" onclick="changeGoalStatus(\\'' + g.id + '\\', \\'' + s + '\\')">' + (btnLabels[s] || s) + '</button>';
        });
        html += '</div>';
      }
      document.getElementById('goalModalContent').innerHTML = html;
    } catch(e) {
      document.getElementById('goalModalContent').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  async function changeGoalStatus(id, newStatus) {
    try {
      await api('/goals/' + id + '/update', {method:'POST', body: JSON.stringify({status: newStatus})});
      toast('Status changed to ' + newStatus.replace('_',' '),'success');
      showGoal(id);
      loadTasks();
    } catch(e) { toast('Failed: ' + e.message,'error'); }
  }

  async function changeGoalPriority(id, newPriority) {
    try {
      await api('/goals/' + id + '/update', {method:'POST', body: JSON.stringify({priority: newPriority})});
      toast('Priority set to ' + newPriority,'success');
      showGoal(id);
      loadTasks();
    } catch(e) { toast('Failed: ' + e.message,'error'); }
  }

  // --- Soul Editor ---
  async function loadSoul() {
    try {
      var d = await api('/soul');
      document.getElementById('soulEditor').value = d.proactiveSection || d.content || '';
    } catch(e) {
      document.getElementById('soulEditor').placeholder = 'Error: ' + e.message;
    }
  }

  async function saveSoul() {
    var content = document.getElementById('soulEditor').value;
    try {
      await api('/soul', {method:'POST', body: JSON.stringify({proactiveSection: content})});
      toast('Saved \\u2014 reloads in ~5 min','success');
    } catch(e) { toast(e.message,'error'); }
  }

  async function rollbackSoul() {
    if (!confirm('Rollback to previous proactive section?')) return;
    try {
      await api('/soul/rollback', {method:'POST'});
      toast('Rolled back','success'); loadSoul();
    } catch(e) { toast(e.message,'error'); }
  }

  async function runReview() {
    toast('Running self-review...','info');
    try {
      await api('/review', {method:'POST'});
      toast('Review complete','success');
      setTimeout(function() { loadSoul(); loadReviewHistory(); }, 2500);
    } catch(e) { toast(e.message,'error'); }
  }

  async function loadReviewHistory() {
    try {
      var d = await api('/review/history');
      var h = d.history || [];
      if (!h.length) { document.getElementById('reviewHistory').innerHTML = '<div class="empty">No reviews yet</div>'; return; }
      document.getElementById('reviewHistory').innerHTML = h.map(function(r) {
        return '<div class="review-item">' +
          '<div class="review-date">' + new Date(r.ts).toLocaleDateString('en-CA') + ' ' + new Date(r.ts).toLocaleTimeString('en-IL',{hour:'2-digit',minute:'2-digit'}) + '</div>' +
          '<div class="review-notes">' + (r.notes||'No notes') + '</div>' +
        '</div>';
      }).join('');
    } catch(e) {
      document.getElementById('reviewHistory').innerHTML = '<div class="empty">No review history</div>';
    }
  }

  // --- Workflows ---
  async function loadWorkflows() {
    try {
      var d = await api('/workflows');
      var wf = d.workflows || d || [];
      if (!wf.length) { document.getElementById('workflowList').innerHTML = '<div class="empty">No active workflows</div>'; return; }
      document.getElementById('workflowList').innerHTML = wf.map(function(w) {
        var pct = w.steps > 0 ? Math.round((w.completed / w.steps) * 100) : 0;
        var age = w.createdAt ? timeAgo(w.createdAt) : '';
        var cost = w.costUsd ? '$' + w.costUsd.toFixed(4) : '';
        var isActive = w.status === 'running' || w.status === 'paused' || w.status === 'pending';
        return '<div class="workflow-item" onclick="toggleWfDetail(this, \\'' + esc(w.id) + '\\')">' +
          '<div class="wf-header">' +
            '<div class="wf-dot ' + w.status + '"></div>' +
            '<div style="flex:1;font-size:12px">' + esc(w.name || w.id) + '</div>' +
            '<div style="color:var(--text3);font-size:10px">' + w.completed + '/' + w.steps + ' (' + pct + '%)</div>' +
          '</div>' +
          '<div class="wf-meta">' +
            '<span>' + w.status + '</span>' +
            (age ? '<span>' + age + '</span>' : '') +
            (cost ? '<span>' + cost + '</span>' : '') +
            (w.failed > 0 ? '<span style="color:var(--red)">' + w.failed + ' failed</span>' : '') +
          '</div>' +
          '<div class="wf-detail" style="display:none"></div>' +
        '</div>';
      }).join('');
    } catch(e) {
      document.getElementById('workflowList').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  async function toggleWfDetail(el, wfId) {
    var detail = el.querySelector('.wf-detail');
    if (detail.style.display !== 'none') { detail.style.display = 'none'; return; }
    detail.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    detail.style.display = 'block';
    try {
      var d = await api('/workflows/' + encodeURIComponent(wfId));
      var wf = d.workflow;
      if (!wf) { detail.innerHTML = '<div class="empty">Not found</div>'; return; }
      var html = '<div class="wf-steps">';
      (wf.steps || []).forEach(function(s) {
        var icon = s.status === 'completed' ? '\\u2705' : s.status === 'failed' ? '\\u274c' : s.status === 'running' ? '\\u25b6' : s.status === 'skipped' ? '\\u2014' : '\\u25cb';
        var dur = s.completedAt && s.startedAt ? ((s.completedAt - s.startedAt) / 1000).toFixed(1) + 's' : '';
        html += '<div class="wf-step">' +
          '<div class="wf-step-icon">' + icon + '</div>' +
          '<div class="wf-step-desc">' + esc(s.description || s.id) + '</div>' +
          (dur ? '<div class="wf-step-time">' + dur + '</div>' : '') +
        '</div>';
        if (s.status === 'failed' && s.error) {
          html += '<div class="wf-error">' + esc(s.error) + '</div>';
        }
      });
      html += '</div>';
      var isActive = wf.status === 'running' || wf.status === 'paused' || wf.status === 'pending';
      if (isActive) {
        html += '<div class="wf-actions">';
        if (wf.status === 'running') html += '<button onclick="event.stopPropagation();wfAction(\\'' + wfId + '\\',\\'pause\\')">Pause</button>';
        if (wf.status === 'paused') html += '<button onclick="event.stopPropagation();wfAction(\\'' + wfId + '\\',\\'resume\\')">Resume</button>';
        html += '<button onclick="event.stopPropagation();wfAction(\\'' + wfId + '\\',\\'cancel\\')">Cancel</button>';
        html += '</div>';
      }
      detail.innerHTML = html;
    } catch(e) {
      detail.innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  async function wfAction(wfId, action) {
    try {
      await api('/workflows/' + encodeURIComponent(wfId) + '/' + action, { method: 'POST' });
      loadWorkflows();
    } catch(e) {
      alert('Workflow ' + action + ' failed: ' + e.message);
    }
  }

  function timeAgo(ts) {
    var diff = Date.now() - ts;
    if (diff < 60000) return Math.round(diff / 1000) + 's ago';
    if (diff < 3600000) return Math.round(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.round(diff / 3600000) + 'h ago';
    return Math.round(diff / 86400000) + 'd ago';
  }

  // --- Outcomes ---
  async function loadOutcomes() {
    try {
      var d = await api('/outcomes');
      var s = d.summary || '';
      var am = s.match(/(\\d+) approved/), rm = s.match(/(\\d+) rejected/), cm = s.match(/(\\d+) followed/);
      document.getElementById('outcomeStats').innerHTML =
        '<div class="outcome-stat"><div class="outcome-stat-value" style="color:var(--green)">' + (am?am[1]:'0') + '</div><div class="outcome-stat-label">Approved</div></div>' +
        '<div class="outcome-stat"><div class="outcome-stat-value" style="color:var(--red)">' + (rm?rm[1]:'0') + '</div><div class="outcome-stat-label">Rejected</div></div>' +
        '<div class="outcome-stat"><div class="outcome-stat-value" style="color:var(--cyan)">' + (cm?cm[1]:'0') + '</div><div class="outcome-stat-label">Followed</div></div>';
      var proposals = d.recentProposals || [];
      document.getElementById('proposalList').innerHTML = proposals.length
        ? '<div class="section-label">Recent Proposals</div>' + proposals.slice(-8).reverse().map(function(p) {
          return '<div class="proposal-item">' +
            '<div class="proposal-topic">' + esc(p.topic) + '</div>' +
            '<div class="proposal-meta">' +
              '<span>' + new Date(p.proposedAt).toLocaleDateString('en-CA') + '</span>' +
              '<span class="p-badge ' + (p.outcome||'pending') + '">' + (p.outcome||'pending') + '</span>' +
              (p.followThrough?'<span>' + p.followThrough + '</span>':'') +
            '</div>' +
          '</div>';
        }).join('')
        : '<div class="empty">No proposals yet</div>';
    } catch(e) {
      document.getElementById('outcomeStats').innerHTML = '<div style="grid-column:span 3" class="empty">' + e.message + '</div>';
    }
  }

  // --- Services ---
  async function loadServices() {
    try {
      var d = await api('/services');
      var html = '';
      (d.mcp || []).forEach(function(s) {
        html += '<div class="svc-item">' +
          '<div class="svc-dot ' + s.status + '"></div>' +
          '<span class="svc-name">' + esc(s.name) + '</span>' +
          '<span class="svc-status ' + s.status + '">' + s.status + (s.failures > 0 ? ' (' + s.failures + ' fails)' : '') + '</span>' +
        '</div>';
      });
      (d.plugins || []).forEach(function(p) {
        html += '<div class="svc-item">' +
          '<div class="svc-dot ' + p.status + '"></div>' +
          '<span class="svc-name">' + esc(p.name) + '</span>' +
          '<span class="svc-status ' + p.status + '">' + p.status + '</span>' +
        '</div>';
      });
      document.getElementById('serviceList').innerHTML = html || '<div class="empty">No services</div>';
    } catch(e) {
      document.getElementById('serviceList').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  // --- Cost Summary ---
  async function loadCostSummary() {
    try {
      var results = await Promise.allSettled([api('/costs/summary'), api('/costs?period=week')]);
      var d = (results[0].value) || {};
      var weekData = (results[1].value) || {};
      var budgetLimit = 5; // $5 daily limit

      // Budget progress bar
      var todaySpend = d.today ? d.today.total : 0;
      var budgetPct = Math.min(Math.round((todaySpend / budgetLimit) * 100), 100);
      var budgetColor = budgetPct >= 90 ? 'var(--red)' : budgetPct >= 60 ? 'var(--yellow)' : 'var(--green)';

      var html = '<div style="margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:4px">' +
          '<span style="color:var(--text3)">Daily Budget</span>' +
          '<span style="color:' + budgetColor + '">$' + todaySpend.toFixed(2) + ' / $' + budgetLimit.toFixed(0) + '</span>' +
        '</div>' +
        '<div class="progress-bar" style="height:5px"><div class="progress-fill" style="width:' + budgetPct + '%;background:' + budgetColor + '"></div></div>' +
      '</div>';

      html += '<div class="metrics" style="grid-template-columns:1fr 1fr;margin-bottom:8px">' +
        '<div class="metric"><div class="metric-label">Today</div><div class="metric-value accent">$' + (d.today ? d.today.total : 0).toFixed(2) + '</div><div class="metric-sub">' + (d.today ? d.today.count : 0) + ' turns</div></div>' +
        '<div class="metric"><div class="metric-label">Yesterday</div><div class="metric-value">$' + (d.yesterday ? d.yesterday.total : 0).toFixed(2) + '</div><div class="metric-sub">' + (d.yesterday ? d.yesterday.count : 0) + ' turns</div></div>' +
      '</div>' +
      '<div class="metrics" style="grid-template-columns:1fr 1fr;margin-bottom:8px">' +
        '<div class="metric"><div class="metric-label">This Week</div><div class="metric-value">$' + (d.weekTotal||0).toFixed(2) + '</div><div class="metric-sub">' + (d.weekCount||0) + ' turns</div></div>' +
        '<div class="metric"><div class="metric-label">This Month</div><div class="metric-value">$' + (d.monthTotal||0).toFixed(2) + '</div><div class="metric-sub">' + (d.monthCount||0) + ' turns</div></div>' +
      '</div>' +
      '<div class="row"><span class="row-label">Daily avg</span><span style="color:var(--text2)">$' + (d.dailyAvg||0).toFixed(2) + '</span></div>';
      if (d.topDay && d.topDay.cost > 0) {
        html += '<div class="row"><span class="row-label">Top day</span><span style="color:var(--accent2)">' + d.topDay.date + ' ($' + d.topDay.cost.toFixed(2) + ')</span></div>';
      }
      document.getElementById('costInfo').innerHTML = html;

      // 7-day bar chart
      var byDay = weekData.byDay || {};
      var days = Object.keys(byDay).sort();
      if (days.length > 1) {
        var maxCost = Math.max.apply(null, days.map(function(k){ return byDay[k].cost; })) || 1;
        var chartHtml = '<div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Last 7 days</div>' +
          '<div style="display:flex;align-items:flex-end;gap:3px;height:60px">';
        days.slice(-7).forEach(function(day) {
          var cost = byDay[day].cost;
          var pct = Math.max(Math.round((cost / maxCost) * 100), 4);
          var dayLabel = day.slice(5); // MM-DD
          var barColor = cost > budgetLimit ? 'var(--red)' : 'var(--accent)';
          chartHtml += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">' +
            '<div style="font-size:8px;color:var(--text3)">$' + cost.toFixed(1) + '</div>' +
            '<div style="width:100%;height:' + pct + '%;background:' + barColor + ';border-radius:3px 3px 0 0;min-height:2px;transition:height 0.3s"></div>' +
            '<div style="font-size:7px;color:var(--text3)">' + dayLabel + '</div>' +
          '</div>';
        });
        chartHtml += '</div>';
        document.getElementById('costChart').innerHTML = chartHtml;
      } else {
        document.getElementById('costChart').innerHTML = '';
      }
    } catch(e) {
      document.getElementById('costInfo').innerHTML = '<div class="empty">No cost data</div>';
    }
  }

  // --- History ---
  async function loadHistory() {
    try {
      var d = await api('/history/dates');
      var dates = (d.dates || []).slice(0, 30);
      if (!dates.length) {
        document.getElementById('historyDateList').innerHTML = '<div class="empty">No history available</div>';
        return;
      }
      document.getElementById('historyDateList').innerHTML = dates.map(function(item) {
        var label = item.date;
        var today = new Date().toLocaleDateString('en-CA', { timeZone: (window.__SELA_TZ||'UTC') });
        var yest = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: (window.__SELA_TZ||'UTC') });
        if (item.date === today) label += ' (today)';
        else if (item.date === yest) label += ' (yesterday)';
        return '<div class="history-date-item" onclick="selectHistoryDate(this,\\'' + item.date + '\\')">' +
          '<div class="history-date-label">' + label + '</div>' +
          '<span class="history-date-cost">$' + (item.cost||0).toFixed(2) + '</span>' +
          '<span class="history-date-turns">' + (item.turns||0) + ' turns</span>' +
        '</div>';
      }).join('');
    } catch(e) {
      document.getElementById('historyDateList').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  var selectedHistoryDate = '';

  function selectHistoryDate(el, date) {
    // Toggle: click same date again to close
    if (selectedHistoryDate === date) {
      el.classList.remove('selected');
      document.getElementById('historyDetailCard').style.display = 'none';
      selectedHistoryDate = '';
      document.getElementById('historyDatePicker').value = '';
      return;
    }
    document.querySelectorAll('.history-date-item').forEach(function(i) { i.classList.remove('selected'); });
    el.classList.add('selected');
    selectedHistoryDate = date;
    document.getElementById('historyDatePicker').value = date;
    loadHistoryDate(date);
  }

  async function loadHistoryDate(date) {
    if (!date) return;
    var card = document.getElementById('historyDetailCard');
    card.style.display = 'block';
    document.getElementById('historyDetailTitle').textContent = 'Activity \u2014 ' + date;
    document.getElementById('historyDetailFeed').innerHTML = '<div class="loading"><div class="spinner"></div> Loading...</div>';
    document.getElementById('historyDetailCost').textContent = '';
    try {
      var d = await api('/notes/' + date);
      var raw = d.notes || '';
      var notes = parseNoteLines(raw);
      if (!notes.length) {
        document.getElementById('historyDetailFeed').innerHTML = '<div class="empty">No activity recorded for ' + date + '</div>';
        return;
      }
      document.getElementById('historyDetailFeed').innerHTML = renderNoteEntries(notes, 'hist-');
      // Show cost for this date from the history list
      var costEl = document.getElementById('historyDetailCost');
      var dateItems = document.querySelectorAll('.history-date-item');
      dateItems.forEach(function(item) {
        var costSpan = item.querySelector('.history-date-cost');
        if (costSpan && item.querySelector('.history-date-label').textContent.startsWith(date)) {
          costEl.textContent = costSpan.textContent;
        }
      });
    } catch(e) {
      document.getElementById('historyDetailFeed').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  // --- Error History ---
  async function loadErrors() {
    var el = document.getElementById('errorList');
    if (!el) return;
    el.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      var severity = document.getElementById('errorSeverity').value;
      var search = document.getElementById('errorSearchInput').value.trim();
      var url = '/errors?limit=80&offset=0';
      if (severity) url += '&severity=' + encodeURIComponent(severity);
      if (search) url += '&q=' + encodeURIComponent(search);
      var d = await api(url);
      if (!d.errors || d.errors.length === 0) {
        el.innerHTML = '<div class="empty">No errors logged' + (severity || search ? ' (filters active)' : '') + '</div>';
        return;
      }
      var sevColor = { critical: 'var(--red)', error: 'var(--red)', warn: 'var(--yellow)', info: 'var(--text3)' };
      el.innerHTML = d.errors.map(function(e) {
        var col = sevColor[e.severity] || 'var(--text3)';
        var ts = e.ts ? new Date(e.ts).toLocaleString('en-IL', { timeZone: (window.__SELA_TZ||'UTC'), hour12: false, month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
        var resolvedBadge = e.resolved ? '<span style="color:var(--green);font-size:9px;margin-left:6px">✓ resolved</span>' : '';
        return '<div style="border-left:3px solid ' + col + ';padding:8px 10px;margin-bottom:6px;background:var(--bg2);border-radius:3px">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">' +
            '<div style="display:flex;align-items:center;gap:6px">' +
              '<span style="color:' + col + ';font-size:9px;text-transform:uppercase;font-weight:600">' + esc(e.severity) + '</span>' +
              '<span style="color:var(--text2);font-size:11px;font-weight:500">' + esc(e.module || 'unknown') + '</span>' +
              resolvedBadge +
            '</div>' +
            '<span style="color:var(--text3);font-size:9px">' + ts + '</span>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text1);margin-bottom:4px">' + esc(e.message || '') + '</div>' +
          (e.stack ? '<details style="margin-bottom:4px"><summary style="font-size:9px;color:var(--text3);cursor:pointer">Stack trace</summary><pre style="font-size:9px;color:var(--text3);margin:4px 0 0;overflow-x:auto;max-height:80px">' + esc((e.stack || '').slice(0, 400)) + '</pre></details>' : '') +
          (!e.resolved ? '<button class="btn" onclick="resolveError(' + e.id + ')" style="padding:3px 8px;font-size:10px;margin-top:2px">Mark resolved</button>' : '') +
        '</div>';
      }).join('');
    } catch(e) {
      el.innerHTML = '<div class="empty">Failed to load: ' + esc(e.message) + '</div>';
    }
  }

  async function resolveError(id) {
    try {
      await api('/errors/' + id + '/resolve', { method: 'POST' });
      loadErrors();
    } catch(e) {
      alert('Failed to resolve: ' + e.message);
    }
  }

  // --- Memory Browser ---
  async function searchMemories() {
    var q = document.getElementById('memSearchInput').value.trim();
    if (!q) { toast('Enter a search query','error'); return; }
    document.getElementById('memResults').innerHTML = '<div class="loading"><div class="spinner"></div> Searching...</div>';
    try {
      var d = await api('/memories/search?q=' + encodeURIComponent(q) + '&limit=20');
      var raw = d.results || '';
      if (!raw || raw === '[]' || raw.length < 5) {
        document.getElementById('memResults').innerHTML = '<div class="empty">No memories found for "' + esc(q) + '"</div>';
        return;
      }
      renderMemoryResults(raw);
    } catch(e) {
      document.getElementById('memResults').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  async function loadMemoryTimeline() {
    document.getElementById('memResults').innerHTML = '<div class="loading"><div class="spinner"></div> Loading recent...</div>';
    try {
      var results = await Promise.allSettled([api('/memories/timeline?limit=30'), api('/memories/stats')]);
      var tlData = results[0].value || {};
      var statsData = results[1].value || {};
      // Stats bar
      if (statsData.stats) {
        document.getElementById('memStats').innerHTML =
          '<div style="display:flex;gap:12px;font-size:10px;color:var(--text3);padding:4px 0">' +
          '<span>Vestige: <span style="color:var(--green)">connected</span></span>' +
          '</div>';
      }
      var raw = tlData.timeline || '';
      if (!raw || raw.length < 5) {
        document.getElementById('memResults').innerHTML = '<div class="empty">No memories yet</div>';
        return;
      }
      renderMemoryResults(raw);
    } catch(e) {
      document.getElementById('memResults').innerHTML = '<div class="empty">' + e.message + '</div>';
      document.getElementById('memStats').innerHTML = '<div style="font-size:10px;color:var(--red)">Vestige offline</div>';
    }
  }

  function renderMemoryResults(raw) {
    // Vestige returns plain text (not JSON), render as formatted blocks
    var lines = String(raw).split('\\n').filter(function(l) { return l.trim(); });
    if (!lines.length) {
      document.getElementById('memResults').innerHTML = '<div class="empty">No results</div>';
      return;
    }
    // Group into memory blocks (separated by lines starting with --- or numbered headers)
    var blocks = [];
    var current = [];
    lines.forEach(function(line) {
      if ((line.match(/^---/) || line.match(/^\\d+\\./)) && current.length > 0) {
        blocks.push(current.join('\\n'));
        current = [line];
      } else {
        current.push(line);
      }
    });
    if (current.length > 0) blocks.push(current.join('\\n'));

    if (blocks.length === 0) blocks = [raw];

    document.getElementById('memResults').innerHTML = blocks.slice(0, 30).map(function(block, i) {
      var firstLine = block.split('\\n')[0].replace(/^[-\\d.]+\\s*/, '').trim();
      var preview = firstLine.length > 70 ? firstLine.slice(0, 67) + '...' : firstLine;
      var uid = 'mem-' + i;
      return '<div class="note-entry" onclick="toggleNote(\\'' + uid + '\\')" style="margin-bottom:5px">' +
        '<span id="notearrow-' + uid + '" style="color:var(--text3);font-size:9px;margin-right:6px">\\u25b6</span>' +
        '<span style="color:var(--accent2);font-size:11px">' + esc(preview) + '</span>' +
        '<div id="notebody-' + uid + '" style="display:none;margin-top:6px;padding:8px;background:var(--surface);border-radius:4px;font-size:11px;line-height:1.6;color:var(--text2);white-space:pre-wrap;word-break:break-word">' + esc(block) + '</div>' +
      '</div>';
    }).join('');
  }

  async function ingestMemory() {
    var content = document.getElementById('memIngestContent').value.trim();
    if (!content) { toast('Enter content','error'); return; }
    var tags = document.getElementById('memIngestTags').value.split(',').map(function(t){ return t.trim(); }).filter(Boolean);
    var nodeType = document.getElementById('memIngestType').value;
    try {
      await api('/memories/ingest', {method:'POST', body: JSON.stringify({content:content, tags:tags, nodeType:nodeType})});
      toast('Memory saved','success');
      document.getElementById('memIngestContent').value = '';
      document.getElementById('memIngestTags').value = '';
    } catch(e) { toast(e.message,'error'); }
  }

  // --- Cron Health ---
  async function loadCronHealth() {
    try {
      var d = await api('/cron-health');
      var crons = d.crons || {};
      var entries = Object.values(crons);
      if (!entries.length) { document.getElementById('cronHealthList').innerHTML = '<div class="empty">No health data yet</div>'; return; }
      entries.sort(function(a,b) { return (b.errors/(b.runs||1)) - (a.errors/(a.runs||1)); });
      document.getElementById('cronHealthList').innerHTML = entries.map(function(c) {
        var rate = c.runs > 0 ? Math.round(((c.runs - c.errors) / c.runs) * 100) : 0;
        var color = rate >= 80 ? 'var(--green)' : rate >= 50 ? 'var(--yellow)' : 'var(--red)';
        var disabled = c.autoDisabled ? ' <span style="color:var(--red);font-size:9px">[auto-disabled]</span>' : '';
        var lastErr = c.lastError ? '<div style="color:var(--text3);font-size:9px;margin-top:2px">Last error: ' + esc(c.lastError.message||'').slice(0,60) + '</div>' : '';
        return '<div class="svc-item" style="flex-wrap:wrap">' +
          '<div class="svc-dot" style="background:' + color + ';box-shadow:0 0 5px ' + color + '"></div>' +
          '<span class="svc-name">' + esc(c.name||'unknown') + disabled + '</span>' +
          '<span style="font-size:10px;color:' + color + '">' + rate + '% ok</span>' +
          '<span style="color:var(--text3);font-size:9px">' + c.runs + ' runs, ' + c.errors + ' errs</span>' +
          lastErr +
        '</div>';
      }).join('');
    } catch(e) {
      document.getElementById('cronHealthList').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  // --- Test Runner ---
  async function loadTests() {
    try {
      var d = await api('/tests/list');
      if (!d.files || d.files.length === 0) {
        document.getElementById('testResults').innerHTML = '<div class="empty">No test files found</div>';
        return;
      }
      document.getElementById('testResults').innerHTML = d.files.map(function(f) {
        var name = f.replace('.test.js', '');
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)" id="test-row-' + name + '">' +
          '<span style="font-size:11px;color:var(--text2)">' + esc(f) + '</span>' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            '<span id="test-status-' + name + '" style="font-size:10px"></span>' +
            '<button class="card-action" style="font-size:10px;padding:2px 8px" onclick="runSingleTest(\\'' + esc(f) + '\\',\\'' + name + '\\')">Run</button>' +
          '</div>' +
        '</div>';
      }).join('');
    } catch(e) {
      document.getElementById('testResults').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  async function runSingleTest(file, name) {
    var statusEl = document.getElementById('test-status-' + name);
    var row = document.getElementById('test-row-' + name);
    if (!statusEl) return;
    statusEl.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px"></div>';
    row.style.background = '';
    try {
      var d = await api('/tests/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: file }) });
      var color = d.failed > 0 ? 'var(--red)' : 'var(--green)';
      statusEl.style.color = color;
      statusEl.textContent = d.passed + ' passed' + (d.failed > 0 ? ', ' + d.failed + ' failed' : '');
      row.style.background = d.failed > 0 ? 'rgba(255,80,80,0.08)' : 'rgba(80,200,120,0.08)';
    } catch(e) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'error';
    }
  }

  async function runTests() {
    var btn = document.getElementById('testRunBtn');
    btn.textContent = '...';
    btn.disabled = true;
    // Set all rows to running
    document.querySelectorAll('[id^="test-status-"]').forEach(function(el) {
      el.innerHTML = '<div class="spinner" style="width:12px;height:12px;border-width:2px"></div>';
    });
    document.querySelectorAll('[id^="test-row-"]').forEach(function(el) {
      el.style.background = '';
    });
    try {
      var d = await api('/tests/run', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({})});
      // Parse output to update each row
      var currentFile = null;
      var results = {};
      (d.output || '').split('\\n').forEach(function(line) {
        var trimmed = line.trim();
        if (/\\.test\\.js$/.test(trimmed) && !trimmed.startsWith('=')) {
          currentFile = trimmed;
          results[currentFile] = { passed: 0, failed: 0 };
        } else if (currentFile && /^\\s*(PASS|FAIL)/.test(line)) {
          if (/^\\s*PASS/.test(line)) results[currentFile].passed++;
          else results[currentFile].failed++;
        }
      });
      // Update each row
      Object.keys(results).forEach(function(file) {
        var name = file.replace('.test.js', '');
        var statusEl = document.getElementById('test-status-' + name);
        var row = document.getElementById('test-row-' + name);
        if (!statusEl) return;
        var r = results[file];
        var color = r.failed > 0 ? 'var(--red)' : 'var(--green)';
        statusEl.style.color = color;
        statusEl.textContent = r.passed + ' passed' + (r.failed > 0 ? ', ' + r.failed + ' failed' : '');
        if (row) row.style.background = r.failed > 0 ? 'rgba(255,80,80,0.08)' : 'rgba(80,200,120,0.08)';
      });
      var statusText = d.failed > 0 ? d.failed + ' FAILED' : 'ALL PASSED (' + d.passed + ')';
      toast(statusText, d.failed > 0 ? 'error' : 'success');
    } catch(e) {
      toast('Test run failed: ' + e.message, 'error');
    }
    btn.textContent = '\\u25b7 Run All';
    btn.disabled = false;
  }

  // --- WebSocket live updates ---
  var ws = null;
  var wsConnected = false;
  var wsReconnectTimer = null;
  var wsReconnectDelay = 1000;

  function connectWs() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // already connecting/open
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws');

    ws.onopen = function() {
      wsConnected = true;
      wsReconnectDelay = 1000;
      document.getElementById('statusDot').className = 'status-dot';
      updateTimestamp();
    };

    ws.onmessage = function(evt) {
      try {
        var msg = JSON.parse(evt.data);
        if (msg.type === 'state') applyLiveState(msg.data);
        if (msg.type === 'event') handleWsEvent(msg);
        updateTimestamp();
      } catch(e) {}
    };

    ws.onclose = function() {
      wsConnected = false;
      scheduleReconnect();
    };

    ws.onerror = function() {
      wsConnected = false;
    };
  }

  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(function() {
      wsReconnectTimer = null;
      wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30000);
      connectWs();
    }, wsReconnectDelay);
  }

  function updateTimestamp() {
    document.getElementById('lastUpdated').textContent =
      new Date().toLocaleTimeString('en-IL',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) + (wsConnected ? ' \\u26a1' : '');
  }

  function handleWsEvent(msg) {
    var e = msg.event || '';
    var d = msg.data || {};
    if (e === 'message:received') {
      toast('Message: ' + (d.preview || '').slice(0, 40), 'info');
    } else if (e === 'message:reply') {
      toast('Reply sent (' + (d.claudeMs/1000).toFixed(1) + 's, $' + (d.costUsd||0).toFixed(3) + ')', 'success');
    } else if (e === 'cron:completed') {
      toast('Cron "' + (d.name||d.id) + '" completed', 'success');
    } else if (e === 'cron:failed') {
      toast('Cron "' + (d.name||d.id) + '" failed: ' + (d.error||'').slice(0,40), 'error');
    } else if (e === 'cost:alert') {
      toast('Cost alert: $' + (d.total||0).toFixed(2) + ' / $' + (d.limit||5), 'error');
    } else if (e === 'goals:updated' || e === 'agent:cycle:goal_created' || e === 'agent:cycle:goal_updated' || e === 'agent:cycle:milestone_completed') {
      loadTasks();
    }
  }

  // Apply pushed state to all dashboard sections
  function applyLiveState(data) {
    if (data.status) applyStatus(data.status);
    if (data.crons) applyCrons(data.crons);
    if (data.services) applyServices(data.services);
    if (data.cronHealth) applyCronHealth(data.cronHealth);
    if (data.costs) applyCosts(data.costs);
  }

  // --- Status from WS ---
  function applyStatus(d) {
    document.getElementById('statusDot').className = 'status-dot';
    document.getElementById('statusMetrics').innerHTML =
      '<div class="metric"><div class="metric-label">Uptime</div><div class="metric-value accent">' + (d.uptime||'\\u2014') + '</div></div>' +
      '<div class="metric"><div class="metric-label">Memory</div><div class="metric-value">' + (d.memory_mb ? d.memory_mb+'MB' : '\\u2014') + '</div><div class="metric-sub">RSS</div></div>' +
      '<div class="metric"><div class="metric-label">Model</div><div class="metric-value" style="font-size:12px">' + (d.model||'\\u2014') + '</div></div>' +
      '<div class="metric"><div class="metric-label">Cost</div><div class="metric-value accent">$' + (d.cost_usd_session||0).toFixed(3) + '</div><div class="metric-sub">session</div></div>';
    document.getElementById('runtimeInfo').innerHTML =
      '<div class="row"><span class="row-label">Vestige MCP</span><span style="color:' + (d.vestige_mcp==='connected'?'var(--green)':'var(--red)') + '">' + (d.vestige_mcp==='connected'?'\\u25cf connected':'\\u25cb disconnected') + '</span></div>' +
      '<div class="row"><span class="row-label">Queue</span><span>' + ((d.queue&&d.queue.running)||0) + ' running \\u00b7 ' + ((d.queue&&d.queue.waiting)||0) + ' waiting</span></div>' +
      '<div class="row"><span class="row-label">Crons</span><span>' + (d.cron_count||0) + ' jobs</span></div>';
  }

  // --- Crons from WS ---
  function applyCrons(cronData) {
    var crons = cronData.crons || [];
    if (!crons.length) { document.getElementById('cronList').innerHTML = '<div class="empty">No cron jobs</div>'; return; }
    document.getElementById('cronList').innerHTML = crons.map(function(c) {
      var rate = 100; // WS push doesn't include engagement yet, default 100
      var nextStr = c.nextRun ? new Date(c.nextRun).toLocaleString('en-IL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:(window.__SELA_TZ||'UTC')}) : '';
      var lastStr = c.lastRun ? timeAgo(c.lastRun) : '';
      return '<div class="cron-item ' + (c.enabled===false?'disabled':'') + '">' +
        '<div class="cron-top">' +
          cronRing(rate) +
          '<div class="cron-name">' + esc(c.name) + '</div>' +
          '<div class="cron-actions">' +
            '<button class="icon-btn" title="Run" onclick="runCron(\\'' + c.id + '\\')">\\u25b6</button>' +
            '<button class="icon-btn" title="Toggle" onclick="toggleCron(\\'' + c.id + '\\')">' + (c.enabled!==false?'\\u23f8':'\\u25b7') + '</button>' +
            '<button class="icon-btn danger" title="Delete" onclick="deleteCron(\\'' + c.id + '\\',\\'' + esc(c.name).replace(/'/g,"\\\\'") + '\\')">\\u2715</button>' +
          '</div>' +
        '</div>' +
        '<div class="cron-meta">' +
          esc(c.schedule) +
          (nextStr ? ' \\u00b7 next: ' + nextStr : '') +
          (lastStr ? ' \\u00b7 ran: ' + lastStr : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  // --- Services from WS ---
  function applyServices(d) {
    var html = '';
    (d.mcp || []).forEach(function(s) {
      html += '<div class="svc-item">' +
        '<div class="svc-dot ' + s.status + '"></div>' +
        '<span class="svc-name">' + esc(s.name) + '</span>' +
        '<span class="svc-status ' + s.status + '">' + s.status + (s.failures > 0 ? ' (' + s.failures + ' fails)' : '') + '</span>' +
      '</div>';
    });
    (d.plugins || []).forEach(function(p) {
      html += '<div class="svc-item">' +
        '<div class="svc-dot ' + p.status + '"></div>' +
        '<span class="svc-name">' + esc(p.name) + '</span>' +
        '<span class="svc-status ' + p.status + '">' + p.status + '</span>' +
      '</div>';
    });
    document.getElementById('serviceList').innerHTML = html || '<div class="empty">No services</div>';
  }

  // --- Cron Health from WS ---
  function applyCronHealth(d) {
    var crons = d.crons || {};
    var entries = Object.values(crons);
    if (!entries.length) { document.getElementById('cronHealthList').innerHTML = '<div class="empty">No health data yet</div>'; return; }
    entries.sort(function(a,b) { return (b.errors/(b.runs||1)) - (a.errors/(a.runs||1)); });
    document.getElementById('cronHealthList').innerHTML = entries.map(function(c) {
      var rate = c.runs > 0 ? Math.round(((c.runs - c.errors) / c.runs) * 100) : 0;
      var color = rate >= 80 ? 'var(--green)' : rate >= 50 ? 'var(--yellow)' : 'var(--red)';
      var disabled = c.autoDisabled ? ' <span style="color:var(--red);font-size:9px">[auto-disabled]</span>' : '';
      var lastErr = c.lastError ? '<div style="color:var(--text3);font-size:9px;margin-top:2px">Last error: ' + esc(c.lastError.message||'').slice(0,60) + '</div>' : '';
      return '<div class="svc-item" style="flex-wrap:wrap">' +
        '<div class="svc-dot" style="background:' + color + ';box-shadow:0 0 5px ' + color + '"></div>' +
        '<span class="svc-name">' + esc(c.name||'unknown') + disabled + '</span>' +
        '<span style="font-size:10px;color:' + color + '">' + rate + '% ok</span>' +
        '<span style="color:var(--text3);font-size:9px">' + c.runs + ' runs, ' + c.errors + ' errs</span>' +
        lastErr +
      '</div>';
    }).join('');
  }

  // --- Costs from WS (overview data) ---
  function applyCosts(d) {
    var budgetLimit = 5;
    var todaySpend = d.today ? d.today.total : 0;
    var budgetPct = Math.min(Math.round((todaySpend / budgetLimit) * 100), 100);
    var budgetColor = budgetPct >= 90 ? 'var(--red)' : budgetPct >= 60 ? 'var(--yellow)' : 'var(--green)';

    var html = '<div style="margin-bottom:10px">' +
      '<div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:4px">' +
        '<span style="color:var(--text3)">Daily Budget</span>' +
        '<span style="color:' + budgetColor + '">$' + todaySpend.toFixed(2) + ' / $' + budgetLimit.toFixed(0) + '</span>' +
      '</div>' +
      '<div class="progress-bar" style="height:5px"><div class="progress-fill" style="width:' + budgetPct + '%;background:' + budgetColor + '"></div></div>' +
    '</div>';

    html += '<div class="metrics" style="grid-template-columns:1fr 1fr;margin-bottom:8px">' +
      '<div class="metric"><div class="metric-label">Today</div><div class="metric-value accent">$' + (d.today ? d.today.total : 0).toFixed(2) + '</div><div class="metric-sub">' + (d.today ? d.today.count : 0) + ' turns</div></div>' +
      '<div class="metric"><div class="metric-label">Yesterday</div><div class="metric-value">$' + (d.yesterday ? d.yesterday.total : 0).toFixed(2) + '</div><div class="metric-sub">' + (d.yesterday ? d.yesterday.count : 0) + ' turns</div></div>' +
    '</div>' +
    '<div class="metrics" style="grid-template-columns:1fr 1fr;margin-bottom:8px">' +
      '<div class="metric"><div class="metric-label">This Week</div><div class="metric-value">$' + (d.weekTotal||0).toFixed(2) + '</div><div class="metric-sub">' + (d.weekCount||0) + ' turns</div></div>' +
      '<div class="metric"><div class="metric-label">This Month</div><div class="metric-value">$' + (d.monthTotal||0).toFixed(2) + '</div><div class="metric-sub">' + (d.monthCount||0) + ' turns</div></div>' +
    '</div>' +
    '<div class="row"><span class="row-label">Daily avg</span><span style="color:var(--text2)">$' + (d.dailyAvg||0).toFixed(2) + '</span></div>';
    if (d.topDay && d.topDay.cost > 0) {
      html += '<div class="row"><span class="row-label">Top day</span><span style="color:var(--accent2)">' + d.topDay.date + ' ($' + d.topDay.cost.toFixed(2) + ')</span></div>';
    }
    document.getElementById('costInfo').innerHTML = html;

    // 7-day bar chart from WS byDay data
    var byDay = d.byDay || {};
    var days = Object.keys(byDay).sort();
    if (days.length > 1) {
      var maxCost = Math.max.apply(null, days.map(function(k){ return byDay[k].cost; })) || 1;
      var chartHtml = '<div style="font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Last 7 days</div>' +
        '<div style="display:flex;align-items:flex-end;gap:3px;height:60px">';
      days.slice(-7).forEach(function(day) {
        var cost = byDay[day].cost;
        var pct = Math.max(Math.round((cost / maxCost) * 100), 4);
        var dayLabel = day.slice(5);
        var barColor = cost > budgetLimit ? 'var(--red)' : 'var(--accent)';
        chartHtml += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">' +
          '<div style="font-size:8px;color:var(--text3)">$' + cost.toFixed(1) + '</div>' +
          '<div style="width:100%;height:' + pct + '%;background:' + barColor + ';border-radius:3px 3px 0 0;min-height:2px;transition:height 0.3s"></div>' +
          '<div style="font-size:7px;color:var(--text3)">' + dayLabel + '</div>' +
        '</div>';
      });
      chartHtml += '</div>';
      document.getElementById('costChart').innerHTML = chartHtml;
    }
  }

  // --- Refresh all (initial load for non-WS data) ---
  // --- Tasks (Kanban) ---
  var taskStore = [];

  async function loadTasks() {
    try {
      var d = await api('/goals?all=1');
      taskStore = (d.goals || []).map(function(g) {
        var st = 'pending';
        if (g.status === 'in_progress' || g.status === 'active') st = 'in_progress';
        else if (g.status === 'completed') st = 'done';
        else if (g.status === 'abandoned') st = 'cancelled';
        else if (g.status === 'blocked') st = 'pending';
        return { id: g.id, title: g.title, status: st, assignee: g.source || 'ron', priority: g.priority || 'medium', raw: g };
      });
      renderKanban();
    } catch(e) {
      document.getElementById('kanbanBoard').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  function renderKanban() {
    var cols = [
      { key: 'pending', label: 'Pending', color: 'var(--yellow)' },
      { key: 'in_progress', label: 'In Progress', color: 'var(--cyan)' },
      { key: 'done', label: 'Done', color: 'var(--green)' },
      { key: 'cancelled', label: 'Cancelled', color: 'var(--text3)' }
    ];
    var grouped = {};
    cols.forEach(function(c) { grouped[c.key] = []; });
    taskStore.forEach(function(t) { if (grouped[t.status]) grouped[t.status].push(t); });

    document.getElementById('kanbanBoard').innerHTML = cols.map(function(col) {
      var items = grouped[col.key];
      var priColors = { high: 'var(--red)', medium: 'var(--yellow)', low: 'var(--green)' };
      return '<div class="kanban-col">' +
        '<div class="kanban-col-header">' +
          '<span class="kanban-col-label" style="color:' + col.color + '">' + col.label + '</span>' +
          '<span class="kanban-col-count">' + items.length + '</span>' +
        '</div>' +
        (items.length === 0 ? '<div class="empty" style="font-size:10px;padding:12px 0">No goals</div>' : '') +
        items.map(function(t) {
          var g = t.raw;
          var transitions = ['pending','in_progress','done','cancelled'].filter(function(s) { return s !== t.status; });
          var btnLabels = { pending: 'Reopen', in_progress: 'Start', done: 'Done', cancelled: 'Cancel' };
          var desc = g.description ? '<div style="font-size:10px;color:var(--text3);margin-bottom:4px;line-height:1.4">' + esc(g.description).slice(0, 80) + (g.description.length > 80 ? '...' : '') + '</div>' : '';
          var ms = g.milestones || [];
          var msDone = ms.filter(function(m) { return m.status === 'completed'; }).length;
          var msBar = ms.length > 0 ? '<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px"><div style="flex:1;height:3px;border-radius:2px;background:var(--border);overflow:hidden"><div style="height:100%;border-radius:2px;background:var(--green);width:' + Math.round(msDone/ms.length*100) + '%"></div></div><span style="font-size:9px;color:var(--text3)">' + msDone + '/' + ms.length + '</span></div>' : '';
          return '<div class="kanban-card" style="cursor:pointer" onclick="showGoal(\\'' + esc(t.id) + '\\')">' +
            '<div class="kanban-card-title">' + esc(t.title) + '</div>' +
            desc +
            msBar +
            '<div class="kanban-card-meta">' +
              '<span class="badge" style="background:rgba(124,106,247,0.12);color:var(--accent2);font-size:9px">' + esc(t.assignee) + '</span>' +
              '<span class="badge" style="color:' + (priColors[t.priority] || 'var(--text3)') + ';font-size:9px">' + t.priority + '</span>' +
            '</div>' +
            '<div class="kanban-card-actions">' +
              transitions.map(function(s) {
                return '<button onclick="event.stopPropagation();moveTask(\\'' + esc(t.id) + '\\',\\'' + s + '\\')">' + btnLabels[s] + '</button>';
              }).join('') +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    }).join('');
  }

  async function moveTask(goalId, newStatus) {
    var goalMap = { pending: 'pending', in_progress: 'in_progress', done: 'completed', cancelled: 'abandoned' };
    try {
      await api('/goals/' + encodeURIComponent(goalId) + '/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: goalMap[newStatus] })
      });
      toast('Goal moved to ' + newStatus, 'success');
      loadTasks();
    } catch(e) { toast('Move failed: ' + e.message, 'error'); }
  }

  async function addTask() {
    var title = document.getElementById('taskTitleInput').value.trim();
    if (!title) return;
    var assignee = document.getElementById('taskAssignee').value;
    var priority = document.getElementById('taskPriority').value;
    try {
      await api('/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title, priority: priority, source: assignee })
      });
      document.getElementById('taskTitleInput').value = '';
      toast('Goal added', 'success');
      loadTasks();
    } catch(e) { toast('Add failed: ' + e.message, 'error'); }
  }

  // --- Activity Log ---
  var activityLog = [];

  async function loadActivity() {
    try {
      var [st, br, co] = await Promise.all([api('/status'), api('/brain'), api('/costs/summary')]);
      // Update stat cards
      if (st) {
        var upMs = st.started_at ? Date.now() - new Date(st.started_at).getTime() : 0;
        var upH = Math.floor(upMs / 3600000), upM = Math.floor((upMs % 3600000) / 60000);
        document.getElementById('actUptime').textContent = upH > 0 ? upH + 'h ' + upM + 'm' : upM + 'm';
        document.getElementById('actQueue').textContent = (st.queue ? st.queue.running : 0) + ' / ' + (st.queue ? st.queue.waiting : 0);
        document.getElementById('actMcp').textContent = st.vestige_mcp || 'unknown';
      }
      if (co) {
        var todayTotal = co.today ? co.today.total : (co.total || 0);
        document.getElementById('actCost').textContent = '$' + Number(todayTotal).toFixed(4);
      }
      // Store brain data for snapshot
      window._lastBrain = br;
      window._lastStatus = st;
      window._lastCosts = co;
    } catch(e) {
      document.getElementById('actUptime').textContent = 'offline';
    }
    renderActivityTimeline();
  }

  function snapshotActivity() {
    var now = new Date().toISOString();
    var st = window._lastStatus;
    var br = window._lastBrain;
    var co = window._lastCosts;
    if (st) {
      activityLog.unshift({ type: 'system', title: 'Status: ' + (st.vestige_mcp || 'unknown') + ' MCP, queue ' + (st.queue ? st.queue.running + '/' + st.queue.waiting : '?'), ts: now, source: 'status' });
    }
    if (co) {
      var t = co.today ? co.today.total : (co.total || 0);
      activityLog.unshift({ type: 'cost', title: 'Cost snapshot: $' + Number(t).toFixed(4) + ' today', ts: now, source: 'costs' });
    }
    if (br && br.proposals) {
      br.proposals.forEach(function(p) {
        activityLog.unshift({ type: 'proposal', title: p.title || p.action || 'Proposal ' + (p.id || ''), ts: now, source: 'brain', detail: p.patternType || '' });
      });
    }
    if (!st && !co && !br) {
      activityLog.unshift({ type: 'system', title: 'Empty snapshot — Sela offline', ts: now, source: 'user' });
    }
    // Keep last 100
    if (activityLog.length > 100) activityLog = activityLog.slice(0, 100);
    renderActivityTimeline();
    toast('Snapshot captured', 'success');
  }

  function renderActivityTimeline() {
    var el = document.getElementById('activityTimeline');
    if (!activityLog.length) { el.innerHTML = '<div class="empty">No activity yet &mdash; click Snapshot to capture</div>'; return; }
    el.innerHTML = activityLog.map(function(e) {
      var time = new Date(e.ts).toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: (window.__SELA_TZ||'UTC') });
      return '<div class="act-entry ' + e.type + '">' +
        '<span class="act-badge ' + e.type + '">' + e.type + '</span>' +
        '<span style="font-size:11px">' + esc(e.title) + '</span>' +
        (e.detail ? '<span style="color:var(--text3);font-size:10px;margin-left:6px">' + esc(e.detail) + '</span>' : '') +
        '<div style="color:var(--text3);font-size:9px;margin-top:2px">' + e.source + ' &middot; ' + time + '</div>' +
      '</div>';
    }).join('');
  }

  // --- Approvals (Brain Proposals) ---
  async function loadApprovals() {
    try {
      var d = await api('/brain');
      var proposals = d.proposals || [];
      var el = document.getElementById('approvalsList');
      if (!proposals.length) { el.innerHTML = '<div class="empty">No pending proposals</div>'; return; }
      el.innerHTML = proposals.map(function(p) {
        var id = p.id || p.proposalId || '';
        var title = p.title || p.action || 'Proposal';
        var conf = typeof p.confidence === 'number' ? p.confidence : null;
        var confColor = conf !== null ? (conf >= 0.8 ? 'var(--green)' : conf >= 0.6 ? 'var(--yellow)' : 'var(--red)') : '';
        var confPct = conf !== null ? Math.round(conf * 100) : 0;
        var statusBadge = '';
        if (p.status === 'approved') statusBadge = '<span class="badge" style="background:rgba(34,211,160,0.12);color:var(--green)">approved</span>';
        else if (p.status === 'rejected') statusBadge = '<span class="badge" style="background:rgba(244,63,94,0.12);color:var(--red)">rejected</span>';
        else statusBadge = '<span class="badge" style="background:rgba(245,158,11,0.12);color:var(--yellow)">pending</span>';

        return '<div class="approval-card">' +
          '<div class="approval-header">' +
            '<div class="approval-title">' + esc(title) + '</div>' +
            '<span class="approval-source agent">Agent</span>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
            statusBadge +
            (p.patternType ? '<span class="badge-pattern">' + esc(p.patternType) + '</span>' : '') +
          '</div>' +
          (conf !== null ? '<div class="confidence-bar"><div class="confidence-fill" style="width:' + confPct + '%;background:' + confColor + '"></div></div><div style="font-size:9px;color:var(--text3)">Confidence: ' + confPct + '%</div>' : '') +
          (p.status !== 'approved' && p.status !== 'rejected' ? '<div class="approval-actions">' +
            '<button class="btn-approve" onclick="reviewProposal(\\'' + esc(id) + '\\', \\'approve\\')">Approve</button>' +
            '<button class="btn-reject" onclick="reviewProposal(\\'' + esc(id) + '\\', \\'reject\\')">Reject</button>' +
          '</div>' : '') +
        '</div>';
      }).join('');
    } catch(e) {
      document.getElementById('approvalsList').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  async function reviewProposal(proposalId, action) {
    try {
      await api('/brain/proposals/' + encodeURIComponent(proposalId) + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action })
      });
      toast('Proposal ' + action + 'd', 'success');
      loadApprovals();
    } catch(e) { toast('Review failed: ' + e.message, 'error'); }
  }

  async function refreshAll() {
    await Promise.allSettled([loadStatus(), loadCrons(), loadServices(), loadUserNotes(), loadCronHealth(), loadTests()]);
    updateTimestamp();
  }

  // Slow poll fallback (60s) for data not pushed via WS (user notes)
  setInterval(function() {
    Promise.allSettled([loadUserNotes()]);
  }, 60000);

  // Initial load: everything once, then WS handles live data
  refreshAll();
  connectWs();
</script>
</body>
</html>`;

// --- Agent Page HTML ---


// --- Code Review Page ---

// --- Cost Analytics Page ---


// --- Goals Board Page ---


// --- History Page ---

// --- Errors Page ---

// --- Approvals Page ---


// --- HTTP Server ---

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // CORS preflight (same-origin only — no cross-origin access)
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Guardian ms_3: External heartbeat endpoint — no auth required (for UptimeRobot/cron.job)
  if (url.pathname === '/health' && req.method === 'GET') {
    const ipcConfig = getIpcConfig();
    const botOnline = ipcConfig !== null;
    res.writeHead(botOnline ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: botOnline ? 'ok' : 'degraded',
      bot: botOnline ? 'online' : 'offline',
      dashboard_uptime_s: Math.round(process.uptime()),
      pid: process.pid,
      ts: Date.now(),
    }));
    return;
  }

  // --- Login flow ---
  if (url.pathname === '/login' && req.method === 'GET') {
    if (isAuthenticated(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_HTML);
    return;
  }

  if (url.pathname === '/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || '';
    if (!checkLoginRate(ip)) {
      res.writeHead(302, { Location: '/login?error=locked' });
      res.end();
      return;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const pw = params.get('password') || '';
      if (pw === DASHBOARD_SECRET) {
        clearLoginFailures(ip);
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `dash_session=${SESSION_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`,
        });
        res.end();
      } else {
        recordLoginFailure(ip);
        res.writeHead(302, { Location: '/login?error=1' });
        res.end();
      }
    });
    return;
  }

  if (url.pathname === '/logout') {
    res.writeHead(302, {
      Location: '/login',
      'Set-Cookie': 'dash_session=; Path=/; HttpOnly; Max-Age=0',
    });
    res.end();
    return;
  }

  // --- Auth gate ---
  if (!isAuthenticated(req)) {
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
    } else {
      res.writeHead(302, { Location: '/login' });
      res.end();
    }
    return;
  }

  // Serve HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(injectTZ(HTML));
    return;
  }

  // Agent loop monitor page
  if (url.pathname === '/agent') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(AGENT_HTML));
    return;
  }

  // Goals history — redirect to main dashboard (merged into Board tab)
  if (url.pathname === '/goals-history') {
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // Code review page
  if (url.pathname === '/review') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(REVIEW_HTML));
    return;
  }

  // Cost analytics page
  if (url.pathname === '/analytics') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(COST_ANALYTICS_HTML));
    return;
  }

  // Projects page
  if (url.pathname === '/projects') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(PROJECTS_HTML));
    return;
  }

  // Project-scoped goals board
  const projectBoardMatch = url.pathname.match(/^\/projects\/([^/]+)\/board$/);
  if (projectBoardMatch) {
    const projectId = decodeURIComponent(projectBoardMatch[1]);
    const project = getProject(projectId);
    const title = project ? project.title : 'Project';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(projectBoardHtml(projectId, title)));
    return;
  }

  // Goals board page
  if (url.pathname === '/board') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(BOARD_HTML));
    return;
  }

  // History page
  if (url.pathname === '/history') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(HISTORY_HTML));
    return;
  }

  // Errors page
  if (url.pathname === '/errors') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(ERRORS_HTML));
    return;
  }

  // Approvals page
  if (url.pathname === '/approvals') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(APPROVALS_HTML));
    return;
  }

  // Ideas page
  if (url.pathname === '/ideas') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(IDEAS_HTML));
    return;
  }

  // Calendar & Crons page
  if (url.pathname === '/calendar') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(CALENDAR_HTML));
    return;
  }

  // Memory Browser page
  if (url.pathname === '/memories') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(MEMORIES_HTML));
    return;
  }

  // Module pages (Hattrick, etc.)
  const modulePage = getModuleDashboardPages().find(p => url.pathname === p.path);
  if (modulePage) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(injectTZ(modulePage.html));
    return;
  }

  // Proxy /api/* to bot-ipc
  if (url.pathname.startsWith('/api/')) {
    const ipcPath = url.pathname.slice(4); // strip /api → keep leading /
    // Block path traversal
    if (ipcPath.includes('..') || !ipcPath.startsWith('/')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid path' }));
      return;
    }
    const search = url.search || '';
    proxyToIpc(req, res, ipcPath + search, req.method);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// --- WebSocket proxy: /ws → IPC WebSocket ---
import { WebSocket, WebSocketServer } from 'ws';

const dashWss = new WebSocketServer({ noServer: true });

dashWss.on('connection', (clientWs) => {
  const ipc = getIpcConfig();
  if (!ipc) { clientWs.close(1011, 'Bot offline'); return; }

  const upstream = new WebSocket(`ws://127.0.0.1:${ipc.port}/ws?token=${ipc.token}`);

  upstream.on('open', () => {
    upstream.on('message', (data) => { if (clientWs.readyState === 1) clientWs.send(data); });
    clientWs.on('message', (data) => { if (upstream.readyState === 1) upstream.send(data); });
  });

  upstream.on('error', () => { if (clientWs.readyState === 1) clientWs.close(1011, 'IPC error'); });
  upstream.on('close', () => { if (clientWs.readyState <= 1) clientWs.close(1001, 'IPC closed'); });
  clientWs.on('close', () => { if (upstream.readyState <= 1) upstream.close(); });
  clientWs.on('error', () => { if (upstream.readyState <= 1) upstream.close(); });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Origin check — only allow same-origin WebSocket connections
  // Use hostname extraction to prevent bypass via subdomains (e.g. attacker.localhost.com)
  const origin = req.headers.origin || '';
  let originHost = '';
  try { originHost = new URL(origin).hostname; } catch {}
  if (origin && originHost !== 'localhost' && originHost !== '127.0.0.1' && !originHost.endsWith('.ts.net')) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // Auth check (same cookie as HTTP)
  if (DASHBOARD_SECRET) {
    const cookies = {};
    (req.headers.cookie || '').split(';').forEach(c => {
      const [k, ...v] = c.trim().split('=');
      if (k) cookies[k] = v.join('=');
    });
    if (cookies.dash_session !== SESSION_TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  dashWss.handleUpgrade(req, socket, head, (ws) => {
    dashWss.emit('connection', ws, req);
  });
});

// Load modules before starting so dashboard pages are available
loadModules().then(() => {
  server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    console.log(`Dashboard running at http://localhost:${DASHBOARD_PORT}`);
    console.log('Expose via Tailscale: tailscale serve --bg localhost:4242');
  });
}).catch(err => {
  console.warn('Module loading failed (non-fatal):', err.message);
  server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    console.log(`Dashboard running at http://localhost:${DASHBOARD_PORT} (without modules)`);
  });
});
