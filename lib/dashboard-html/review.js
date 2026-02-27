// Auto-extracted from dashboard.js
export const REVIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Code Review</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>&#x0394;</text></svg>">
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
  .stats-bar { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 18px; display: flex; flex-direction: column; align-items: center; min-width: 100px; }
  .stat-value { font-size: 22px; font-weight: 700; }
  .stat-value.yellow { color: var(--yellow); }
  .stat-value.green { color: var(--green); }
  .stat-value.cyan { color: var(--cyan); }
  .stat-label { font-size: 10px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.4px; margin-top: 2px; }
  .filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-btn { background: var(--surface); border: 1px solid var(--border); border-radius: 5px; padding: 5px 12px; color: var(--text2); font-family: var(--font-mono); font-size: 11px; cursor: pointer; transition: all 0.15s; }
  .filter-btn:hover { border-color: var(--accent); color: var(--text); }
  .filter-btn.active { background: var(--accent); color: white; border-color: var(--accent); }
  .cycle-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 10px; overflow: hidden; }
  .cycle-header { cursor: pointer; padding: 12px 16px; display: flex; align-items: center; gap: 10px; transition: background 0.15s; }
  .cycle-header:hover { background: var(--surface2); }
  .cycle-status { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 3px; }
  .cycle-status.pending { color: var(--yellow); background: rgba(245,158,11,0.1); }
  .cycle-status.reviewed { color: var(--green); background: rgba(34,211,160,0.1); }
  .cycle-num { font-size: 14px; font-weight: 600; }
  .cycle-meta { color: var(--text3); font-size: 11px; margin-left: auto; display: flex; gap: 12px; align-items: center; }
  .cycle-body { display: none; padding: 0 16px 16px; border-top: 1px solid var(--border); }
  .cycle-body.open { display: block; }
  .action-list { font-size: 11px; color: var(--text2); margin: 10px 0 14px; }
  .action-list div { margin: 3px 0; }
  .file-item { margin: 6px 0; }
  .file-header { cursor: pointer; padding: 6px 10px; background: var(--surface2); border-radius: 5px; font-family: monospace; font-size: 11px; display: flex; align-items: center; gap: 8px; transition: background 0.15s; }
  .file-header:hover { background: var(--border); }
  .file-icon { font-weight: 700; width: 14px; text-align: center; }
  .file-diff { display: none; margin: 4px 0; padding: 10px; background: #0d0d14; border-radius: 5px; font-size: 10px; line-height: 1.5; overflow-x: auto; max-height: 400px; color: var(--text2); white-space: pre-wrap; word-break: break-all; }
  .file-diff.open { display: block; }
  .review-btn { margin-top: 12px; padding: 6px 18px; border-radius: 5px; border: 1px solid var(--green); background: transparent; color: var(--green); cursor: pointer; font-size: 12px; font-family: var(--font-mono); font-weight: 500; transition: all 0.15s; }
  .review-btn:hover { background: var(--green); color: var(--bg); }
  .empty { text-align: center; padding: 60px; color: var(--text3); font-size: 14px; }
  .bash-list { margin: 6px 0 10px; }
  .bash-item { font-size: 10px; color: var(--cyan); font-family: monospace; padding: 2px 0; }
  @media (max-width: 600px) {
    .header { padding: 12px 16px; gap: 10px; }
    .header-title { font-size: 16px; }
    .container { padding: 12px; }
    .cycle-meta { flex-wrap: wrap; gap: 6px; }
    .stats-bar { gap: 8px; }
    .stat { padding: 8px 12px; min-width: 80px; }
  }
</style>
</head>
<body>

<div class="header">
  <a href="/">&larr; Dashboard</a>
  <div>
    <div class="header-title">Code Review</div>
    <div class="header-sub">review agent cycle changes</div>
  </div>
  <a href="/agent" style="margin-left:auto">Agent Loop &rarr;</a>
</div>

<div class="container">
  <div class="stats-bar" id="statsBar">
    <div class="stat"><div class="stat-value yellow" id="statPending">-</div><div class="stat-label">Pending</div></div>
    <div class="stat"><div class="stat-value green" id="statReviewed">-</div><div class="stat-label">Reviewed</div></div>
    <div class="stat"><div class="stat-value cyan" id="statTotal">-</div><div class="stat-label">Total</div></div>
  </div>

  <div class="filter-bar">
    <button class="filter-btn active" onclick="setFilter('all', this)">All</button>
    <button class="filter-btn" onclick="setFilter('pending', this)">Pending</button>
    <button class="filter-btn" onclick="setFilter('reviewed', this)">Reviewed</button>
  </div>

  <div id="reviewList">
    <div class="empty">Loading cycle diffs&hellip;</div>
  </div>
</div>

<script>
var allDiffs = [];
var currentFilter = 'all';

function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderDiffs();
}

function renderDiffs() {
  var el = document.getElementById('reviewList');
  var filtered = allDiffs;
  if (currentFilter === 'pending') filtered = allDiffs.filter(function(d) { return !d.reviewed; });
  if (currentFilter === 'reviewed') filtered = allDiffs.filter(function(d) { return d.reviewed; });

  // Stats
  var pending = allDiffs.filter(function(d) { return !d.reviewed; }).length;
  var reviewed = allDiffs.filter(function(d) { return d.reviewed; }).length;
  document.getElementById('statPending').textContent = pending;
  document.getElementById('statReviewed').textContent = reviewed;
  document.getElementById('statTotal').textContent = allDiffs.length;

  if (filtered.length === 0) {
    el.innerHTML = '<div class="empty">' + (allDiffs.length === 0 ? 'No cycle diffs yet' : 'No ' + currentFilter + ' diffs') + '</div>';
    return;
  }

  el.innerHTML = filtered.map(function(d, idx) {
    var statusCls = d.reviewed ? 'reviewed' : 'pending';
    var statusLabel = d.reviewed ? 'Reviewed' : 'Pending';
    var time = new Date(d.ts).toLocaleString('en-IL', {timeZone:(window.__SELA_TZ||'UTC'), month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false});
    var cycleNum = parseInt(d.cycle, 10) || 0;
    var id = 'cycle-' + cycleNum;
    var costNum = typeof d.cost === 'number' ? d.cost : parseFloat(d.cost) || 0;

    var html = '<div class="cycle-card">';
    html += '<div class="cycle-header" onclick="toggleCycle(\\'' + id + '\\')">';
    html += '<span class="cycle-status ' + statusCls + '">' + statusLabel + '</span>';
    html += '<span class="cycle-num">Cycle #' + cycleNum + '</span>';
    html += '<span class="cycle-meta">';
    html += '<span>' + escHtml(time) + '</span>';
    html += '<span>' + escHtml(d.model || '?') + '</span>';
    html += '<span>$' + costNum.toFixed(3) + '</span>';
    html += '<span>' + (Array.isArray(d.files) ? d.files.length : 0) + ' file' + ((Array.isArray(d.files) ? d.files.length : 0) !== 1 ? 's' : '') + '</span>';
    html += '</span>';
    html += '</div>';

    html += '<div class="cycle-body" id="' + id + '">';

    // Actions
    if (d.actions && d.actions.length) {
      html += '<div class="action-list">';
      d.actions.forEach(function(a) { html += '<div>\\u2022 ' + escHtml(a.slice(0, 300)) + '</div>'; });
      html += '</div>';
    }

    // Bash commands
    if (d.bashCommands && d.bashCommands.length) {
      html += '<div class="bash-list">';
      d.bashCommands.forEach(function(c) { html += '<div class="bash-item">$ ' + escHtml(c) + '</div>'; });
      html += '</div>';
    }

    // File diffs
    d.files.forEach(function(f, fi) {
      var isNew = f.diff && f.diff.startsWith('[new file');
      var noDiff = f.diff === '[no changes]';
      var diffId = id + '-f' + fi;
      var iconColor = isNew ? 'var(--green)' : noDiff ? 'var(--text3)' : 'var(--yellow)';
      var icon = isNew ? '+' : noDiff ? '.' : '~';
      html += '<div class="file-item">';
      html += '<div class="file-header" onclick="toggleDiff(\\'' + diffId + '\\')">';
      html += '<span class="file-icon" style="color:' + iconColor + '">' + icon + '</span>';
      html += '<span>' + escHtml(f.path) + '</span>';
      html += '</div>';
      html += '<pre class="file-diff" id="' + diffId + '">' + escHtml(f.diff || '') + '</pre>';
      html += '</div>';
    });

    // Review button
    if (!d.reviewed) {
      html += '<button class="review-btn" onclick="markReviewed(' + cycleNum + ', this)">Mark Reviewed</button>';
    }

    html += '</div></div>';
    return html;
  }).join('');
}

function toggleCycle(id) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

function toggleDiff(id) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

async function markReviewed(cycle, btn) {
  try {
    await fetch('/api/cycle-diffs/' + cycle + '/review', { method: 'POST' });
    btn.textContent = 'Reviewed!';
    btn.style.opacity = '0.5';
    btn.disabled = true;
    // Update local state
    allDiffs.forEach(function(d) { if (d.cycle === cycle) d.reviewed = true; });
    setTimeout(renderDiffs, 500);
  } catch (e) { alert('Failed: ' + e.message); }
}

function loadDiffs() {
  // Remember which panels are open before re-render
  var openPanels = {};
  document.querySelectorAll('.cycle-body.open').forEach(function(el) { openPanels[el.id] = true; });
  document.querySelectorAll('.file-diff.open').forEach(function(el) { openPanels[el.id] = true; });

  fetch('/api/cycle-diffs')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      allDiffs = (data.diffs || []).sort(function(a, b) { return (b.ts || 0) - (a.ts || 0); });
      renderDiffs();
      // Restore open panels
      Object.keys(openPanels).forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.classList.add('open');
      });
    })
    .catch(function() {
      document.getElementById('reviewList').innerHTML = '<div class="empty">Failed to load diffs</div>';
    });
}

// Init
loadDiffs();
setInterval(loadDiffs, 30000);
</script>
</body>
</html>`;
