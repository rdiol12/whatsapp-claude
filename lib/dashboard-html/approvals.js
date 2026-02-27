// Auto-extracted from dashboard.js
export const APPROVALS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Approvals</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>&#x2713;</text></svg>">
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
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--accent); }
  .empty { color: var(--text3); font-size: 12px; padding: 16px; text-align: center; }
  .loading { display: flex; justify-content: center; padding: 20px; color: var(--text3); gap: 8px; align-items: center; }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .badge { display: inline-block; font-size: 9px; padding: 1px 6px; border-radius: 3px; }
  .toast-container { position: fixed; top: 16px; right: 16px; z-index: 10000; display: flex; flex-direction: column; gap: 8px; }
  .toast { padding: 8px 14px; border-radius: 6px; background: var(--surface); border: 1px solid var(--border); font-size: 11px; animation: fadeUp 0.2s ease; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .approval-card { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 11px; margin-bottom: 7px; animation: fadeUp 0.2s ease; }
  .approval-card:hover { border-color: var(--border2); }
  .approval-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .approval-title { font-size: 12px; font-weight: 500; flex: 1; }
  .approval-source { font-size: 9px; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; flex-shrink: 0; }
  .approval-source.agent { background: rgba(124,106,247,0.15); color: var(--accent2); }
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
<div class="toast-container" id="toastContainer"></div>

<div class="header">
  <a href="/">&larr; Dashboard</a>
  <div>
    <div class="header-title">&#x2713; Approvals</div>
    <div class="header-sub">agent proposals review</div>
  </div>
</div>

<div class="container">
  <div class="card">
    <div class="card-header">
      <div class="card-title"><span class="dot"></span>Agent Proposals</div>
      <button class="card-action" onclick="loadApprovals()">&#x21bb; Sync</button>
    </div>
    <div class="card-body">
      <div id="approvalsList"><div class="loading"><div class="spinner"></div></div></div>
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

async function loadApprovals() {
  try {
    var d = await api('/brain');
    var proposals = d.proposals || [];
    var el = document.getElementById('approvalsList');
    if (!proposals.length) { el.innerHTML = '<div class="empty">No pending proposals</div>'; return; }
    el.innerHTML = proposals.map(function(p) {
      var id = p.id || p.proposalId || '';
      var title = p.patternType ? p.patternType.replace(/_/g, ' ') : 'Proposal';
      var conf = typeof p.confidence === 'number' ? p.confidence : null;
      var confColor = conf !== null ? (conf >= 0.8 ? 'var(--green)' : conf >= 0.6 ? 'var(--yellow)' : 'var(--red)') : '';
      var confPct = conf !== null ? Math.round(conf * 100) : 0;
      var statusBadge = '';
      if (p.status === 'approved') statusBadge = '<span class="badge" style="background:rgba(34,211,160,0.12);color:var(--green)">approved</span>';
      else if (p.status === 'rejected') statusBadge = '<span class="badge" style="background:rgba(244,63,94,0.12);color:var(--red)">rejected</span>';
      else statusBadge = '<span class="badge" style="background:rgba(245,158,11,0.12);color:var(--yellow)">pending</span>';
      // Parse message: extract the useful part between header and confidence footer
      var msg = p.message || '';
      var confIdx = msg.indexOf('Confidence:');
      if (confIdx > 0) msg = msg.substring(0, confIdx);
      msg = msg.replace('*Agent observation:*', '').replace(/[*_]/g, '').trim();
      var timeAgo = p.createdAt ? Math.round((Date.now() - p.createdAt) / 60000) + 'min ago' : '';

      return '<div class="approval-card">' +
        '<div class="approval-header">' +
          '<div class="approval-title" style="text-transform:capitalize">' + esc(title) + '</div>' +
          '<div style="display:flex;gap:6px;align-items:center">' +
            statusBadge +
            (timeAgo ? '<span style="font-size:9px;color:var(--text3)">' + timeAgo + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--text);margin:6px 0;white-space:pre-wrap;line-height:1.5">' + esc(msg) + '</div>' +
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

loadApprovals();
setInterval(loadApprovals, 15000);
</script>
</body>
</html>`;
