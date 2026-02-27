// Auto-extracted from dashboard.js
export const AGENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Agent Loop Monitor</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>🔄</text></svg>">
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

  .back-link {
    background: var(--surface2); border: 1px solid var(--border);
    color: var(--text2); padding: 5px 12px; border-radius: var(--radius);
    cursor: pointer; font-family: var(--font-mono); font-size: 11px;
    transition: all 0.15s; text-decoration: none; display: flex; align-items: center; gap: 5px;
  }
  .back-link:hover { border-color: var(--accent); color: var(--accent2); }

  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  @keyframes fadeUp { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }

  .layout {
    display: grid;
    grid-template-columns: 340px 1fr;
    height: calc(100vh - 61px);
    overflow: hidden;
  }

  .panel {
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .panel:first-child { border-right: 1px solid var(--border); }

  .panel::-webkit-scrollbar { width: 5px; }
  .panel::-webkit-scrollbar-track { background: transparent; }
  .panel::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }
  .panel::-webkit-scrollbar-thumb:hover { background: var(--text3); }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    animation: fadeUp 0.3s ease;
  }

  .card-header {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: var(--text2);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .card-body { padding: 14px; }

  /* Status badge */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .badge-green { background: rgba(34,211,160,0.15); color: var(--green); }
  .badge-yellow { background: rgba(245,158,11,0.15); color: var(--yellow); }
  .badge-red { background: rgba(244,63,94,0.15); color: var(--red); }
  .badge-gray { background: rgba(136,136,170,0.1); color: var(--text2); }

  /* Metrics grid */
  .metrics {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .metric {
    background: var(--surface2);
    border-radius: 6px;
    padding: 10px 12px;
  }

  .metric-label { color: var(--text3); font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .metric-value { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .metric-value.accent { color: var(--accent2); }
  .metric-value.green { color: var(--green); }
  .metric-value.yellow { color: var(--yellow); }
  .metric-value.cyan { color: var(--cyan); }

  /* Signal list */
  .signal-list { display: flex; flex-direction: column; gap: 8px; }

  .signal-item {
    background: var(--surface2);
    border-radius: 6px;
    padding: 8px 12px;
    border-left: 3px solid var(--text3);
  }
  .signal-item.high { border-left-color: var(--red); }
  .signal-item.medium { border-left-color: var(--yellow); }
  .signal-item.low { border-left-color: var(--text3); }

  .signal-type { font-size: 10px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.5px; }
  .signal-summary { font-size: 12px; margin-top: 2px; }

  /* Followup list */
  .followup-item {
    background: var(--surface2);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 12px;
  }
  .followup-topic { color: var(--text); }
  .followup-time { color: var(--text3); font-size: 10px; margin-top: 2px; }

  /* Event log */
  .event-log {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: calc(100vh - 140px);
    overflow-y: auto;
  }

  .event-log::-webkit-scrollbar { width: 5px; }
  .event-log::-webkit-scrollbar-track { background: transparent; }
  .event-log::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }

  .event-entry {
    background: var(--surface2);
    border-radius: 6px;
    padding: 10px 12px;
    display: flex;
    gap: 10px;
    align-items: flex-start;
    animation: fadeUp 0.2s ease;
  }

  .event-icon {
    width: 24px; height: 24px;
    border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .event-icon.start { background: rgba(124,106,247,0.2); color: var(--accent2); }
  .event-icon.signals { background: rgba(34,211,238,0.2); color: var(--cyan); }
  .event-icon.skip { background: rgba(136,136,170,0.15); color: var(--text2); }
  .event-icon.phase2 { background: rgba(245,158,11,0.2); color: var(--yellow); }
  .event-icon.complete { background: rgba(34,211,160,0.2); color: var(--green); }
  .event-icon.error { background: rgba(244,63,94,0.2); color: var(--red); }

  .event-content { flex: 1; min-width: 0; }
  .event-title { font-size: 12px; font-weight: 500; }
  .event-detail { font-size: 11px; color: var(--text2); margin-top: 2px; }
  .event-time { font-size: 10px; color: var(--text3); flex-shrink: 0; }
  .prompt-link { color: var(--yellow); cursor: pointer; text-decoration: underline; }
  .prompt-link:hover { color: var(--accent); }
  .prompt-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 1000; display: flex; align-items: center; justify-content: center; }
  .prompt-modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 10px; width: 90vw; max-width: 800px; max-height: 80vh; display: flex; flex-direction: column; }
  .prompt-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border2); }
  .prompt-modal-header h3 { margin: 0; font-size: 14px; }
  .prompt-modal-close { background: none; border: none; color: var(--text2); font-size: 18px; cursor: pointer; padding: 4px 8px; }
  .prompt-modal-close:hover { color: var(--text); }
  .prompt-modal-body { padding: 16px; overflow-y: auto; flex: 1; }
  .prompt-modal-body pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.5; color: var(--text); }

  .empty-state { color: var(--text3); font-size: 12px; text-align: center; padding: 24px; }

  .status-row {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 12px;
  }

  .status-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--green); box-shadow: 0 0 7px var(--green);
    animation: pulse 2s ease-in-out infinite;
  }
  .status-dot.stopped { background: var(--red); box-shadow: 0 0 7px var(--red); animation: none; }
  .status-dot.idle { background: var(--yellow); box-shadow: 0 0 7px var(--yellow); }

  .timing-info { color: var(--text3); font-size: 11px; margin-top: 8px; }

  .clear-btn {
    background: none; border: 1px solid var(--border);
    color: var(--text3); padding: 2px 8px; border-radius: 4px;
    cursor: pointer; font-family: var(--font-mono); font-size: 10px;
    transition: all 0.15s;
  }
  .clear-btn:hover { border-color: var(--red); color: var(--red); }

  @media (max-width: 900px) {
    .layout { grid-template-columns: 1fr; height: auto; }
    .panel:first-child { border-right: none; border-bottom: 1px solid var(--border); }
    .event-log { max-height: 60vh; }
  }
</style>
</head>
<body>

<header class="header">
  <div class="header-left">
    <div class="logo">&loz;</div>
    <div>
      <div class="header-title">Agent Loop Monitor</div>
      <div class="header-sub">two-phase autonomous cycle</div>
    </div>
  </div>
  <div class="header-right">
    <a href="/" class="back-link">&larr; Dashboard</a>
  </div>
</header>

<div class="layout">
  <!-- Left panel: Status, Signals, Followups -->
  <div class="panel">

    <div class="card" style="text-align:center">
      <div class="card-header">Next Cycle</div>
      <div class="card-body" style="padding:12px 8px">
        <div id="countdownValue" style="font-size:32px;font-weight:700;font-family:monospace;color:var(--cyan);letter-spacing:2px">--:--</div>
        <div id="countdownLabel" style="font-size:11px;color:var(--text3);margin-top:4px"></div>
        <button id="runNowBtn" onclick="triggerCycleNow()" style="margin-top:10px;padding:6px 20px;border-radius:6px;border:1px solid var(--green);background:transparent;color:var(--green);cursor:pointer;font-family:var(--font-mono);font-size:12px;font-weight:600;transition:all 0.15s;letter-spacing:0.3px">&#9654; Run Now</button>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Loop Status</div>
      <div class="card-body">
        <div class="status-row">
          <div class="status-dot" id="loopDot"></div>
          <span id="loopStatusLabel" class="badge badge-gray">loading</span>
          <span id="loopMode" style="color:var(--text3);font-size:10px;margin-left:auto"></span>
        </div>
        <div class="metrics">
          <div class="metric">
            <div class="metric-label">Cycles</div>
            <div class="metric-value accent" id="metCycles">-</div>
          </div>
          <div class="metric">
            <div class="metric-label">Daily Cost</div>
            <div class="metric-value green" id="metCost">-</div>
          </div>
          <div class="metric">
            <div class="metric-label">Interval</div>
            <div class="metric-value cyan" id="metInterval">-</div>
          </div>
          <div class="metric">
            <div class="metric-label">Consec. Spawns</div>
            <div class="metric-value yellow" id="metSpawns">-</div>
          </div>
        </div>
        <div class="metrics" style="margin-top:6px">
          <div class="metric">
            <div class="metric-label">Chat Context</div>
            <div class="metric-value accent" id="metContext">-</div>
          </div>
          <div class="metric">
            <div class="metric-label">Last Cycle Tokens</div>
            <div class="metric-value cyan" id="metCycleTokens">-</div>
          </div>
          <div class="metric">
            <div class="metric-label">Last Model</div>
            <div class="metric-value green" id="metLastModel">-</div>
          </div>
        </div>
        <div style="margin:4px 0 2px;height:3px;background:var(--surface2);border-radius:2px;overflow:hidden">
          <div id="contextBar" style="height:100%;background:var(--accent);width:0%;transition:width 0.5s;border-radius:2px"></div>
        </div>
        <div class="timing-info" id="timingInfo"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Last Signals <span id="signalCount" class="badge badge-gray">0</span></div>
      <div class="card-body">
        <div class="signal-list" id="signalList">
          <div class="empty-state">No signals collected yet</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Last Cycle Files <span id="fileTouchCount" class="badge badge-gray">0</span></div>
      <div class="card-body">
        <div id="fileTouchList" style="font-size:11px;font-family:monospace">
          <div class="empty-state">No file changes recorded yet</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Pending Followups <span id="followupCount" class="badge badge-gray">0</span></div>
      <div class="card-body">
        <div id="followupList">
          <div class="empty-state">No followups queued</div>
        </div>
      </div>
    </div>

  </div>

  <!-- Right panel: Event Log -->
  <div class="panel">
    <div class="card" style="flex:1;display:flex;flex-direction:column">
      <div class="card-header">
        Event Log
        <button class="clear-btn" onclick="clearLog()">Clear</button>
      </div>
      <div class="card-body" style="flex:1;padding:10px">
        <div class="event-log" id="eventLog">
          <div class="empty-state">Waiting for agent cycle events&hellip;</div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
const MAX_LOG_ENTRIES = 100;
const eventLog = [];
var _seenEventKeys = {};
let wsConn = null;
let wsRetry = 0;

// --- Event type config ---
const EVENT_CONFIG = {
  'agent:cycle:start':        { icon: '&#9654;', cls: 'start',    title: 'Cycle Started' },
  'agent:cycle:signals':      { icon: '&#9733;', cls: 'signals',  title: 'Signals Collected' },
  'agent:cycle:skip':         { icon: '&#8212;', cls: 'skip',     title: 'Phase 2 Skipped' },
  'agent:cycle:phase2':       { icon: '&#9881;', cls: 'phase2',   title: 'Claude Spawn' },
  'agent:cycle:complete':     { icon: '&#10003;', cls: 'complete', title: 'Cycle Complete' },
  'agent:cycle:error':        { icon: '&#10007;', cls: 'error',   title: 'Cycle Error' },
  'agent:cycle:actions':      { icon: '&#9889;', cls: 'complete', title: 'Actions Taken' },
  'agent:cycle:goal_created': { icon: '&#9733;', cls: 'signals',  title: 'Goal Created' },
  'agent:cli:spawn':          { icon: '&#9654;', cls: 'phase2',   title: 'CLI Prompt' },
};

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: (window.__SELA_TZ||'UTC') });
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return Math.round(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.round(diff / 60000) + 'm ago';
  return Math.round(diff / 3600000) + 'h ago';
}

function eventDetail(event, data) {
  switch (event) {
    case 'agent:cycle:start': return 'Cycle #' + (data.cycleCount || '?');
    case 'agent:cycle:signals':
      return data.signalCount + ' signal' + (data.signalCount !== 1 ? 's' : '') +
        (data.signals ? ': ' + data.signals.map(function(s) { return s.type; }).join(', ') : '');
    case 'agent:cycle:skip': return 'Reason: ' + (data.reason || 'unknown').replace(/_/g, ' ');
    case 'agent:cycle:phase2': return data.signalCount + ' signals, prompt <span class="prompt-link" onclick="viewCyclePrompt(this)" data-file="' + escHtml(data.promptFile || '') + '">' + (data.promptLen || 0) + ' chars</span>';
    case 'agent:cycle:complete':
      return '$' + (data.costUsd || 0).toFixed(4) + ' | ' + (data.waMessageCount || 0) + ' msg | ' +
        (data.followupCount || 0) + ' followup | next ' + (data.nextCycleMinutes || '?') + 'min';
    case 'agent:cycle:error': return data.error || 'Unknown error';
    case 'agent:cycle:actions': return (data.actions || []).join('; ') || 'No actions';
    case 'agent:cycle:goal_created': return (data.title || 'Untitled') + ' (id: ' + (data.goalId || '?') + ')';
    case 'agent:cli:spawn': return (data.source || 'cli') + ' | ' + (data.model || '?') + ' | <span class="prompt-link" onclick="viewCliPrompt(this)" data-prompt-id="' + escHtml(data.promptId || '') + '">' + (data.promptLen || 0) + ' chars</span>' + (data.promptPreview ? ' — ' + escHtml(data.promptPreview) : '');
    default: return JSON.stringify(data);
  }
}

// --- Update left panel from state ---
function updateStatus(al) {
  if (!al) return;

  // Set countdown data FIRST — most critical for user feedback.
  // Must run before any DOM operations that could throw.
  _nextCycleAt = al.nextCycleAt ? new Date(al.nextCycleAt).getTime() : null;
  _cycleRunning = al.cycleRunning;
  tickCountdown();

  try {
  // Status dot + badge
  var dot = document.getElementById('loopDot');
  var label = document.getElementById('loopStatusLabel');
  if (al.running) {
    if (al.cycleRunning) {
      dot.className = 'status-dot';
      label.textContent = 'active';
      label.className = 'badge badge-green';
    } else {
      dot.className = 'status-dot idle';
      label.textContent = 'idle';
      label.className = 'badge badge-yellow';
    }
  } else {
    dot.className = 'status-dot stopped';
    label.textContent = 'stopped';
    label.className = 'badge badge-red';
  }

  document.getElementById('loopMode').textContent = al.mode || '';

  // Metrics
  document.getElementById('metCycles').textContent = al.cycleCount || 0;
  document.getElementById('metCost').textContent = '$' + (al.dailyCost || '0.00');
  document.getElementById('metInterval').textContent = (al.intervalMin || 0) + 'min';
  document.getElementById('metSpawns').textContent = al.consecutiveSpawns || 0;

  // Context stats
  var ctx = al.context;
  if (ctx) {
    var tokK = ((ctx.sessionTokens || 0) / 1000).toFixed(0);
    var limK = ((ctx.tokenLimit || 0) / 1000).toFixed(0);
    document.getElementById('metContext').textContent = tokK + 'K / ' + limK + 'K (' + (ctx.pct || 0) + '%)';
    document.getElementById('contextBar').style.width = Math.min(ctx.pct || 0, 100) + '%';
    document.getElementById('contextBar').style.background = (ctx.pct || 0) > 80 ? 'var(--red)' : (ctx.pct || 0) > 50 ? 'var(--yellow)' : 'var(--accent)';
  }

  // Last cycle tokens
  var lct = al.lastCycleTokens;
  if (lct) {
    var totalTok = (lct.input || 0) + (lct.output || 0);
    document.getElementById('metCycleTokens').textContent = (totalTok / 1000).toFixed(1) + 'K';
    document.getElementById('metLastModel').textContent = lct.model || '-';
  }
  } catch (err) { console.warn('updateStatus DOM error:', err); }

  // Timing
  try {
  var parts = [];
  if (al.lastCycleAt) parts.push('Last cycle: ' + timeAgo(al.lastCycleAt));
  if (al.dailyBudget) parts.push('Budget: $' + al.dailyCost + ' / $' + al.dailyBudget);
  document.getElementById('timingInfo').innerHTML = parts.join(' &middot; ');

  // Signals
  var sigs = al.lastSignals || [];
  document.getElementById('signalCount').textContent = sigs.length;
  var sl = document.getElementById('signalList');
  if (sigs.length === 0) {
    sl.innerHTML = '<div class="empty-state">No signals collected yet</div>';
  } else {
    sl.innerHTML = sigs.map(function(s) {
      return '<div class="signal-item ' + (s.urgency || 'low') + '">' +
        '<div class="signal-type">' + s.type + ' <span class="badge badge-' +
        (s.urgency === 'high' ? 'red' : s.urgency === 'medium' ? 'yellow' : 'gray') + '">' +
        s.urgency + '</span></div>' +
        '<div class="signal-summary">' + escHtml(s.summary) + '</div></div>';
    }).join('');
  }

  // File touches
  var ft = al.lastCycleFileTouches || [];
  document.getElementById('fileTouchCount').textContent = ft.length;
  var ftl = document.getElementById('fileTouchList');
  if (ft.length === 0) {
    ftl.innerHTML = '<div class="empty-state">No file changes recorded yet</div>';
  } else {
    var toolColors = {Write:'var(--green)',Edit:'var(--yellow)',Read:'var(--text3)',Bash:'var(--cyan)'};
    var toolIcons = {Write:'+',Edit:'~',Read:'.',Bash:'$'};
    ftl.innerHTML = ft.map(function(f) {
      var c = toolColors[f.tool] || 'var(--text3)';
      var icon = toolIcons[f.tool] || '?';
      var label = f.file ? f.file.replace(/^.*[/\\\\]sela[/\\\\]/,'').replace(/\\\\/g,'/') : (f.command || '');
      return '<div style="padding:3px 0;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">' +
        '<span style="color:' + c + ';font-weight:700;width:14px;text-align:center">' + icon + '</span>' +
        '<span style="color:' + c + ';font-size:10px;min-width:32px">' + f.tool + '</span>' +
        '<span style="color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(label) + '</span>' +
      '</div>';
    }).join('');
  }

  // Followups (from WS state we only get count, detail comes from REST)
  var fc = typeof al.pendingFollowups === 'number' ? al.pendingFollowups : (al.pendingFollowups || []).length;
  document.getElementById('followupCount').textContent = fc;
  } catch (err) { console.warn('updateStatus panel error:', err); }
}

function updateFollowupsDetail(followups) {
  var fl = document.getElementById('followupList');
  if (!followups || followups.length === 0) {
    fl.innerHTML = '<div class="empty-state">No followups queued</div>';
    return;
  }
  fl.innerHTML = followups.map(function(f) {
    return '<div class="followup-item"><div class="followup-topic">' + escHtml(f.topic) + '</div>' +
      '<div class="followup-time">' + (f.createdAt ? timeAgo(new Date(f.createdAt).toISOString()) : '') + '</div></div>';
  }).join('');
}

function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// --- Event log rendering ---
function addEvent(event, ts, data) {
  var cfg = EVENT_CONFIG[event];
  if (!cfg) return;

  var key = event + ':' + Math.floor(ts / 1000);
  if (_seenEventKeys[key]) return; // dedup (rounded to 1s to match WS vs REST timestamps)
  _seenEventKeys[key] = true;

  eventLog.unshift({ event: event, ts: ts, data: data });
  if (eventLog.length > MAX_LOG_ENTRIES) eventLog.length = MAX_LOG_ENTRIES;

  renderLog();
}

function renderLog() {
  var el = document.getElementById('eventLog');
  if (eventLog.length === 0) {
    el.innerHTML = '<div class="empty-state">Waiting for agent cycle events&hellip;</div>';
    return;
  }
  el.innerHTML = eventLog.map(function(e) {
    var cfg = EVENT_CONFIG[e.event] || { icon: '?', cls: 'skip', title: e.event };
    return '<div class="event-entry">' +
      '<div class="event-icon ' + cfg.cls + '">' + cfg.icon + '</div>' +
      '<div class="event-content">' +
        '<div class="event-title">' + cfg.title + '</div>' +
        '<div class="event-detail">' + (e.event === 'agent:cycle:phase2' || e.event === 'agent:cli:spawn' ? eventDetail(e.event, e.data) : escHtml(eventDetail(e.event, e.data))) + '</div>' +
      '</div>' +
      '<div class="event-time">' + formatTime(e.ts) + '</div>' +
    '</div>';
  }).join('');
}

function clearLog() {
  eventLog.length = 0;
  _seenEventKeys = {};
  renderLog();
}

function showPromptModal(title, content) {
  var overlay = document.createElement('div');
  overlay.className = 'prompt-overlay';
  overlay.onclick = function(ev) { if (ev.target === overlay) overlay.remove(); };
  overlay.innerHTML =
    '<div class="prompt-modal">' +
      '<div class="prompt-modal-header">' +
        '<h3>' + escHtml(title) + '</h3>' +
        '<button class="prompt-modal-close" id="promptCloseBtn">&times;</button>' +
      '</div>' +
      '<div class="prompt-modal-body"><pre>' + escHtml(content || '') + '</pre></div>' +
    '</div>';
  document.body.appendChild(overlay);
  document.getElementById('promptCloseBtn').onclick = function() { overlay.remove(); };
}

function viewCyclePrompt(el) {
  var file = el.getAttribute('data-file');
  console.log('[viewCyclePrompt] data-file:', file);
  if (!file) { console.warn('[viewCyclePrompt] empty data-file attribute'); return; }
  // Extract cycle number from file path
  var m = file.match(/cycle-(\\d+)-prompt/);
  if (!m) { console.warn('[viewCyclePrompt] regex did not match:', file); return; }
  var cycle = m[1];
  fetch('/api/cycle-diffs/' + cycle + '/prompt')
    .then(function(r) {
      console.log('[viewCyclePrompt] fetch status:', r.status);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (data.error) { alert('Prompt not found for cycle ' + cycle + ': ' + data.error); return; }
      showPromptModal('Cycle ' + cycle + ' Prompt (' + (data.prompt || '').length + ' chars)', data.prompt || '');
    })
    .catch(function(err) { alert('Failed to load prompt: ' + err.message); });
}

function viewCliPrompt(el) {
  var id = el.getAttribute('data-prompt-id');
  if (!id) return;
  fetch('/api/cli-prompts/' + encodeURIComponent(id))
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (data.error) { alert('Prompt not found: ' + data.error); return; }
      showPromptModal('CLI Prompt (' + (data.prompt || '').length + ' chars)', data.prompt || '');
    })
    .catch(function(err) { alert('Failed to load prompt: ' + err.message); });
}

// --- WebSocket ---
function connectWs() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsConn = new WebSocket(proto + '//' + location.host + '/ws');

  wsConn.onopen = function() {
    wsRetry = 0;
  };

  wsConn.onmessage = function(e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'state' && msg.data && msg.data.agentLoop) {
        updateStatus(msg.data.agentLoop);
        // Process events from WS state push (redundancy for real-time)
        var al = msg.data.agentLoop;
        if (Array.isArray(al.recentEvents)) {
          var addedFromState = false;
          al.recentEvents.forEach(function(ev) {
            var cfg = EVENT_CONFIG[ev.event];
            if (!cfg) return;
            var key = ev.event + ':' + Math.floor(ev.ts / 1000);
            if (!_seenEventKeys[key]) {
              _seenEventKeys[key] = true;
              eventLog.unshift({ event: ev.event, ts: ev.ts, data: ev.data || {} });
              addedFromState = true;
            }
          });
          if (addedFromState) {
            eventLog.sort(function(a, b) { return b.ts - a.ts; });
            if (eventLog.length > MAX_LOG_ENTRIES) eventLog.length = MAX_LOG_ENTRIES;
            renderLog();
          }
        }
        // Update followups from WS state
        if (Array.isArray(al.pendingFollowups)) {
          updateFollowupsDetail(al.pendingFollowups);
        }
      }
      if (msg.type === 'event' && msg.event && (msg.event.startsWith('agent:cycle:') || msg.event.startsWith('agent:cli:'))) {
        addEvent(msg.event, msg.ts, msg.data || {});
      }
    } catch (err) { /* ignore parse errors */ }
  };

  wsConn.onclose = function() {
    var delay = Math.min(1000 * Math.pow(2, wsRetry), 30000);
    wsRetry++;
    setTimeout(connectWs, delay);
  };

  wsConn.onerror = function() { };
}

// --- REST poll for detail (every 5s — matches WS push rate) ---
function loadDetail() {
  fetch('/api/agent-loop')
    .then(function(r) { if (r.status === 401) { location.href = '/login'; return null; } if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
      if (!data || data.error) return; // skip null/bot-offline responses
      updateStatus(data);
      if (Array.isArray(data.pendingFollowups)) {
        updateFollowupsDetail(data.pendingFollowups);
      }
      // Merge new events from REST (dedup by event+ts key)
      if (Array.isArray(data.recentEvents)) {
        var added = false;
        data.recentEvents.forEach(function(e) {
          var key = e.event + ':' + Math.floor(e.ts / 1000);
          if (!_seenEventKeys[key]) {
            _seenEventKeys[key] = true;
            eventLog.push({ event: e.event, ts: e.ts, data: e.data || {} });
            added = true;
          }
        });
        if (added) {
          // Sort newest first, trim
          eventLog.sort(function(a, b) { return b.ts - a.ts; });
          if (eventLog.length > MAX_LOG_ENTRIES) eventLog.length = MAX_LOG_ENTRIES;
          renderLog();
        }
      }
    })
    .catch(function(err) { console.warn('loadDetail failed:', err.message); });
}

// --- Countdown ticker (1s) ---
var _nextCycleAt = null;
var _cycleRunning = false;
function tickCountdown() {
  var val = document.getElementById('countdownValue');
  var lbl = document.getElementById('countdownLabel');
  var btn = document.getElementById('runNowBtn');
  if (!val) return;
  if (_cycleRunning) {
    val.textContent = 'RUNNING';
    val.style.color = 'var(--green)';
    if (lbl) lbl.textContent = 'cycle in progress';
    // Keep button disabled while cycle runs
    if (btn) { btn.disabled = true; btn.textContent = 'Running...'; btn.style.opacity = '0.5'; }
    return;
  }
  // Cycle not running — enable button
  if (btn && btn.textContent === 'Running...') {
    btn.disabled = false; btn.innerHTML = '&#9654; Run Now'; btn.style.opacity = '1';
    btn.style.borderColor = 'var(--green)'; btn.style.color = 'var(--green)';
  }
  if (!_nextCycleAt) { val.textContent = '--:--'; if (lbl) lbl.textContent = ''; return; }
  var diff = Math.round((_nextCycleAt - Date.now()) / 1000);
  if (diff <= 0) {
    val.textContent = '0:00';
    val.style.color = 'var(--green)';
    if (lbl) lbl.textContent = 'starting...';
    return;
  }
  var m = Math.floor(diff / 60), s = diff % 60;
  val.textContent = m + ':' + (s < 10 ? '0' : '') + s;
  val.style.color = diff < 60 ? 'var(--green)' : 'var(--cyan)';
  if (lbl) lbl.textContent = '';
}

// --- Trigger cycle now ---
function triggerCycleNow() {
  var btn = document.getElementById('runNowBtn');
  if (_cycleRunning) return; // already running
  btn.disabled = true;
  btn.textContent = 'Triggering...';
  btn.style.opacity = '0.5';
  fetch('/api/agent-loop/trigger', { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.triggered) {
        // Immediately switch to running state — timer + button stay in sync
        _cycleRunning = true;
        tickCountdown();
        // Poll aggressively to pick up cycle progress
        loadDetail();
        setTimeout(loadDetail, 2000);
        setTimeout(loadDetail, 5000);
        setTimeout(loadDetail, 10000);
      } else {
        btn.textContent = data.reason === 'cycle_already_running' ? 'Already running' : 'Failed';
        btn.style.borderColor = 'var(--yellow)';
        btn.style.color = 'var(--yellow)';
        setTimeout(function() {
          btn.disabled = false; btn.innerHTML = '&#9654; Run Now'; btn.style.opacity = '1';
          btn.style.borderColor = 'var(--green)'; btn.style.color = 'var(--green)';
        }, 2000);
      }
    })
    .catch(function() {
      btn.textContent = 'Error';
      btn.style.borderColor = 'var(--red)';
      btn.style.color = 'var(--red)';
      setTimeout(function() {
        btn.disabled = false; btn.innerHTML = '&#9654; Run Now'; btn.style.opacity = '1';
        btn.style.borderColor = 'var(--green)'; btn.style.color = 'var(--green)';
      }, 2000);
    });
}

// --- Init ---
connectWs();
loadDetail();
setInterval(loadDetail, 5000);
setInterval(tickCountdown, 1000);
</script>
</body>
</html>`;
