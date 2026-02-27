// Hattrick Manager dashboard page
export const HATTRICK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#101013">
<title>Hattrick Manager</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>&#9917;</text></svg>">
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@400;500;700;800&display=swap');
  :root {
    /* Hattrick — neutral dark base, clean green accents */
    --bg: #0f0f12; --surface: #16161a; --surface2: #1e1e23; --border: #27272e; --border2: #323239;
    --text: #f5f5f7; --text2: #9aa0ac; --text3: #5a6070;
    --accent: #3aaa5a; --accent2: #5acc7a; --green: #4ccc6c; --yellow: #d4a017; --red: #e04040; --cyan: #22d3ee;
    --blue: #3b82f6; --violet: #8b5cf6;
    --hattrick-dark: #1a5c35; --hattrick-mid: #267a48; --hattrick-light: #3ea060; --hattrick-glow: rgba(58,170,90,0.07);
    --font-display: 'Syne', sans-serif; --font-mono: 'JetBrains Mono', monospace; --radius: 8px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--font-mono); background: var(--bg); color: var(--text); min-height: 100vh; font-size: 13px; line-height: 1.6; }
  body::before {
    content: ''; position: fixed; inset: 0;
    background:
      radial-gradient(ellipse at 50% 0%, rgba(80,120,255,0.03) 0%, transparent 60%),
      url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
    pointer-events: none; z-index: 9999;
  }

  /* Header — Hattrick green bar */
  .header { display: flex; align-items: center; gap: 16px; padding: 14px 24px; border-bottom: 2px solid var(--hattrick-dark); background: linear-gradient(180deg, rgba(30,180,80,0.05) 0%, transparent 100%); }
  .header a { color: var(--accent); text-decoration: none; font-size: 13px; }
  .header a:hover { color: var(--accent2); }
  .header-title { font-family: var(--font-display); font-size: 20px; font-weight: 700; }
  .header-sub { color: var(--text3); font-size: 11px; }
  .cycle-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-left: 8px; }
  .cycle-dot.green { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .cycle-dot.yellow { background: var(--yellow); box-shadow: 0 0 6px var(--yellow); }
  .cycle-dot.red { background: var(--red); box-shadow: 0 0 6px var(--red); }

  /* Layout */
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
  .metrics-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 16px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 16px; }
  @media (max-width: 900px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }

  /* Cards — Hattrick green header strip */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .card-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; gap: 8px; background: linear-gradient(135deg, rgba(30,180,80,0.06) 0%, rgba(30,180,80,0.02) 100%); border-left: 3px solid var(--hattrick-mid); }
  .card-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; color: var(--text); }
  .card-body { padding: 12px 14px; }

  /* Metric card — green top border like Hattrick stat boxes */
  .metric-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; border-top: 3px solid var(--hattrick-mid); transition: border-color 0.2s; }
  .metric-card:hover { border-top-color: var(--accent2); }
  .metric-label { font-size: 10px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .metric-value { font-family: var(--font-display); font-size: 24px; font-weight: 700; color: #fff; }
  .metric-sub { font-size: 10px; color: var(--text2); margin-top: 2px; }

  /* Table — green-tinted header row */
  .tbl { width: 100%; border-collapse: collapse; font-size: 11px; }
  .tbl th { text-align: left; padding: 6px 8px; color: var(--text2); font-weight: 600; border-bottom: 2px solid var(--border2); cursor: pointer; user-select: none; white-space: nowrap; }
  .tbl th:hover { color: var(--text); }
  .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  .tbl tr:hover td { background: var(--surface2); }

  /* Result badges */
  .result-w { color: var(--green); font-weight: 700; }
  .result-d { color: var(--yellow); font-weight: 700; }
  .result-l { color: var(--red); font-weight: 700; }

  /* Action buttons — Hattrick green */
  .btn { background: transparent; border: 1px solid var(--border); border-radius: 4px; color: var(--text2); padding: 5px 12px; cursor: pointer; font-family: var(--font-mono); font-size: 11px; transition: all 0.15s; }
  .btn:hover { border-color: var(--accent); color: var(--text); }
  .btn.primary { border-color: var(--hattrick-mid); color: var(--accent); background: rgba(30,180,80,0.07); }
  .btn.primary:hover { background: rgba(30,180,80,0.15); border-color: var(--accent2); color: var(--accent2); }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .btn-group { display: flex; gap: 8px; flex-wrap: wrap; }

  /* Status badge */
  .status-badge { display: inline-block; font-size: 9px; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
  .status-ok { background: rgba(46,204,46,0.12); color: var(--green); }
  .status-error { background: rgba(224,64,64,0.12); color: var(--red); }
  .status-skip { background: rgba(122,170,122,0.12); color: var(--text2); }

  /* Toast */
  .toast-container { position: fixed; top: 16px; right: 16px; z-index: 10000; display: flex; flex-direction: column; gap: 8px; }
  .toast { padding: 8px 14px; border-radius: 6px; background: var(--surface); border: 1px solid var(--border); font-size: 11px; animation: fadeUp 0.2s ease; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

  /* Loading */
  .loading { display: flex; justify-content: center; padding: 40px; color: var(--text3); gap: 8px; align-items: center; }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .empty { color: var(--text3); font-size: 12px; padding: 16px; text-align: center; }
  .mono { font-family: var(--font-mono); }
  .text-right { text-align: right; }

  /* Utility */
  .mb { margin-bottom: 16px; }
  .mt { margin-top: 8px; }
  .mt2 { margin-top: 4px; }
  .txt-sm { font-size: 12px; }
  .txt-xs { font-size: 10px; }
  .txt-dim { color: var(--text2); }
  .txt-muted { color: var(--text3); }
  .txt-strong { font-weight: 600; }

  /* Key-value rows used in Training/Economy/Match cards */
  .kv { display: flex; flex-direction: column; gap: 5px; }
  .kv-row { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; }
  .kv-label { color: var(--text3); font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
  .kv-val { font-weight: 600; }
  .kv-val.green { color: var(--green); }
  .kv-val.yellow { color: var(--yellow); }
  .kv-val.red { color: var(--red); }

  /* Match summary */
  .match-score { font-family: var(--font-display); font-size: 28px; font-weight: 700; line-height: 1; color: var(--text); }
  .match-meta { font-size: 11px; color: var(--text2); margin-top: 4px; }
  .match-players { font-size: 10px; color: var(--text3); margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px; }

  /* Collapsible section */
  .section-toggle { cursor: pointer; user-select: none; }
  .section-toggle:hover .card-title { color: var(--text); }
  .section-body { overflow: hidden; transition: max-height 0.25s ease; }
  .section-body.collapsed { max-height: 0; }
  .section-body.expanded { max-height: 9999px; }
  .toggle-icon { font-size: 10px; color: var(--text3); margin-left: 6px; transition: transform 0.2s; }
  .collapsed-row .toggle-icon { transform: rotate(-90deg); }

  /* Analysis block */
  .analysis-block { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; font-size: 11px; color: var(--text2); white-space: pre-wrap; max-height: 220px; overflow-y: auto; line-height: 1.7; }

  /* Rating dot */
  .rating-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }

  /* Scrollbar — green tinted */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--hattrick-dark); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--hattrick-mid); }
</style>
</head>
<body>
<div class="header">
  <a href="/">&larr; Dashboard</a>
  <span class="header-title" style="color:#fff">&#9917; Hattrick Manager</span>
  <span id="cycleDot" class="cycle-dot yellow" title="Loading..."></span>
  <span class="header-sub" id="cycleStatus">loading...</span>
</div>

<div class="container">
  <div id="loadingState" class="loading"><div class="spinner"></div> Loading Hattrick data...</div>
  <div id="mainContent" style="display:none">

    <!-- Action buttons -->
    <div style="display:flex;gap:8px;margin-bottom:16px;justify-content:flex-end">
      <button class="btn primary" id="btnRunCycle" onclick="runCycle()">Run Cycle Now</button>
      <button class="btn" id="btnRefresh" onclick="forceRefresh()">Force Refresh</button>
    </div>

    <!-- Top metrics -->
    <div class="metrics-row" id="metricsRow">
      <div class="metric-card">
        <div class="metric-label">League Position</div>
        <div class="metric-value" id="mLeaguePos">-</div>
        <div class="metric-sub" id="mLeagueName"></div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Points</div>
        <div class="metric-value" id="mPoints">-</div>
        <div class="metric-sub" id="mForm"></div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Wages / Economy</div>
        <div class="metric-value" id="mCash">-</div>
        <div class="metric-sub" id="mWeeklyNet"></div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Next Match</div>
        <div class="metric-value" id="mNextMatch">-</div>
        <div class="metric-sub" id="mNextMatchDate"></div>
      </div>
    </div>

    <!-- Next + Last match -->
    <div class="grid-2">
      <div class="card">
        <div class="card-header"><span class="card-title">&#9654; Next Match</span></div>
        <div class="card-body" id="nextMatchBody"><span class="empty">No upcoming match data</span></div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">&#9664; Last Match</span></div>
        <div class="card-body" id="lastMatchBody"><span class="empty">No match history</span></div>
      </div>
    </div>

    <!-- Players table -->
    <div class="card mb">
      <div class="card-header">
        <span class="card-title">&#9917; Players</span>
        <span class="header-sub" id="playerCount"></span>
      </div>
      <div class="card-body" style="overflow-x:auto">
        <table class="tbl" id="playersTable">
          <thead><tr>
            <th data-col="name">Name</th>
            <th data-col="age">Age</th>
            <th data-col="tsi">TSI</th>
            <th data-col="form">Form</th>
            <th data-col="stamina">Stamina</th>
            <th data-col="wage">Wage</th>
            <th data-col="lastMatchPosition">Pos</th>
            <th data-col="lastMatchRating">Rating</th>
          </tr></thead>
          <tbody id="playersTbody"></tbody>
        </table>
        <div class="empty" id="playersEmpty">No player data — run a cycle to fetch</div>
      </div>
    </div>

    <!-- 3-column: Training, Economy, Transfers -->
    <div class="grid-3">
      <div class="card">
        <div class="card-header"><span class="card-title">&#127939; Training</span></div>
        <div class="card-body" id="trainingBody"><span class="empty">No training data</span></div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">&#128176; Economy</span></div>
        <div class="card-body" id="economyBody"><span class="empty">No economy data</span></div>
      </div>
      <div class="card">
        <div class="card-header"><span class="card-title">&#128269; Transfer Watchlist</span></div>
        <div class="card-body" id="transferBody"><span class="empty">No watchlist targets</span></div>
      </div>
    </div>

    <!-- Match History -->
    <div class="card mb">
      <div class="card-header"><span class="card-title">&#128202; Match History</span></div>
      <div class="card-body" style="overflow-x:auto">
        <table class="tbl" id="matchHistoryTable">
          <thead><tr>
            <th>Round</th><th>Opponent</th><th>Score</th><th>Result</th><th>Venue</th><th>Date</th>
          </tr></thead>
          <tbody id="matchHistoryTbody"></tbody>
        </table>
        <div class="empty" id="matchHistoryEmpty">No match history</div>
      </div>
    </div>

    <!-- Last Analysis -->
    <div class="card mb">
      <div class="card-header"><span class="card-title">&#128200; Last Analysis</span><span id="analysisMeta" class="txt-xs txt-muted"></span></div>
      <div class="card-body" id="analysisBody"><span class="empty">No analysis on file</span></div>
    </div>

    <!-- Cycle Log (collapsed by default) -->
    <div class="card mb">
      <div class="card-header section-toggle" id="cycleLogToggle" onclick="toggleCycleLog()">
        <span class="card-title">&#128336; Cycle Log <span class="toggle-icon" id="cycleLogIcon">&#9660;</span></span>
        <span id="cycleLogMeta" class="txt-xs txt-muted"></span>
      </div>
      <div class="section-body collapsed" id="cycleLogBody">
        <div class="card-body" style="overflow-x:auto;padding-top:0">
          <table class="tbl" id="cycleLogTable">
            <thead><tr>
              <th>Time</th><th>Action</th><th>Model</th><th>Duration</th><th>Status</th><th>Reason</th>
            </tr></thead>
            <tbody id="cycleLogTbody"></tbody>
          </table>
          <div class="empty" id="cycleLogEmpty">No cycle log entries</div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="toast-container" id="toasts"></div>

<script>
const API = '/api/hattrick';
let data = null;
let sortCol = null;
let sortAsc = true;

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderColor = type === 'error' ? 'var(--red)' : type === 'ok' ? 'var(--green)' : 'var(--border)';
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('en-IL', { timeZone: (window.__SELA_TZ||'UTC'), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtAgo(ts) {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.round(hrs / 24) + 'd ago';
}

function fmtDuration(ms) {
  if (!ms) return '-';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}

function fmtCurrency(amount) {
  if (amount == null) return '-';
  if (typeof amount === 'string') return amount;
  return amount.toLocaleString('en-US');
}

async function fetchData() {
  try {
    const res = await fetch(API);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
    render();
  } catch (err) {
    console.error('Fetch failed:', err);
    toast('Failed to load data: ' + err.message, 'error');
  }
}

function render() {
  if (!data) return;
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('mainContent').style.display = 'block';

  renderCycleStatus();
  renderMetrics();
  renderNextMatch();
  renderLastMatch();
  renderPlayers();
  renderTraining();
  renderEconomy();
  renderTransfers();
  renderMatchHistory();
  renderCycleLog();
  renderAnalysis();
}

function renderCycleStatus() {
  const s = data.cycleState || {};
  const dot = document.getElementById('cycleDot');
  const label = document.getElementById('cycleStatus');

  if (s.running) {
    dot.className = 'cycle-dot green';
    dot.title = 'Cycle running now';
    label.textContent = 'running...';
  } else if (s.consecutiveErrors >= 3) {
    dot.className = 'cycle-dot red';
    dot.title = s.consecutiveErrors + ' consecutive errors';
    label.textContent = s.consecutiveErrors + ' errors';
  } else if (s.timerActive) {
    dot.className = 'cycle-dot green';
    dot.title = 'Timer active';
    const next = s.nextDecision;
    label.textContent = next ? 'next: ' + next.action : 'idle (nothing needed)';
  } else {
    dot.className = 'cycle-dot yellow';
    dot.title = 'Timer not active';
    label.textContent = 'stopped';
  }
}

function renderMetrics() {
  const snap = data.snapshot || {};
  const eco = snap.economy || {};
  const um = snap.upcomingMatch || {};
  document.getElementById('mLeaguePos').textContent = snap.leaguePosition || '-';
  document.getElementById('mLeagueName').textContent = snap.leagueName || '';

  // Points — from snapshot or compute W/D/L from match history
  if (snap.points != null) {
    document.getElementById('mPoints').textContent = snap.points;
  } else {
    const history = data.matchHistory || [];
    const pts = history.reduce((s, m) => s + (m.result === 'W' ? 3 : m.result === 'D' ? 1 : 0), 0);
    document.getElementById('mPoints').textContent = history.length ? pts : '-';
  }
  const history = data.matchHistory || [];
  const formStr = history.slice(-5).map(m => m.result).join('');
  document.getElementById('mForm').textContent = formStr ? 'Form: ' + formStr : snap.playersCount ? snap.playersCount + ' players' : '';

  // Cash/Wages — from economy sub-object, top-level, or computed from players
  const cash = eco.cash || snap.cash;
  const totalWages = snap.players ? snap.players.reduce((s, p) => s + (p.wage || 0), 0) : null;
  if (cash != null) {
    document.getElementById('mCash').textContent = fmtCurrency(cash);
    document.getElementById('mWeeklyNet').textContent = totalWages ? 'Wages: ' + fmtCurrency(totalWages) + '/wk' : '';
  } else if (totalWages) {
    document.getElementById('mCash').textContent = fmtCurrency(totalWages);
    document.getElementById('mWeeklyNet').textContent = '/wk wages (run economy check for cash)';
  } else {
    document.getElementById('mCash').textContent = '-';
    document.getElementById('mWeeklyNet').textContent = 'run economy check';
  }

  // Next match — from upcomingMatch object
  if (um.date) {
    const matchDate = new Date(um.date + (um.kickoff ? 'T' + um.kickoff : ''));
    const hoursUntil = Math.max(0, (matchDate - Date.now()) / 3600000);
    document.getElementById('mNextMatch').textContent = hoursUntil < 48 ? hoursUntil.toFixed(0) + 'h' : Math.round(hoursUntil / 24) + 'd';
    document.getElementById('mNextMatchDate').textContent = matchDate.toLocaleDateString('en-IL', { timeZone: (window.__SELA_TZ||'UTC'), weekday: 'short', month: 'short', day: 'numeric' });
  } else {
    document.getElementById('mNextMatch').textContent = '-';
    document.getElementById('mNextMatchDate').textContent = '';
  }
}

function renderNextMatch() {
  const snap = data.snapshot || {};
  const um = snap.upcomingMatch || {};
  const analysis = data.analysis || {};
  const el = document.getElementById('nextMatchBody');
  if (!um.opponent) { el.innerHTML = '<span class="empty">No upcoming match data</span>'; return; }
  const venue = um.isHome === true ? '🏠 Home' : um.isHome === false ? '✈️ Away' : '';
  el.innerHTML = \`
    <div class="txt-strong" style="font-size:14px">\${esc(um.opponent)}</div>
    <div class="match-meta">Round \${um.round || '?'} &bull; \${um.date || ''} \${um.kickoff || ''} \${venue ? '&bull; ' + venue : ''}</div>
    \${analysis.formation || analysis.prediction ? \`<div class="kv mt">
      \${analysis.formation ? '<div class="kv-row"><span class="kv-label">Formation</span><span class="kv-val">' + esc(analysis.formation) + '</span></div>' : ''}
      \${analysis.prediction ? '<div class="kv-row"><span class="kv-label">Prediction</span><span class="txt-dim txt-sm">' + esc(analysis.prediction) + '</span></div>' : ''}
    </div>\` : ''}
  \`;
}

function renderLastMatch() {
  const history = data.matchHistory || [];
  const el = document.getElementById('lastMatchBody');
  if (history.length === 0) { el.innerHTML = '<span class="empty">No match history</span>'; return; }
  const last = history[history.length - 1];
  const cls = last.result === 'W' ? 'result-w' : last.result === 'D' ? 'result-d' : 'result-l';
  const opponent = last.isHome ? last.awayTeam : last.homeTeam;
  const top3 = last.playerRatings ? [...last.playerRatings].sort((a,b) => (b.rating||0) - (a.rating||0)).slice(0, 3) : [];
  el.innerHTML = \`
    <div class="\${cls} match-score">\${last.goalsFor != null ? last.goalsFor : '?'} – \${last.goalsAgainst != null ? last.goalsAgainst : '?'}</div>
    <div class="match-meta">vs \${esc(opponent || '?')} &bull; Round \${last.round || '?'} &bull; \${last.isHome ? '🏠 Home' : '✈️ Away'}</div>
    \${top3.length ? \`<div class="match-players">⭐ \${top3.map(p => '<span class="txt-dim">' + esc(p.name) + '</span> <strong>' + p.rating + '</strong>').join(' &nbsp;·&nbsp; ')}</div>\` : ''}
  \`;
}

function renderPlayers() {
  const snap = data.snapshot || {};
  const players = snap.players || [];
  const tbody = document.getElementById('playersTbody');
  const empty = document.getElementById('playersEmpty');
  document.getElementById('playerCount').textContent = players.length ? players.length + ' players' : '';

  if (players.length === 0) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  let sorted = [...players];
  if (sortCol) {
    sorted.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      va = va || 0; vb = vb || 0;
      return sortAsc ? va - vb : vb - va;
    });
  }

  tbody.innerHTML = sorted.map(p => {
    const rating = p.lastMatchRating || p.rating;
    const ratingCls = rating ? (rating >= 4 ? 'result-w' : rating <= 2 ? 'result-l' : '') : '';
    const formCls = p.form >= 6 ? 'result-w' : p.form <= 4 ? 'result-l' : '';
    const played = p.lastMatchPosition != null;
    return \`<tr\${played ? '' : ' style="opacity:0.55"'}>
    <td>\${esc(p.name || '?')}</td>
    <td>\${p.age || '-'}</td>
    <td>\${p.tsi != null ? fmtCurrency(p.tsi) : '-'}</td>
    <td class="\${formCls}">\${p.form || '-'}</td>
    <td>\${p.stamina || '-'}</td>
    <td>\${p.wage != null ? fmtCurrency(p.wage) : '-'}</td>
    <td>\${played ? esc(p.lastMatchPosition) : '<span style="color:var(--text3)">bench</span>'}</td>
    <td class="\${ratingCls}">\${rating || '-'}</td>
  </tr>\`;
  }).join('');
}

function renderTraining() {
  const snap = data.snapshot || {};
  const el = document.getElementById('trainingBody');
  if (!snap.training) { el.innerHTML = '<span class="empty">No training data yet</span>'; return; }
  const t = snap.training;
  el.innerHTML = \`<div class="kv">
    <div class="kv-row"><span class="kv-label">Type</span><span class="kv-val">\${esc(t.type || t.trainingType || '-')}</span></div>
    <div class="kv-row"><span class="kv-label">Intensity</span><span class="kv-val">\${t.intensity || '-'}%</span></div>
    <div class="kv-row"><span class="kv-label">Stamina share</span><span class="kv-val">\${t.staminaShare || '-'}%</span></div>
    \${t.coach ? '<div class="kv-row"><span class="kv-label">Coach</span><span class="txt-dim txt-sm">' + esc(t.coach) + '</span></div>' : ''}
  </div>\`;
}

function renderEconomy() {
  const snap = data.snapshot || {};
  const e = snap.economy || {};
  const el = document.getElementById('economyBody');
  const totalWages = snap.players ? snap.players.reduce((s, p) => s + (p.wage || 0), 0) : null;
  const hasData = e.cash || snap.cash || totalWages;
  if (!hasData) { el.innerHTML = '<span class="empty">No economy data — run economy check</span>'; return; }
  const cash = e.cash || snap.cash;
  const income = e.weeklyIncome || e.income;
  const expenses = e.weeklyExpenses || e.expenses;
  const wages = e.wageBill || totalWages;
  el.innerHTML = \`<div class="kv">
    \${cash != null ? '<div class="kv-row"><span class="kv-label">Cash</span><span class="kv-val green">' + fmtCurrency(cash) + '</span></div>' : ''}
    \${income ? '<div class="kv-row"><span class="kv-label">Income</span><span class="kv-val">' + fmtCurrency(income) + '/wk</span></div>' : ''}
    \${expenses ? '<div class="kv-row"><span class="kv-label">Expenses</span><span class="kv-val red">' + fmtCurrency(expenses) + '/wk</span></div>' : ''}
    \${wages ? '<div class="kv-row"><span class="kv-label">Wage bill</span><span class="kv-val">' + fmtCurrency(wages) + '/wk</span></div>' : ''}
    \${e.sponsorIncome ? '<div class="kv-row"><span class="kv-label">Sponsor</span><span class="txt-dim txt-sm">' + fmtCurrency(e.sponsorIncome) + '/wk</span></div>' : ''}
  </div>
  <div class="txt-muted txt-xs mt" style="border-top:1px solid var(--border);padding-top:6px">TSI \${fmtCurrency(snap.teamTSI) || '—'} &nbsp;·&nbsp; Avg age \${snap.teamAvgAge || '?'} &nbsp;·&nbsp; Fans \${fmtCurrency(snap.fanClub) || '—'}</div>\`;
}

function renderTransfers() {
  const wl = data.watchlist || {};
  const items = wl.items || [];
  const el = document.getElementById('transferBody');
  if (items.length === 0) { el.innerHTML = '<span class="empty">No watchlist targets</span>'; return; }
  el.innerHTML = items.map(i => \`
    <div style="padding:6px 0;border-bottom:1px solid var(--border)">
      <div class="txt-strong txt-sm">\${esc(i.position || '?')} <span class="txt-dim" style="font-weight:400">— \${esc(i.reason || '')}</span></div>
      <div class="txt-muted txt-xs mt2">Age &lt;\${i.maxAge || '?'} &nbsp;·&nbsp; Skill ≥\${i.minSkill || '?'} &nbsp;·&nbsp; \${i.priority || 'normal'} priority</div>
    </div>
  \`).join('');
  if (wl.updatedAt) {
    el.innerHTML += '<div class="txt-muted txt-xs mt">Updated ' + fmtAgo(wl.updatedAt) + '</div>';
  }
}

function renderMatchHistory() {
  const history = data.matchHistory || [];
  const tbody = document.getElementById('matchHistoryTbody');
  const empty = document.getElementById('matchHistoryEmpty');
  if (history.length === 0) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  const last10 = history.slice(-10).reverse();
  tbody.innerHTML = last10.map(m => {
    const cls = m.result === 'W' ? 'result-w' : m.result === 'D' ? 'result-d' : 'result-l';
    const opponent = m.isHome ? m.awayTeam : m.homeTeam;
    return \`<tr>
      <td>\${m.round || '-'}</td>
      <td>\${esc(opponent || '?')}</td>
      <td class="\${cls}">\${m.goalsFor != null ? m.goalsFor : '?'}-\${m.goalsAgainst != null ? m.goalsAgainst : '?'}</td>
      <td class="\${cls}">\${m.result || '?'}</td>
      <td>\${m.isHome ? 'H' : 'A'}</td>
      <td>\${m.matchDate ? fmtTime(m.matchDate) : '-'}</td>
    </tr>\`;
  }).join('');
}

let cycleLogOpen = false;
function toggleCycleLog() {
  cycleLogOpen = !cycleLogOpen;
  const body = document.getElementById('cycleLogBody');
  const icon = document.getElementById('cycleLogIcon');
  const toggle = document.getElementById('cycleLogToggle');
  body.className = 'section-body ' + (cycleLogOpen ? 'expanded' : 'collapsed');
  if (icon) icon.style.transform = cycleLogOpen ? '' : 'rotate(-90deg)';
  if (toggle) toggle.classList.toggle('collapsed-row', !cycleLogOpen);
}

function renderCycleLog() {
  const logs = data.cycleLog || [];
  const tbody = document.getElementById('cycleLogTbody');
  const empty = document.getElementById('cycleLogEmpty');
  const meta = document.getElementById('cycleLogMeta');
  if (meta) meta.textContent = logs.length ? logs.length + ' entries' : '';
  if (logs.length === 0) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  const last20 = logs.slice(-20).reverse();
  tbody.innerHTML = last20.map(l => {
    const statusCls = l.status === 'ok' ? 'status-ok' : l.action === 'skip' ? 'status-skip' : 'status-error';
    return \`<tr>
      <td>\${fmtTime(l.ts)}</td>
      <td>\${esc(l.action)}</td>
      <td>\${l.model || '-'}</td>
      <td>\${fmtDuration(l.duration)}</td>
      <td><span class="status-badge \${statusCls}">\${esc((l.status || '').slice(0, 30))}</span></td>
      <td class="txt-dim" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">\${esc(l.reason || '')}</td>
    </tr>\`;
  }).join('');
}

function renderAnalysis() {
  const a = data.analysis || {};
  const el = document.getElementById('analysisBody');
  const meta = document.getElementById('analysisMeta');
  if (!a || !a.savedAt) { el.innerHTML = '<span class="empty">No analysis on file</span>'; return; }
  if (meta) meta.textContent = fmtAgo(a.savedAt);
  const fields = [
    a.formation    ? ['Formation',     esc(a.formation)]     : null,
    a.prediction   ? ['Prediction',    esc(a.prediction)]    : null,
    a.trainingFocus? ['Training focus',esc(a.trainingFocus)] : null,
  ].filter(Boolean);
  el.innerHTML = \`
    \${fields.length ? '<div class="kv" style="margin-bottom:10px">' + fields.map(([l,v]) => '<div class="kv-row"><span class="kv-label">' + l + '</span><span class="txt-sm">' + v + '</span></div>').join('') + '</div>' : ''}
    \${a.rawAnalysis ? '<div class="analysis-block">' + esc(a.rawAnalysis.slice(0, 3000)) + '</div>' : ''}
  \`;
}

// Sort handler for players table
document.getElementById('playersTable').querySelector('thead').addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const col = th.dataset.col;
  if (!col) return;
  if (sortCol === col) { sortAsc = !sortAsc; } else { sortCol = col; sortAsc = true; }
  renderPlayers();
});

// Actions
async function runCycle() {
  const btn = document.getElementById('btnRunCycle');
  btn.disabled = true;
  btn.textContent = 'Running...';
  try {
    const res = await fetch('/api/hattrick/cycle', { method: 'POST' });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    if (result.skipped && result.reason === 'already_running') {
      toast('Cycle is already running — wait for it to finish', 'info');
    } else if (result.skipped) {
      toast('Skipped: ' + (result.reason || 'nothing needed'), 'info');
    } else {
      toast('Cycle completed: ' + (result.action || 'done'), 'ok');
    }
    setTimeout(fetchData, 2000);
  } catch (err) {
    toast('Cycle failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Cycle Now';
  }
}

async function forceRefresh() {
  const btn = document.getElementById('btnRefresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing...';
  try {
    const res = await fetch('/api/hattrick/refresh', { method: 'POST' });
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    toast('Refresh triggered', 'ok');
    setTimeout(fetchData, 3000);
  } catch (err) {
    toast('Refresh failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Force Refresh';
  }
}

function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Init
fetchData();
setInterval(fetchData, 60000);
</script>
</body>
</html>`;
