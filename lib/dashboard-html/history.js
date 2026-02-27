// Auto-extracted from dashboard.js
export const HISTORY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>History</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>&#x23f0;</text></svg>">
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
  .card-body { padding: 12px 14px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--accent); }
  .empty { color: var(--text3); font-size: 12px; padding: 16px; text-align: center; }
  .loading { display: flex; justify-content: center; padding: 20px; color: var(--text3); gap: 8px; align-items: center; }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .input { background: var(--surface2); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-family: var(--font-mono); }
  .input:focus { outline: none; border-color: var(--accent); }
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
  .notes-feed { display: flex; flex-direction: column; gap: 5px; overflow-y: auto; padding: 10px 14px; }
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
</style>
</head>
<body>

<div class="header">
  <a href="/">&larr; Dashboard</a>
  <div>
    <div class="header-title">&#x23f0; History</div>
    <div class="header-sub">browse daily activity</div>
  </div>
  <div style="margin-left:auto">
    <input type="date" class="input" id="historyDatePicker" style="padding:5px 10px;font-size:11px" onchange="loadHistoryDate(this.value)">
  </div>
</div>

<div class="container">
  <div class="card">
    <div class="card-header">
      <div class="card-title"><span class="dot"></span>Dates</div>
    </div>
    <div class="card-body">
      <div id="historyDateList"><div class="loading"><div class="spinner"></div></div></div>
    </div>
  </div>

  <div class="card" id="historyDetailCard" style="display:none">
    <div class="card-header">
      <div class="card-title"><span class="dot"></span><span id="historyDetailTitle">Activity</span></div>
      <span id="historyDetailCost" style="color:var(--accent2);font-size:12px;font-weight:600"></span>
    </div>
    <div class="notes-feed" id="historyDetailFeed"></div>
  </div>

  <div class="card">
    <div class="card-header">
      <div class="card-title"><span class="dot"></span>Daily Recaps</div>
      <button onclick="generateRecap()" style="background:none;border:1px solid var(--border);color:var(--text2);padding:3px 10px;border-radius:4px;cursor:pointer;font-family:var(--font-mono);font-size:10px;transition:all 0.15s">Generate Today</button>
    </div>
    <div class="card-body">
      <div id="recapList"><div class="loading"><div class="spinner"></div></div></div>
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
  card.style.display = '';
  document.getElementById('historyDetailTitle').textContent = 'Activity \\u2014 ' + date;
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

async function loadRecap() {
  try {
    var d = await api('/recap');
    var recaps = d.recaps || [];
    var el = document.getElementById('recapList');
    if (!recaps.length) { el.innerHTML = '<div class="empty">No recaps yet. Click Generate Today.</div>'; return; }
    el.innerHTML = recaps.map(function(r) {
      var dateLabel = r.date === new Date().toLocaleDateString('en-CA') ? 'Today' : r.date;
      var hasRecap = r.text && r.text.length > 0;
      var preview = hasRecap ? (r.text.length > 80 ? r.text.slice(0, 77) + '...' : r.text) : 'Raw notes (no recap generated)';
      var content = hasRecap ? r.text : (r.notes || 'No data');
      return '<details style="margin-bottom:6px">' +
        '<summary style="cursor:pointer;padding:7px 0;font-size:12px;color:var(--text)">' +
          '<strong>' + esc(dateLabel) + '</strong>' +
          '<span style="color:var(--text3);font-size:11px;margin-left:8px">' + esc(preview) + '</span>' +
        '</summary>' +
        '<div style="color:var(--text2);font-size:12px;line-height:1.7;padding:6px 8px;background:var(--surface2);border-radius:4px;margin:4px 0 8px;white-space:pre-wrap">' + esc(content) + '</div>' +
      '</details>';
    }).join('');
  } catch(e) {
    document.getElementById('recapList').innerHTML = '<div class="empty">' + e.message + '</div>';
  }
}

async function generateRecap() {
  document.getElementById('recapList').innerHTML = '<div class="loading"><div class="spinner"></div> Generating...</div>';
  try {
    await api('/recap', {method:'POST'});
    loadRecap();
  } catch(e) {
    document.getElementById('recapList').innerHTML = '<div class="empty">' + e.message + '</div>';
  }
}

loadHistory();
loadRecap();
</script>
</body>
</html>`;
