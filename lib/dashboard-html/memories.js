// Memory search & browser screen — dedicated page at /memories
export const MEMORIES_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Memory Browser</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>&#x1f9e0;</text></svg>">
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@400;500;700;800&display=swap');
  :root {
    --bg: #0a0a0f; --surface: #111118; --surface2: #16161f; --border: #1e1e2e; --border2: #2a2a3e;
    --text: #e2e2f0; --text2: #8888aa; --text3: #444466;
    --accent: #7c6af7; --accent2: #a78bfa; --green: #22d3a0; --yellow: #f59e0b; --red: #f43f5e; --cyan: #22d3ee;
    --font-display: 'Syne', sans-serif; --font-mono: 'JetBrains Mono', monospace; --radius: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--font-mono); background: var(--bg); color: var(--text); min-height: 100vh; padding: 20px; max-width: 820px; margin: 0 auto; }
  .header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  .header a { color: var(--accent); text-decoration: none; font-size: 13px; white-space: nowrap; }
  .header h1 { font-family: var(--font-display); font-size: 20px; font-weight: 700; flex: 1; }
  .btn { background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; padding: 5px 12px; color: var(--text2); font-family: var(--font-mono); font-size: 11px; cursor: pointer; transition: all 0.15s; }
  .btn:hover { border-color: var(--accent); color: var(--text); }
  .btn.accent { border-color: var(--accent); color: var(--accent2); }
  .btn.accent:hover { background: rgba(124,106,247,0.1); }
  .btn.active { background: rgba(124,106,247,0.15); border-color: var(--accent); color: var(--accent2); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 14px; }
  .card-title { font-family: var(--font-display); font-size: 11px; font-weight: 600; margin-bottom: 12px; color: var(--text2); text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 8px; }
  .card-title .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
  .stats-bar { display: flex; gap: 16px; flex-wrap: wrap; font-size: 11px; margin-bottom: 16px; padding: 10px 14px; background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; }
  .stats-bar span { color: var(--text3); }
  .stats-bar strong { color: var(--accent2); }
  .stats-bar .ok { color: var(--green); }
  .stats-bar .err { color: var(--red); }
  .search-row { display: flex; gap: 8px; margin-bottom: 12px; }
  .search-input { flex: 1; background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; padding: 8px 12px; color: var(--text); font-family: var(--font-mono); font-size: 13px; }
  .search-input:focus { outline: none; border-color: var(--accent); }
  .tag-filters { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; min-height: 24px; }
  .tag-chip { padding: 3px 9px; border-radius: 12px; font-size: 10px; border: 1px solid var(--border2); color: var(--text3); cursor: pointer; transition: all 0.15s; background: var(--surface2); }
  .tag-chip:hover, .tag-chip.active { border-color: var(--accent); color: var(--accent2); background: rgba(124,106,247,0.1); }
  .type-tabs { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; }
  .mem-block { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 8px; overflow: hidden; cursor: pointer; transition: border-color 0.15s; }
  .mem-block:hover { border-color: var(--border2); }
  .mem-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }
  .mem-arrow { font-size: 9px; color: var(--text3); transition: transform 0.15s; flex-shrink: 0; }
  .mem-arrow.open { transform: rotate(90deg); }
  .mem-preview { flex: 1; font-size: 11px; color: var(--accent2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mem-meta { display: flex; gap: 6px; flex-shrink: 0; }
  .mem-tag { padding: 1px 6px; border-radius: 3px; font-size: 9px; background: rgba(124,106,247,0.12); color: var(--accent); border: 1px solid rgba(124,106,247,0.2); }
  .mem-type { padding: 1px 6px; border-radius: 3px; font-size: 9px; background: rgba(34,211,160,0.1); color: var(--green); }
  .mem-body { display: none; padding: 10px 12px 12px 12px; border-top: 1px solid var(--border); font-size: 11px; line-height: 1.7; color: var(--text2); white-space: pre-wrap; word-break: break-word; }
  .mem-body.open { display: block; }
  .empty { text-align: center; padding: 48px 24px; color: var(--text3); font-size: 13px; }
  .loading { text-align: center; padding: 48px; color: var(--text3); }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; vertical-align: middle; margin-right: 8px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .toast { position: fixed; bottom: 20px; right: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 10px 16px; font-size: 12px; z-index: 1000; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  .toast.show { opacity: 1; pointer-events: auto; }
  .toast.success { border-color: var(--green); color: var(--green); }
  .toast.error { border-color: var(--red); color: var(--red); }
  .add-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
  .add-form input, .add-form textarea, .add-form select { background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; padding: 7px 10px; color: var(--text); font-family: var(--font-mono); font-size: 12px; width: 100%; }
  .add-form input:focus, .add-form textarea:focus { outline: none; border-color: var(--accent); }
  .add-form .full { grid-column: 1 / -1; }
  .add-form textarea { resize: vertical; min-height: 90px; }
  @media (max-width: 580px) { .search-row { flex-direction: column; } .add-form { grid-template-columns: 1fr; } .mem-meta { display: none; } }
</style>
</head>
<body>
<div class="header">
  <a href="/">&larr; Dashboard</a>
  <h1>&#x1f9e0; Memory Browser</h1>
  <button class="btn" onclick="loadTimeline()">&circlearrowright; Refresh</button>
</div>

<div id="statsBar" class="stats-bar"><span>Loading Vestige stats...</span></div>

<div class="card">
  <div class="card-title"><span class="dot"></span>Search Memories</div>
  <div class="search-row">
    <input class="search-input" id="searchInput" placeholder="Search memories... (type &amp; press Enter)" onkeydown="if(event.key==='Enter') doSearch()" />
    <button class="btn accent" onclick="doSearch()">Search</button>
    <button class="btn" onclick="loadTimeline()">Recent</button>
  </div>
  <div class="type-tabs">
    <button class="btn active" id="tab-all" onclick="setTypeFilter('', this)">All types</button>
    <button class="btn" id="tab-fact" onclick="setTypeFilter('fact', this)">fact</button>
    <button class="btn" id="tab-decision" onclick="setTypeFilter('decision', this)">decision</button>
    <button class="btn" id="tab-concept" onclick="setTypeFilter('concept', this)">concept</button>
    <button class="btn" id="tab-event" onclick="setTypeFilter('event', this)">event</button>
    <button class="btn" id="tab-pattern" onclick="setTypeFilter('pattern', this)">pattern</button>
  </div>
  <div class="tag-filters" id="tagFilters"></div>
</div>

<div id="results"><div class="loading"><span class="spinner"></span>Loading recent memories...</div></div>

<div class="card" style="margin-top:8px">
  <div class="card-title"><span class="dot"></span>Save New Memory</div>
  <div class="add-form">
    <textarea id="newContent" class="full" placeholder="Memory content — what should Sela remember?"></textarea>
    <input id="newTags" placeholder="Tags (comma-separated, e.g. sela, decision, architecture)" />
    <select id="newType">
      <option value="fact">fact</option>
      <option value="decision">decision</option>
      <option value="concept">concept</option>
      <option value="event">event</option>
      <option value="pattern">pattern</option>
      <option value="note">note</option>
    </select>
    <div class="full" style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn accent" onclick="saveMemory()">+ Save Memory</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
var API_BASE = '/api';
var activeTypeFilter = '';
var activeTags = new Set();
var lastRawResults = '';

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

function setTypeFilter(type, el) {
  activeTypeFilter = type;
  document.querySelectorAll('.type-tabs .btn').forEach(function(b){ b.classList.remove('active'); });
  el.classList.add('active');
  var q = document.getElementById('searchInput').value.trim();
  if (q) doSearch(); else loadTimeline();
}

function toggleTag(tag) {
  if (activeTags.has(tag)) activeTags.delete(tag); else activeTags.add(tag);
  renderTagChips();
  var q = document.getElementById('searchInput').value.trim();
  if (q) doSearch(); else loadTimeline();
}

function renderTagChips() {
  var el = document.getElementById('tagFilters');
  if (!activeTags.size) { el.innerHTML = ''; return; }
  el.innerHTML = Array.from(activeTags).map(function(t) {
    return '<span class="tag-chip active" onclick="toggleTag(\\'' + esc(t) + '\\')">' + esc(t) + ' &times;</span>';
  }).join('');
}

async function loadStats() {
  try {
    var d = await api('/memories/stats');
    var s = d.stats || '';
    var statsEl = document.getElementById('statsBar');
    if (!s) { statsEl.innerHTML = '<span class="ok">Vestige connected</span>'; return; }
    // s is a string — extract key numbers if possible
    var totalMatch = s.match && s.match(/total[\\s\\S]*?(\\d+)/i);
    var retMatch = s.match && s.match(/retention[\\s\\S]*?([\\d.]+)/i);
    statsEl.innerHTML =
      '<span class="ok">&#x25cf; Vestige connected</span>' +
      (totalMatch ? '<span>Total: <strong>' + totalMatch[1] + '</strong></span>' : '') +
      (retMatch ? '<span>Avg retention: <strong>' + parseFloat(retMatch[1]).toFixed(2) + '</strong></span>' : '') +
      '<span style="cursor:pointer;color:var(--text3)" onclick="loadStats()" title="Refresh stats">&#x21bb;</span>';
  } catch(e) {
    document.getElementById('statsBar').innerHTML = '<span class="err">&#x26a0; Vestige offline: ' + esc(e.message) + '</span>';
  }
}

async function doSearch() {
  var q = document.getElementById('searchInput').value.trim();
  if (!q) { loadTimeline(); return; }
  document.getElementById('results').innerHTML = '<div class="loading"><span class="spinner"></span>Searching...</div>';
  try {
    var url = '/memories/search?q=' + encodeURIComponent(q) + '&limit=30';
    if (activeTypeFilter) url += '&type=' + encodeURIComponent(activeTypeFilter);
    var d = await api(url);
    lastRawResults = d.results || '';
    renderResults(lastRawResults, false);
  } catch(e) {
    document.getElementById('results').innerHTML = '<div class="empty">Search failed: ' + esc(e.message) + '</div>';
  }
}

async function loadTimeline() {
  document.getElementById('results').innerHTML = '<div class="loading"><span class="spinner"></span>Loading recent memories...</div>';
  document.getElementById('searchInput').value = '';
  try {
    var url = '/memories/timeline?limit=40';
    if (activeTypeFilter) url += '&type=' + encodeURIComponent(activeTypeFilter);
    var d = await api(url);
    lastRawResults = d.timeline || '';
    renderResults(lastRawResults, true);
  } catch(e) {
    document.getElementById('results').innerHTML = '<div class="empty">Failed to load: ' + esc(e.message) + '</div>';
  }
}

function parseMemoryBlocks(raw) {
  // Vestige returns formatted text; split into discrete memory blocks
  var text = String(raw || '');
  if (!text.trim()) return [];

  // Try to detect if it's structured JSON-like output first
  // Common pattern: blocks separated by blank lines or --- dividers
  var blocks = [];

  // Split by common memory delimiters
  var parts = text.split(/\\n(?=---)|\\n(?=\\d+\\.\\s)|\\n\\n(?=[A-Z#])/);
  if (parts.length <= 1) {
    // Try newline-separated approach: each non-empty group of lines is a block
    var lines = text.split('\\n');
    var current = [];
    lines.forEach(function(line) {
      if (!line.trim()) {
        if (current.length) { blocks.push(current.join('\\n')); current = []; }
      } else {
        current.push(line);
      }
    });
    if (current.length) blocks.push(current.join('\\n'));
  } else {
    blocks = parts.filter(function(b){ return b.trim(); });
  }

  return blocks;
}

function extractTagsFromBlock(block) {
  // Extract tags from lines like "Tags: foo, bar" or "tags: [foo, bar]"
  var tagMatch = block.match(/tags?:?\\s*\\[?([^\\n\\]]+)\\]?/i);
  if (!tagMatch) return [];
  return tagMatch[1].split(/[,;]/).map(function(t){ return t.trim().replace(/['"]/g,''); }).filter(Boolean).slice(0,5);
}

function extractTypeFromBlock(block) {
  var m = block.match(/node_?type:?\\s*(\\w+)/i) || block.match(/type:?\\s*(fact|decision|concept|event|pattern|note|person)/i);
  return m ? m[1] : '';
}

function renderResults(raw, isTimeline) {
  if (!raw || raw.length < 3) {
    document.getElementById('results').innerHTML =
      '<div class="empty">' + (isTimeline ? 'No memories yet — save some below!' : 'No results found') + '</div>';
    return;
  }

  var blocks = parseMemoryBlocks(raw);
  if (!blocks.length) {
    document.getElementById('results').innerHTML = '<div class="empty">No results</div>';
    return;
  }

  // Collect all tags for the filter chips
  var allTags = new Set();
  blocks.forEach(function(b){ extractTagsFromBlock(b).forEach(function(t){ allTags.add(t); }); });
  if (allTags.size) {
    var el = document.getElementById('tagFilters');
    el.innerHTML = Array.from(allTags).slice(0, 20).map(function(t) {
      var isActive = activeTags.has(t);
      return '<span class="tag-chip ' + (isActive?'active':'') + '" onclick="toggleTag(\\'' + esc(t) + '\\')">' + esc(t) + '</span>';
    }).join('');
  }

  // Filter by active tags
  var filtered = blocks;
  if (activeTags.size) {
    filtered = blocks.filter(function(b) {
      var btags = extractTagsFromBlock(b);
      return Array.from(activeTags).every(function(at){ return btags.includes(at); });
    });
  }

  if (!filtered.length) {
    document.getElementById('results').innerHTML = '<div class="empty">No memories match the selected tags</div>';
    return;
  }

  var label = isTimeline
    ? '<div style="font-size:10px;color:var(--text3);margin-bottom:10px">' + filtered.length + ' recent memories</div>'
    : '<div style="font-size:10px;color:var(--text3);margin-bottom:10px">' + filtered.length + ' results</div>';

  document.getElementById('results').innerHTML = label + filtered.slice(0, 50).map(function(block, i) {
    var lines = block.split('\\n');
    var firstLine = lines[0].replace(/^[-#\\d*.]+\\s*/, '').trim();
    var preview = firstLine.length > 90 ? firstLine.slice(0, 87) + '...' : firstLine;
    var tags = extractTagsFromBlock(block);
    var type = extractTypeFromBlock(block);
    var uid = 'mblock-' + i;
    return '<div class="mem-block" onclick="toggleBlock(\\'' + uid + '\\')">' +
      '<div class="mem-header">' +
        '<span class="mem-arrow" id="arr-' + uid + '">&#9654;</span>' +
        '<span class="mem-preview">' + esc(preview) + '</span>' +
        '<div class="mem-meta">' +
          (type ? '<span class="mem-type">' + esc(type) + '</span>' : '') +
          tags.slice(0,3).map(function(t){ return '<span class="mem-tag">' + esc(t) + '</span>'; }).join('') +
        '</div>' +
      '</div>' +
      '<div class="mem-body" id="body-' + uid + '">' + esc(block) + '</div>' +
    '</div>';
  }).join('');
}

function toggleBlock(uid) {
  var body = document.getElementById('body-' + uid);
  var arr = document.getElementById('arr-' + uid);
  var open = body.classList.toggle('open');
  arr.classList.toggle('open', open);
}

async function saveMemory() {
  var content = document.getElementById('newContent').value.trim();
  if (!content) { toast('Enter content', 'error'); return; }
  var tags = document.getElementById('newTags').value.split(',').map(function(t){ return t.trim(); }).filter(Boolean);
  var nodeType = document.getElementById('newType').value;
  try {
    await api('/memories/ingest', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({content, tags, nodeType})});
    toast('Memory saved!', 'success');
    document.getElementById('newContent').value = '';
    document.getElementById('newTags').value = '';
    loadStats();
  } catch(e) { toast(e.message, 'error'); }
}

// Live updates: refresh when new memory ingested
(function() {
  var ws;
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws');
    ws.onmessage = function(ev) {
      try {
        var d = JSON.parse(ev.data);
        if (d.type === 'memory_ingested' || d.type === 'memories') {
          loadStats();
          var q = document.getElementById('searchInput').value.trim();
          if (!q) loadTimeline();
        }
      } catch(e) {}
    };
    ws.onclose = function() { setTimeout(connect, 5000); };
    ws.onerror = function() { ws.close(); };
  }
  connect();
})();

loadStats();
loadTimeline();
</script>
</body>
</html>`;
