// Calendar / Crons screen — dedicated page at /calendar
export const CALENDAR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Calendar &amp; Crons</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>&#x1f4c5;</text></svg>">
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@400;500;700;800&display=swap');
  :root {
    --bg: #0a0a0f; --surface: #111118; --surface2: #16161f; --border: #1e1e2e; --border2: #2a2a3e;
    --text: #e2e2f0; --text2: #8888aa; --text3: #444466;
    --accent: #7c6af7; --accent2: #a78bfa; --green: #22d3a0; --yellow: #f59e0b; --red: #f43f5e; --cyan: #22d3ee;
    --font-display: 'Syne', sans-serif; --font-mono: 'JetBrains Mono', monospace; --radius: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--font-mono); background: var(--bg); color: var(--text); min-height: 100vh; padding: 20px; max-width: 900px; margin: 0 auto; }
  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .header a { color: var(--accent); text-decoration: none; font-size: 13px; white-space: nowrap; }
  .header h1 { font-family: var(--font-display); font-size: 20px; font-weight: 700; flex: 1; }
  .btn { background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; padding: 5px 12px; color: var(--text2); font-family: var(--font-mono); font-size: 11px; cursor: pointer; transition: all 0.15s; }
  .btn:hover { border-color: var(--accent); color: var(--text); }
  .btn.green { border-color: var(--green); color: var(--green); }
  .btn.green:hover { background: rgba(34,211,160,0.1); }
  .btn.red { border-color: var(--red); color: var(--red); }
  .btn.red:hover { background: rgba(244,63,94,0.1); }
  .btn.accent { border-color: var(--accent); color: var(--accent2); }
  .btn.accent:hover { background: rgba(124,106,247,0.1); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 14px; }
  .card-title { font-family: var(--font-display); font-size: 11px; font-weight: 600; margin-bottom: 14px; color: var(--text2); text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 8px; }
  .card-title .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 18px; }
  .metric { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; }
  .metric-label { font-size: 9px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px; }
  .metric-value { font-size: 18px; font-weight: 600; }
  .metric-value.green { color: var(--green); }
  .metric-value.accent { color: var(--accent2); }
  .metric-value.yellow { color: var(--yellow); }
  .metric-value.red { color: var(--red); }
  .cron-table { width: 100%; border-collapse: collapse; }
  .cron-table th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text3); padding: 6px 10px; border-bottom: 1px solid var(--border); font-weight: 500; }
  .cron-table td { padding: 10px; border-bottom: 1px solid var(--border); font-size: 12px; vertical-align: middle; }
  .cron-table tr:last-child td { border-bottom: none; }
  .cron-table tr:hover td { background: var(--surface2); }
  .cron-table tr.disabled td { opacity: 0.45; }
  .cron-name { font-weight: 500; color: var(--text); }
  .cron-schedule { font-size: 10px; color: var(--cyan); font-family: var(--font-mono); }
  .cron-human { font-size: 10px; color: var(--text2); margin-top: 2px; }
  .status-badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 500; }
  .status-badge.enabled { background: rgba(34,211,160,0.12); color: var(--green); border: 1px solid rgba(34,211,160,0.25); }
  .status-badge.disabled { background: rgba(68,68,102,0.12); color: var(--text3); border: 1px solid var(--border); }
  .status-badge .dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
  .run-status { font-size: 10px; }
  .run-status.ok { color: var(--green); }
  .run-status.error { color: var(--red); }
  .run-status.running { color: var(--yellow); }
  .run-status.never { color: var(--text3); }
  .time-cell { font-size: 11px; color: var(--text2); }
  .time-cell .abs { font-size: 9px; color: var(--text3); display: block; margin-top: 1px; }
  .action-btns { display: flex; gap: 5px; flex-wrap: nowrap; }
  .empty { text-align: center; padding: 48px 24px; color: var(--text3); font-size: 13px; }
  .loading { text-align: center; padding: 48px; color: var(--text3); }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle; margin-right: 8px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 10px 16px; font-size: 12px; z-index: 1000; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  .toast.show { opacity: 1; pointer-events: auto; }
  .toast.success { border-color: var(--green); color: var(--green); }
  .toast.error { border-color: var(--red); color: var(--red); }
  .add-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
  .add-form input, .add-form textarea, .add-form select { background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; padding: 7px 10px; color: var(--text); font-family: var(--font-mono); font-size: 12px; width: 100%; }
  .add-form input:focus, .add-form textarea:focus { outline: none; border-color: var(--accent); }
  .add-form .full { grid-column: 1 / -1; }
  .add-form textarea { resize: vertical; min-height: 80px; }
  @media (max-width: 640px) {
    .summary-grid { grid-template-columns: repeat(2, 1fr); }
    .cron-table th:nth-child(3), .cron-table td:nth-child(3),
    .cron-table th:nth-child(4), .cron-table td:nth-child(4) { display: none; }
    .add-form { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="header">
  <a href="/">&larr; Dashboard</a>
  <h1>&#x1f4c5; Calendar &amp; Crons</h1>
  <button class="btn" onclick="load()">&circlearrowright; Refresh</button>
</div>

<div class="summary-grid" id="summary"></div>
<div id="cronList"><div class="loading"><span class="spinner"></span>Loading...</div></div>

<div class="card" id="addSection" style="margin-top:8px">
  <div class="card-title"><span class="dot"></span>Add New Cron</div>
  <div class="add-form">
    <input id="newName" placeholder="Name (e.g. weekly-report)" />
    <input id="newSchedule" placeholder="Schedule (cron: 0 9 * * 1)" />
    <textarea id="newPrompt" class="full" placeholder="Prompt — what should Sela do when this cron fires?"></textarea>
    <select id="newDelivery">
      <option value="silent">silent (no notification)</option>
      <option value="announce">announce (WhatsApp message)</option>
    </select>
    <select id="newModel">
      <option value="">default model</option>
      <option value="haiku">haiku (fast/cheap)</option>
    </select>
    <div class="full" style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn accent" onclick="addCron()">+ Add Cron</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
var API_BASE = '/api';
async function api(path, opts) {
  var r = await fetch(API_BASE + path, Object.assign({ credentials: 'same-origin' }, opts));
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function toast(msg, type) {
  var el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show ' + (type||'');
  setTimeout(function(){ el.className = 'toast'; }, 2800);
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function cronToHuman(expr) {
  if (!expr) return '';
  var p = expr.trim().split(/\\s+/);
  if (p.length < 5) return expr;
  var min = p[0], hr = p[1], dom = p[2], mon = p[3], dow = p[4];
  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function pad(n){ return n < 10 ? '0'+n : ''+n; }
  function fmtTime(h,m){ return pad(parseInt(h))+':'+pad(parseInt(m)); }
  if (dom==='*' && mon==='*') {
    if (dow==='*') {
      if (hr==='*') {
        if (min.startsWith('*/')) return 'Every ' + min.slice(2) + ' min';
        return 'Every hour at :' + pad(parseInt(min));
      }
      if (hr.startsWith('*/')) return 'Every ' + hr.slice(2) + 'h at :' + pad(parseInt(min));
      return 'Daily at ' + fmtTime(hr, min);
    }
    var d = dow.split(',').map(function(x){ return days[parseInt(x)] || x; }).join(', ');
    return 'Every ' + d + ' at ' + fmtTime(hr, min);
  }
  if (dow==='*') return 'Monthly on day ' + dom + ' at ' + fmtTime(hr, min);
  return expr;
}

function relTime(ms) {
  if (!ms) return '—';
  var diff = Date.now() - ms;
  var abs = Math.abs(diff);
  var future = diff < 0;
  var s = Math.floor(abs / 1000);
  var str;
  if (s < 60) str = s + 's';
  else if (s < 3600) str = Math.floor(s/60) + 'm';
  else if (s < 86400) str = Math.floor(s/3600) + 'h';
  else str = Math.floor(s/86400) + 'd';
  return future ? 'in ' + str : str + ' ago';
}

function absTime(ms) {
  if (!ms) return '';
  var d = new Date(ms);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
}

async function load() {
  try {
    var d = await api('/crons');
    var crons = d.crons || [];
    var summary = d.summary || {};

    var enabled = crons.filter(function(c){ return c.enabled; }).length;
    var running = crons.filter(function(c){ return c.state && c.state.lastStatus === 'running'; }).length;
    var errored = crons.filter(function(c){ return c.state && c.state.consecutiveErrors > 0; }).length;
    document.getElementById('summary').innerHTML =
      '<div class="metric"><div class="metric-label">Total</div><div class="metric-value accent">' + crons.length + '</div></div>' +
      '<div class="metric"><div class="metric-label">Enabled</div><div class="metric-value green">' + enabled + '</div></div>' +
      '<div class="metric"><div class="metric-label">Running</div><div class="metric-value yellow">' + running + '</div></div>' +
      '<div class="metric"><div class="metric-label">Errors</div><div class="metric-value ' + (errored > 0 ? 'red' : '') + '">' + errored + '</div></div>';

    if (!crons.length) {
      document.getElementById('cronList').innerHTML = '<div class="empty">No crons configured yet — add one below</div>';
      return;
    }

    var sorted = crons.slice().sort(function(a, b) {
      var an = a.state && a.state.nextRun || 0;
      var bn = b.state && b.state.nextRun || 0;
      return an - bn;
    });

    var rows = sorted.map(function(c) {
      var st = c.state || {};
      var statusClass = c.enabled ? 'enabled' : 'disabled';
      var runClass = st.lastStatus === 'ok' ? 'ok' : st.lastStatus === 'error' ? 'error' : st.lastStatus === 'running' ? 'running' : 'never';
      var runLabel = st.lastStatus || 'never';
      return '<tr class="' + (c.enabled ? '' : 'disabled') + '">' +
        '<td><div class="cron-name">' + esc(c.name) + '</div><div class="cron-id" style="font-size:9px;color:var(--text3)">' + esc(c.id) + '</div></td>' +
        '<td><div class="cron-schedule">' + esc(c.schedule) + '</div><div class="cron-human">' + esc(cronToHuman(c.schedule)) + '</div></td>' +
        '<td><span class="time-cell">' + relTime(st.lastRun) + '<span class="abs">' + absTime(st.lastRun) + '</span></span></td>' +
        '<td><span class="time-cell">' + relTime(st.nextRun) + '<span class="abs">' + absTime(st.nextRun) + '</span></span></td>' +
        '<td><span class="run-status ' + runClass + '">' + esc(runLabel) + '</span>' + (st.lastDurationMs ? '<span style="font-size:9px;color:var(--text3);display:block">' + st.lastDurationMs + 'ms</span>' : '') + '</td>' +
        '<td><span class="status-badge ' + statusClass + '"><span class="dot"></span>' + (c.enabled ? 'on' : 'off') + '</span></td>' +
        '<td><div class="action-btns">' +
          '<button class="btn" onclick="runCron(\\'' + esc(c.id) + '\\')" title="Run now">&#9654;</button>' +
          '<button class="btn" onclick="toggleCron(\\'' + esc(c.id) + '\\')" title="Toggle">' + (c.enabled ? '&#9646;&#9646;' : '&#9654;') + '</button>' +
          '<button class="btn red" onclick="deleteCron(\\'' + esc(c.id) + '\\',\\'' + esc(c.name) + '\\')" title="Delete">&times;</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');

    document.getElementById('cronList').innerHTML =
      '<div class="card">' +
        '<div class="card-title"><span class="dot"></span>Scheduled Crons</div>' +
        '<div style="overflow-x:auto">' +
          '<table class="cron-table">' +
            '<thead><tr>' +
              '<th>Name</th><th>Schedule</th><th>Last Run</th><th>Next Run</th><th>Status</th><th>State</th><th>Actions</th>' +
            '</tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>';
  } catch(e) {
    document.getElementById('cronList').innerHTML = '<div class="empty">Failed to load: ' + esc(e.message) + '</div>';
  }
}

async function runCron(id) {
  try { await api('/crons/' + id + '/run', {method:'POST'}); toast('Cron triggered', 'success'); }
  catch(e) { toast(e.message, 'error'); }
}

async function toggleCron(id) {
  try { await api('/crons/' + id + '/toggle', {method:'POST'}); toast('Toggled', 'success'); load(); }
  catch(e) { toast(e.message, 'error'); }
}

async function deleteCron(id, name) {
  if (!confirm('Delete "' + name + '"?')) return;
  try { await api('/crons/' + id + '/delete', {method:'POST'}); toast('Deleted', 'success'); load(); }
  catch(e) { toast(e.message, 'error'); }
}

async function addCron() {
  var name = document.getElementById('newName').value.trim();
  var schedule = document.getElementById('newSchedule').value.trim();
  var prompt = document.getElementById('newPrompt').value.trim();
  var delivery = document.getElementById('newDelivery').value;
  var model = document.getElementById('newModel').value || undefined;
  if (!name || !schedule || !prompt) { toast('Fill in name, schedule, and prompt', 'error'); return; }
  try {
    await api('/crons', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name, schedule, prompt, delivery, model})});
    toast('Cron added!', 'success');
    document.getElementById('newName').value = '';
    document.getElementById('newSchedule').value = '';
    document.getElementById('newPrompt').value = '';
    load();
  } catch(e) { toast(e.message, 'error'); }
}

// Live updates via WebSocket
(function() {
  var ws;
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws');
    ws.onmessage = function(ev) {
      try {
        var d = JSON.parse(ev.data);
        if (d.type === 'cron_updated' || d.type === 'cron_added' || d.type === 'cron_deleted') load();
      } catch(e) {}
    };
    ws.onclose = function() { setTimeout(connect, 5000); };
    ws.onerror = function() { ws.close(); };
  }
  connect();
})();

load();
</script>
</body>
</html>`;
