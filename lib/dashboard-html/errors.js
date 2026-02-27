// Auto-extracted from dashboard.js
export const ERRORS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Error Log</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>&#x26a0;</text></svg>">
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@400;500;700;800&display=swap');
  :root {
    --bg: #0a0a0f; --surface: #111118; --surface2: #16161f; --border: #1e1e2e; --border2: #2a2a3e;
    --text: #e2e2f0; --text2: #8888aa; --text3: #444466;
    --accent: #7c6af7; --accent2: #a78bfa; --green: #22d3a0; --yellow: #f59e0b; --red: #f43f5e; --cyan: #22d3ee;
    --font-display: 'Syne', sans-serif; --font-mono: 'JetBrains Mono', monospace; --radius: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--font-mono); background: var(--bg); color: var(--text); min-height: 100vh; font-size: 13px; line-height: 1.6; }
  body::before {
    content: ''; position: fixed; inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
    pointer-events: none; z-index: 9999;
  }
  .header { display: flex; align-items: center; gap: 16px; padding: 16px 24px; border-bottom: 1px solid var(--border); }
  .header a { color: var(--accent); text-decoration: none; font-size: 13px; }
  .header a:hover { color: var(--accent2); }
  .header-title { font-family: var(--font-display); font-size: 20px; font-weight: 700; }
  .header-sub { color: var(--text3); font-size: 11px; }
  .container { max-width: 900px; margin: 0 auto; padding: 20px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 14px; }
  .card-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .card-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .card-action { background: transparent; border: 1px solid var(--border); border-radius: 4px; color: var(--text2); padding: 3px 8px; cursor: pointer; font-family: var(--font-mono); font-size: 10px; }
  .card-action:hover { border-color: var(--accent); color: var(--text); }
  .card-body { padding: 12px 14px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .empty { color: var(--text3); font-size: 12px; padding: 16px; text-align: center; }
  .loading { display: flex; justify-content: center; padding: 20px; color: var(--text3); gap: 8px; align-items: center; }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .input { background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-family: var(--font-mono); }
  .input:focus { outline: none; border-color: var(--accent); }
  .btn { background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; color: var(--text2); padding: 4px 10px; cursor: pointer; font-family: var(--font-mono); font-size: 11px; }
  .btn:hover { border-color: var(--accent); color: var(--text); }
  .filter-bar { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; font-size: 9px; padding: 1px 6px; border-radius: 3px; }
  .toast-container { position: fixed; top: 16px; right: 16px; z-index: 10000; display: flex; flex-direction: column; gap: 8px; }
  .toast { padding: 8px 14px; border-radius: 6px; background: var(--surface); border: 1px solid var(--border); font-size: 11px; animation: fadeUp 0.2s ease; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
<div class="toast-container" id="toastContainer"></div>

<div class="header">
  <a href="/">&larr; Dashboard</a>
  <div>
    <div class="header-title">&#x26a0; Error Log</div>
    <div class="header-sub">system error tracking</div>
  </div>
</div>

<div class="container">
  <div class="card">
    <div class="card-header">
      <div class="card-title"><span class="dot" style="background:var(--red)"></span>Errors</div>
      <div style="display:flex;gap:6px;align-items:center">
        <input class="input" id="errorSearchInput" type="text" placeholder="Search..." style="width:160px;padding:5px 10px;font-size:11px" oninput="loadErrors()">
        <select class="input" id="errorSeverity" style="width:auto;padding:5px 10px;font-size:11px" onchange="loadErrors()">
          <option value="">All</option>
          <option value="critical">Critical</option>
          <option value="error">Error</option>
          <option value="warn">Warn</option>
          <option value="info">Info</option>
        </select>
        <button class="card-action" onclick="loadErrors()">&#x21bb; Refresh</button>
      </div>
    </div>
    <div class="card-body">
      <div id="errorList"><div class="loading"><div class="spinner"></div></div></div>
    </div>
  </div>
</div>

<script>
var API_BASE = '/api';

async function api(path, opts) {
  opts = opts || {};
  if (opts.body && !opts.headers) opts.headers = { 'Content-Type': 'application/json' };
  var r = await fetch(API_BASE + path, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function toast(msg, type) {
  var el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(function() { el.remove(); }, 3000);
}

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
      var resolvedBadge = e.resolved ? '<span style="color:var(--green);font-size:9px;margin-left:6px">\\u2713 resolved</span>' : '';
      return '<div style="border-left:3px solid ' + col + ';padding:8px 10px;margin-bottom:6px;background:var(--surface2);border-radius:3px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            '<span style="color:' + col + ';font-size:9px;text-transform:uppercase;font-weight:600">' + esc(e.severity) + '</span>' +
            '<span style="color:var(--text2);font-size:11px;font-weight:500">' + esc(e.module || 'unknown') + '</span>' +
            resolvedBadge +
          '</div>' +
          '<span style="color:var(--text3);font-size:9px">' + ts + '</span>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--text);margin-bottom:4px">' + esc(e.message || '') + '</div>' +
        (e.stack ? '<details style="margin-bottom:4px"><summary style="font-size:9px;color:var(--text3);cursor:pointer">Stack trace</summary><pre style="font-size:9px;color:var(--text3);margin:4px 0 0;overflow-x:auto;max-height:80px">' + esc((e.stack || '').slice(0, 400)) + '</pre></details>' : '') +
        (!e.resolved ? '<button onclick="resolveError(' + e.id + ')" style="padding:4px 12px;font-size:10px;margin-top:2px;background:#fff;color:#111;border:none;border-radius:4px;cursor:pointer;font-family:var(--font-mono);font-weight:600">Mark resolved</button>' : '') +
      '</div>';
    }).join('');
  } catch(e) {
    el.innerHTML = '<div class="empty">Failed to load: ' + esc(e.message) + '</div>';
  }
}

async function resolveError(id) {
  try {
    await api('/errors/' + id + '/resolve', { method: 'POST' });
    toast('Error resolved', 'success');
    loadErrors();
  } catch(e) {
    toast('Failed to resolve: ' + e.message, 'error');
  }
}

loadErrors();
setInterval(loadErrors, 15000);
</script>
</body>
</html>`;
