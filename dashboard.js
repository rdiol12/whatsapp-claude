#!/usr/bin/env node
/**
 * Bot Dashboard — 3-panel control center on localhost:4242.
 * Proxies all /api/* requests to bot-ipc (random port).
 * Designed for Tailscale Serve exposure (no auth needed).
 */

import http from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';

const DASHBOARD_PORT = 4242;
const DATA_DIR = join(process.env.HOME || process.env.USERPROFILE || '', 'whatsapp-claude', 'data');
const PORT_FILE = join(DATA_DIR, '.ipc-port');

function getIpcPort() {
  try {
    return parseInt(readFileSync(PORT_FILE, 'utf-8').trim());
  } catch {
    return null;
  }
}

function proxyToIpc(req, res, targetPath, targetMethod) {
  const ipcPort = getIpcPort();
  if (!ipcPort) {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Bot offline' }));
    return;
  }

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: ipcPort,
    path: targetPath,
    method: targetMethod || req.method,
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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
    grid-template-columns: 320px 1fr 300px;
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
    display: flex; align-items: center; gap: 9px; padding: 7px 9px;
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 6px; margin-bottom: 5px;
  }
  .wf-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .wf-dot.running { background: var(--green); box-shadow: 0 0 5px var(--green); animation: pulse 1.5s infinite; }
  .wf-dot.pending { background: var(--yellow); }
  .wf-dot.failed { background: var(--red); }
  .wf-dot.completed { background: var(--text3); }

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

  @media (max-width: 900px) {
    .burger { display: flex; }
    .header { padding: 14px 16px; }
    .header-sub { display: none; }
    .refresh-btn span:last-child { display: none; }
    .layout { grid-template-columns: 1fr; height: auto; }
    .panel { border-right: none; border-bottom: 1px solid var(--border); display: none; padding: 12px; }
    .panel.mobile-active { display: flex; }
  }
</style>
</head>
<body>

<header class="header">
  <div class="header-left">
    <div class="logo">A</div>
    <div>
      <div class="header-title">Agent Dashboard</div>
      <div class="header-sub">whatsapp-claude control center</div>
    </div>
  </div>
  <div class="header-right">
    <div class="status-dot" id="statusDot"></div>
    <span class="last-updated" id="lastUpdated">&mdash;</span>
    <button class="refresh-btn" onclick="refreshAll()">
      <span id="refreshIcon">&circlearrowright;</span> <span>Refresh</span>
    </button>
    <button class="burger" id="burgerBtn" onclick="toggleMobileNav()">
      <span></span><span></span><span></span>
    </button>
  </div>
</header>

<nav class="mobile-nav" id="mobileNav">
  <button class="mobile-nav-item active" onclick="showPanel(0, this)"><span class="nav-icon">&para;</span> Status &amp; Crons</button>
  <button class="mobile-nav-item" onclick="showPanel(1, this)"><span class="nav-icon">&equiv;</span> Notes &amp; Soul</button>
  <button class="mobile-nav-item" onclick="showPanel(2, this)"><span class="nav-icon">&target;</span> Goals &amp; Cost</button>
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

  </div>

  <!-- CENTER: Tabs -->
  <div class="panel" id="panel-1" style="border-right:1px solid var(--border)">

    <div class="tabs">
      <button class="tab active" onclick="switchTab('notes')">Notes</button>
      <button class="tab" onclick="switchTab('soul')">Soul</button>
      <button class="tab" onclick="switchTab('workflows')">Workflows</button>
      <button class="tab" onclick="switchTab('outcomes')">Outcomes</button>
      <button class="tab" onclick="switchTab('history')">History</button>
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
      <div class="card" style="margin-top:14px">
        <div class="card-header">
          <div class="card-title"><span class="dot"></span>Today's Activity</div>
          <button class="card-action" onclick="loadNotes()">&circlearrowright;</button>
        </div>
        <div class="notes-feed" id="notesFeed">
          <div class="loading"><div class="spinner"></div> Loading...</div>
        </div>
      </div>
      <div class="card" style="margin-top:14px;cursor:pointer" onclick="toggleNote('recap')">
        <div class="card-header">
          <div class="card-title">
            <span id="notearrow-recap" style="color:var(--text3);font-size:9px">&triangleright;</span>
            <span class="dot"></span>Daily Recap
          </div>
          <button class="card-action" onclick="event.stopPropagation();generateRecap()">Generate</button>
        </div>
        <div id="recapPreview" style="color:var(--text3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">No recap yet &mdash; click Generate.</div>
        <div id="notebody-recap" style="display:none">
          <div id="recapContent" style="color:var(--text2);font-size:12px;line-height:1.7;padding:6px 8px;background:var(--surface);border-radius:4px;margin-top:6px"></div>
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

    <!-- Workflows -->
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
    <div class="tab-content" id="tab-history">
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="dot"></span>Browse History</div>
          <input type="date" class="input" id="historyDatePicker" style="width:auto;padding:4px 8px;font-size:11px" onchange="loadHistoryDate(this.value)">
        </div>
        <div id="historyDateList"><div class="loading"><div class="spinner"></div></div></div>
      </div>
      <div class="card" id="historyDetailCard" style="margin-top:14px;display:none">
        <div class="card-header">
          <div class="card-title"><span class="dot"></span><span id="historyDetailTitle">Activity</span></div>
          <span id="historyDetailCost" style="color:var(--accent2);font-size:12px;font-weight:600"></span>
        </div>
        <div class="notes-feed" id="historyDetailFeed"></div>
      </div>
    </div>

  </div>

  <!-- RIGHT: Goals + Cost -->
  <div class="panel" id="panel-2">

    <div class="card">
      <div class="card-header">
        <div class="card-title"><span class="dot"></span>Active Goals</div>
        <button class="card-action" onclick="loadGoals()">&circlearrowright;</button>
      </div>
      <div id="goalList"><div class="loading"><div class="spinner"></div> Loading...</div></div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title"><span class="dot"></span>Cost Summary</div>
        <button class="card-action" onclick="loadCostSummary()">&circlearrowright;</button>
      </div>
      <div id="costInfo"><div class="loading"><div class="spinner"></div></div></div>
    </div>

  </div>
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
    var names = ['notes','soul','workflows','outcomes','history'];
    document.querySelectorAll('.tab').forEach(function(t,i) { t.classList.toggle('active', names[i] === name); });
    document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
    document.getElementById('tab-' + name).classList.add('active');
    if (name === 'soul') { loadSoul(); loadReviewHistory(); }
    if (name === 'workflows') loadWorkflows();
    if (name === 'outcomes') loadOutcomes();
    if (name === 'history') loadHistory();
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
        '<div class="metric"><div class="metric-label">Memory</div><div class="metric-value">' + (d.memory||'\\u2014') + '</div><div class="metric-sub">RSS</div></div>' +
        '<div class="metric"><div class="metric-label">Model</div><div class="metric-value" style="font-size:12px">' + (d.model||'\\u2014') + '</div></div>' +
        '<div class="metric"><div class="metric-label">Session</div><div class="metric-value accent">~' + fmt(d.sessionTokens) + '</div><div class="metric-sub">tokens</div></div>';
      document.getElementById('runtimeInfo').innerHTML =
        '<div class="row"><span class="row-label">Vestige MCP</span><span style="color:' + (d.mcpConnected?'var(--green)':'var(--red)') + '">' + (d.mcpConnected?'\\u25cf connected':'\\u25cb disconnected') + '</span></div>' +
        '<div class="row"><span class="row-label">Queue</span><span>' + ((d.queue&&d.queue.running)||0) + ' running \\u00b7 ' + ((d.queue&&d.queue.waiting)||0) + ' waiting</span></div>' +
        '<div class="row"><span class="row-label">Crons</span><span>' + (d.cronCount||0) + ' jobs</span></div>';
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
        var nextStr = c.nextRun ? new Date(c.nextRun).toLocaleString('en-IL',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Jerusalem'}) : '';
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

  async function loadNotes() {
    try {
      var d = await api('/notes/today');
      var raw = d.notes || d.content || '';
      var notes = parseNoteLines(raw);
      if (!notes.length) { document.getElementById('notesFeed').innerHTML = '<div class="empty">No activity yet today</div>'; return; }
      var isYesterday = d.date && d.date !== 'today';
      var header = isYesterday ? '<div style="color:var(--text3);font-size:11px;margin-bottom:6px">Showing ' + d.date + ' (no activity yet today)</div>' : '';
      document.getElementById('notesFeed').innerHTML = header + renderNoteEntries(notes, 'today-');
    } catch(e) {
      document.getElementById('notesFeed').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  function setRecapContent(text) {
    document.getElementById('recapContent').textContent = text;
    var preview = text.length > 60 ? text.slice(0, 57) + '...' : text;
    document.getElementById('recapPreview').textContent = preview;
    document.getElementById('recapPreview').style.color = 'var(--text2)';
  }

  async function loadRecap() {
    try {
      var d = await api('/recap');
      if (d.text) setRecapContent(d.text);
    } catch(e) {}
  }

  async function generateRecap() {
    document.getElementById('recapPreview').textContent = 'Generating...';
    document.getElementById('recapPreview').style.color = 'var(--text3)';
    document.getElementById('recapContent').innerHTML = '<div class="loading"><div class="spinner"></div> Generating...</div>';
    document.getElementById('notebody-recap').style.display = 'block';
    document.getElementById('notearrow-recap').innerHTML = '\\u25bc';
    try {
      var d = await api('/recap', {method:'POST'});
      var text = d.recap || d.text || 'No recap generated.';
      setRecapContent(text);
      toast('Recap generated','success');
    } catch(e) {
      document.getElementById('recapContent').innerHTML = '<span style="color:var(--text3)">' + e.message + '</span>';
      document.getElementById('recapPreview').textContent = 'Error generating recap';
    }
  }

  // --- User Notes ---
  async function loadUserNotes() {
    try {
      var d = await api('/user-notes');
      var notes = d.notes || [];
      if (!notes.length) { document.getElementById('userNoteList').innerHTML = '<div class="empty">No notes yet</div>'; return; }
      document.getElementById('userNoteList').innerHTML = notes.map(function(n, i) {
        var date = new Date(n.createdAt);
        var timeStr = date.toLocaleString('en-IL', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Jerusalem'});
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
  async function loadGoals() {
    try {
      var d = await api('/goals');
      var goals = (d.goals || d || []).filter(function(g) { return g.status==='active'||g.status==='in_progress'; });
      if (!goals.length) { document.getElementById('goalList').innerHTML = '<div class="empty">No active goals</div>'; return; }
      document.getElementById('goalList').innerHTML = goals.map(function(g) {
        return '<div class="goal-item" onclick="showGoal(\\'' + g.id + '\\')">' +
          '<div class="goal-header">' +
            '<div class="goal-title">' + esc(g.title) + '</div>' +
            '<span class="badge ' + (g.priority||'medium') + '">' + (g.priority||'med') + '</span>' +
          '</div>' +
          '<div class="progress-bar"><div class="progress-fill" style="width:' + (g.progress||0) + '%"></div></div>' +
          '<div class="goal-meta">' +
            '<span>' + (g.progress||0) + '%</span>' +
            (g.deadline?'<span>due ' + new Date(g.deadline).toLocaleDateString('en-CA') + '</span>':'') +
            (g.milestones&&g.milestones.length?'<span>' + g.milestones.filter(function(m){return m.status==='completed';}).length + '/' + g.milestones.length + ' ms</span>':'') +
          '</div>' +
        '</div>';
      }).join('');
    } catch(e) {
      document.getElementById('goalList').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  async function showGoal(id) {
    openModal('goalModal');
    document.getElementById('goalModalContent').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      var d = await api('/goals/' + id);
      var g = d.goal || d;
      document.getElementById('goalModalTitle').textContent = g.title;
      var html = '<div style="margin-bottom:11px;">' +
        '<div class="progress-bar" style="height:5px;margin-bottom:6px;"><div class="progress-fill" style="width:' + (g.progress||0) + '%"></div></div>' +
        '<div style="color:var(--text3);font-size:10px;">' + (g.progress||0) + '% \\u00b7 ' + (g.category||'general') + ' \\u00b7 ' + (g.priority||'medium') + '</div>' +
      '</div>';
      if (g.description) html += '<div style="color:var(--text2);font-size:12px;margin-bottom:14px;line-height:1.6">' + esc(g.description) + '</div>';
      if (g.milestones && g.milestones.length) {
        html += '<div class="section-label">Milestones</div>';
        g.milestones.forEach(function(m) {
          html += '<div class="row">' +
            '<span style="color:' + (m.status==='completed'?'var(--green)':'var(--text3)') + '">' + (m.status==='completed'?'\\u2713':'\\u25cb') + '</span>' +
            '<span style="flex:1;margin-left:8px;' + (m.status==='completed'?'text-decoration:line-through;color:var(--text3)':'') + '">' + esc(m.title) + '</span>' +
          '</div>';
        });
      }
      if (g.retrospective) {
        html += '<div class="section-label" style="margin-top:14px">Retrospective</div>' +
          '<div style="color:var(--text2);font-size:12px;line-height:1.7;padding:9px;background:var(--surface2);border-radius:6px;border:1px solid var(--border)">' + esc(g.retrospective) + '</div>';
      }
      document.getElementById('goalModalContent').innerHTML = html;
    } catch(e) {
      document.getElementById('goalModalContent').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
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
        return '<div class="workflow-item">' +
          '<div class="wf-dot ' + w.status + '"></div>' +
          '<div style="flex:1;font-size:12px">' + esc(w.name||w.id) + '</div>' +
          '<div style="color:var(--text3);font-size:10px">' + (w.currentStep||w.status) + '</div>' +
        '</div>';
      }).join('');
    } catch(e) {
      document.getElementById('workflowList').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
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
      var d = await api('/costs/summary');
      var html = '<div class="metrics" style="grid-template-columns:1fr 1fr;margin-bottom:8px">' +
        '<div class="metric"><div class="metric-label">Today</div><div class="metric-value accent">$' + (d.today.total||0).toFixed(2) + '</div><div class="metric-sub">' + (d.today.count||0) + ' turns</div></div>' +
        '<div class="metric"><div class="metric-label">Yesterday</div><div class="metric-value">$' + (d.yesterday.total||0).toFixed(2) + '</div><div class="metric-sub">' + (d.yesterday.count||0) + ' turns</div></div>' +
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
        var today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
        var yest = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
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

  // --- Refresh all ---
  async function refreshAll() {
    var icon = document.getElementById('refreshIcon');
    icon.style.cssText = 'animation:spin 0.6s linear infinite;display:inline-block';
    await Promise.allSettled([loadStatus(), loadCrons(), loadNotes(), loadRecap(), loadGoals(), loadCostSummary(), loadServices(), loadUserNotes()]);
    icon.style.cssText = '';
    document.getElementById('lastUpdated').textContent =
      new Date().toLocaleTimeString('en-IL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }

  // Auto-refresh every 30s
  setInterval(refreshAll, 30000);
  refreshAll();
</script>
</body>
</html>`;

// --- HTTP Server ---

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Serve HTML
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // Proxy /api/* to bot-ipc
  if (url.pathname.startsWith('/api/')) {
    const ipcPath = url.pathname.slice(4); // strip /api → keep leading /
    const search = url.search || '';
    proxyToIpc(req, res, ipcPath + search, req.method);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
  console.log(`Dashboard running at http://localhost:${DASHBOARD_PORT}`);
  console.log('Expose via Tailscale: tailscale serve --bg localhost:4242');
});
