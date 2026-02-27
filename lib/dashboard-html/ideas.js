// Auto-extracted from dashboard.js
export const IDEAS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Ideas</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>&#9733;</text></svg>">
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@400;500;700;800&display=swap');
  :root {
    --bg: #0a0a0f; --surface: #111118; --surface2: #16161f; --border: #1e1e2e; --border2: #2a2a3e;
    --text: #e2e2f0; --text2: #8888aa; --text3: #444466;
    --accent: #7c6af7; --accent2: #a78bfa; --green: #22d3a0; --yellow: #f59e0b; --red: #f43f5e; --cyan: #22d3ee;
    --blue: #3b82f6; --violet: #8b5cf6;
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
  .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 14px; }
  .card-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; gap: 8px; }
  .card-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .card-action { background: transparent; border: 1px solid var(--border); border-radius: 4px; color: var(--text2); padding: 3px 8px; cursor: pointer; font-family: var(--font-mono); font-size: 10px; }
  .card-action:hover { border-color: var(--accent); color: var(--text); }
  .card-action.active { border-color: var(--accent); color: var(--accent); background: rgba(124,106,247,0.1); }
  .card-body { padding: 12px 14px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: var(--accent); }
  .empty { color: var(--text3); font-size: 12px; padding: 16px; text-align: center; }
  .loading { display: flex; justify-content: center; padding: 20px; color: var(--text3); gap: 8px; align-items: center; }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .toast-container { position: fixed; top: 16px; right: 16px; z-index: 10000; display: flex; flex-direction: column; gap: 8px; }
  .toast { padding: 8px 14px; border-radius: 6px; background: var(--surface); border: 1px solid var(--border); font-size: 11px; animation: fadeUp 0.2s ease; }

  .idea-card { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 8px; animation: fadeUp 0.2s ease; }
  .idea-card:hover { border-color: var(--border2); }
  .idea-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .idea-title { font-size: 13px; font-weight: 600; flex: 1; }
  .badge { display: inline-block; font-size: 9px; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
  .badge-improvement { background: rgba(59,130,246,0.15); color: var(--blue); }
  .badge-agent { background: rgba(139,92,246,0.15); color: var(--violet); }
  .badge-high { background: rgba(244,63,94,0.12); color: var(--red); }
  .badge-medium { background: rgba(245,158,11,0.12); color: var(--yellow); }
  .badge-low { background: rgba(34,211,160,0.12); color: var(--green); }
  .idea-desc { font-size: 11px; color: var(--text2); margin: 6px 0; line-height: 1.5; }
  .idea-desc.truncated { max-height: 42px; overflow: hidden; cursor: pointer; }
  .idea-desc.expanded { max-height: none; }
  .idea-actions { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
  .idea-actions button { padding: 3px 8px; border-radius: 4px; cursor: pointer; font-family: var(--font-mono); font-size: 10px; border: 1px solid var(--border); background: transparent; color: var(--text2); transition: all 0.15s; }
  .idea-actions button:hover { border-color: var(--accent); color: var(--text); }
  .idea-actions button.active-status { border-color: var(--accent); color: var(--accent); background: rgba(124,106,247,0.12); }
  .btn-delete { color: var(--red) !important; }
  .btn-delete:hover { border-color: var(--red) !important; background: rgba(244,63,94,0.1) !important; }
  .btn-promote { color: var(--green) !important; border-color: rgba(34,211,160,0.3) !important; }
  .btn-promote:hover { border-color: var(--green) !important; background: rgba(34,211,160,0.1) !important; }

  /* Promote modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 20000; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 10px; padding: 20px; width: 100%; max-width: 480px; animation: fadeUp 0.2s ease; }
  .modal h3 { font-family: var(--font-display); font-size: 16px; font-weight: 700; margin-bottom: 14px; color: var(--text); }
  .modal label { display: block; font-size: 10px; color: var(--text3); margin-bottom: 3px; margin-top: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .modal input, .modal select, .modal textarea { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-family: var(--font-mono); font-size: 12px; padding: 7px 10px; outline: none; }
  .modal input:focus, .modal select:focus, .modal textarea:focus { border-color: var(--accent); }
  .modal textarea { min-height: 70px; resize: vertical; }
  .modal-actions { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }
  .modal-actions button { padding: 6px 16px; border-radius: 4px; cursor: pointer; font-family: var(--font-mono); font-size: 12px; font-weight: 600; border: 1px solid var(--border); background: transparent; color: var(--text2); }
  .modal-actions button.primary { background: var(--green); border-color: var(--green); color: #000; }
  .modal-actions button.primary:hover { opacity: 0.85; }
  .modal-actions button:not(.primary):hover { border-color: var(--text2); color: var(--text); }

  .filters { display: flex; gap: 6px; flex-wrap: wrap; }

  .add-form { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
  .add-form input, .add-form select, .add-form textarea {
    background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-family: var(--font-mono); font-size: 12px; padding: 6px 10px; outline: none;
  }
  .add-form input:focus, .add-form select:focus, .add-form textarea:focus { border-color: var(--accent); }
  .add-form input { flex: 1; min-width: 200px; }
  .add-form textarea { flex-basis: 100%; min-height: 50px; resize: vertical; }
  .add-form button { background: var(--accent); border: none; border-radius: 4px; color: white; padding: 6px 14px; cursor: pointer; font-family: var(--font-mono); font-size: 12px; font-weight: 600; }
  .add-form button:hover { background: var(--accent2); }

  .stats { display: flex; gap: 16px; padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 11px; color: var(--text3); flex-wrap: wrap; }
  .stat-val { color: var(--text); font-weight: 600; }

  .grid { display: grid; grid-template-columns: 1fr; gap: 0; }
  @media (min-width: 700px) { .grid { grid-template-columns: 1fr 1fr; gap: 8px; } .idea-card { margin-bottom: 0; } }
</style>
</head>
<body>
<div class="toast-container" id="toastContainer"></div>

<!-- Promote to Goal modal -->
<div class="modal-overlay" id="promoteModal" style="display:none" onclick="if(event.target===this)closePromoteModal()">
  <div class="modal">
    <h3>→ Promote to Goal</h3>
    <label>Title</label>
    <input type="text" id="promoteTitle" placeholder="Goal title...">
    <label>Description</label>
    <textarea id="promoteDesc" placeholder="What should the agent do?"></textarea>
    <label>Priority</label>
    <select id="promotePriority">
      <option value="high">High</option>
      <option value="medium" selected>Medium</option>
      <option value="low">Low</option>
    </select>
    <div class="modal-actions">
      <button onclick="closePromoteModal()">Cancel</button>
      <button class="primary" onclick="confirmPromote()">Create Goal &amp; Remove Idea</button>
    </div>
  </div>
</div>

<div class="header">
  <a href="/">&larr; Dashboard</a>
  <div>
    <div class="header-title">&#9733; Ideas</div>
    <div class="header-sub">improvements &amp; agent features</div>
  </div>
</div>

<div class="container">
  <div class="card">
    <div class="card-header">
      <div class="card-title"><span class="dot"></span>Idea Tracker</div>
      <div class="filters">
        <button class="card-action active" data-cat="all" onclick="setFilter('cat','all',this)">All</button>
        <button class="card-action" data-cat="improvement" onclick="setFilter('cat','improvement',this)">Improvements</button>
        <button class="card-action" data-cat="agent-feature" onclick="setFilter('cat','agent-feature',this)">Agent Features</button>
        <span style="width:8px"></span>
        <button class="card-action active" data-st="all" onclick="setFilter('st','all',this)">Any Status</button>
        <button class="card-action" data-st="proposed" onclick="setFilter('st','proposed',this)">Proposed</button>
        <button class="card-action" data-st="in_progress" onclick="setFilter('st','in_progress',this)">In Progress</button>
        <button class="card-action" data-st="done" onclick="setFilter('st','done',this)">Done</button>
        <button class="card-action" data-st="skipped" onclick="setFilter('st','skipped',this)">Skipped</button>
      </div>
    </div>
    <div class="add-form" id="addForm">
      <input type="text" id="newTitle" placeholder="Idea title...">
      <select id="newCategory">
        <option value="improvement">Improvement</option>
        <option value="agent-feature">Agent Feature</option>
      </select>
      <select id="newPriority">
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="low">Low</option>
      </select>
      <button onclick="addNewIdea()">Add</button>
      <textarea id="newDesc" placeholder="Description (optional)..."></textarea>
    </div>
    <div class="stats" id="stats"></div>
    <div class="card-body">
      <div id="ideasList"><div class="loading"><div class="spinner"></div></div></div>
    </div>
  </div>
</div>

<script>
var API_BASE = '/api';
var ideas = [];
var filterCat = 'all';
var filterSt = 'all';

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

function setFilter(type, val, btn) {
  if (type === 'cat') filterCat = val;
  if (type === 'st') filterSt = val;
  // Update active state for this filter group
  var attr = type === 'cat' ? 'data-cat' : 'data-st';
  document.querySelectorAll('.card-action[' + attr + ']').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute(attr) === val);
  });
  renderIdeas();
}

function getFiltered() {
  return ideas.filter(function(i) {
    if (filterCat !== 'all' && i.category !== filterCat) return false;
    if (filterSt !== 'all' && i.status !== filterSt) return false;
    return true;
  });
}

function renderStats() {
  var total = ideas.length;
  var improvements = ideas.filter(function(i) { return i.category === 'improvement'; }).length;
  var agentFeatures = ideas.filter(function(i) { return i.category === 'agent-feature'; }).length;
  var proposed = ideas.filter(function(i) { return i.status === 'proposed'; }).length;
  var inProg = ideas.filter(function(i) { return i.status === 'in_progress'; }).length;
  var done = ideas.filter(function(i) { return i.status === 'done'; }).length;
  document.getElementById('stats').innerHTML =
    '<span>Total: <span class="stat-val">' + total + '</span></span>' +
    '<span>Improvements: <span class="stat-val">' + improvements + '</span></span>' +
    '<span>Agent Features: <span class="stat-val">' + agentFeatures + '</span></span>' +
    '<span>Proposed: <span class="stat-val">' + proposed + '</span></span>' +
    '<span>In Progress: <span class="stat-val">' + inProg + '</span></span>' +
    '<span>Done: <span class="stat-val">' + done + '</span></span>';
}

function renderIdeas() {
  var filtered = getFiltered();
  renderStats();
  var el = document.getElementById('ideasList');
  if (!filtered.length) { el.innerHTML = '<div class="empty">No ideas match the current filters</div>'; return; }

  var statuses = ['proposed', 'in_progress', 'done', 'skipped'];
  el.innerHTML = '<div class="grid">' + filtered.map(function(idea) {
    var catClass = idea.category === 'improvement' ? 'badge-improvement' : 'badge-agent';
    var catLabel = idea.category === 'improvement' ? 'improvement' : 'agent feature';
    var prioClass = 'badge-' + idea.priority;
    var desc = esc(idea.description || '');
    var isLong = desc.length > 120;
    var truncClass = isLong ? 'truncated' : '';

    return '<div class="idea-card">' +
      '<div class="idea-top">' +
        '<div class="idea-title">' + esc(idea.title) + '</div>' +
        '<span class="badge ' + catClass + '">' + catLabel + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:4px;align-items:center;margin-bottom:4px">' +
        '<span class="badge ' + esc(prioClass) + '">' + esc(idea.priority) + '</span>' +
      '</div>' +
      (desc ? '<div class="idea-desc ' + truncClass + '" onclick="this.classList.toggle(\\'truncated\\');this.classList.toggle(\\'expanded\\')">' + desc + '</div>' : '') +
      '<div class="idea-actions">' +
        statuses.map(function(s) {
          return '<button class="' + (idea.status === s ? 'active-status' : '') + '" onclick="setStatus(' + idea.id + ',\\'' + s + '\\')">' + s.replace('_', ' ') + '</button>';
        }).join('') +
        '<button class="btn-promote" onclick="openPromoteModal(' + idea.id + ')">→ goal</button>' +
        '<button class="btn-delete" onclick="deleteIdea(' + idea.id + ')">delete</button>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

async function loadIdeas() {
  try {
    var d = await api('/ideas');
    ideas = d.ideas || [];
    renderIdeas();
  } catch(e) {
    document.getElementById('ideasList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  }
}

async function addNewIdea() {
  var title = document.getElementById('newTitle').value.trim();
  if (!title) return;
  var category = document.getElementById('newCategory').value;
  var priority = document.getElementById('newPriority').value;
  var description = document.getElementById('newDesc').value.trim();
  try {
    await api('/ideas', {
      method: 'POST',
      body: JSON.stringify({ title: title, category: category, priority: priority, description: description })
    });
    document.getElementById('newTitle').value = '';
    document.getElementById('newDesc').value = '';
    toast('Idea added', 'success');
    loadIdeas();
  } catch(e) { toast('Failed: ' + e.message, 'error'); }
}

async function setStatus(id, status) {
  if (status === 'in_progress') {
    openPromoteModal(id);
    return;
  }
  try {
    await api('/ideas/' + id, {
      method: 'PATCH',
      body: JSON.stringify({ status: status })
    });
    toast('Status updated', 'success');
    loadIdeas();
  } catch(e) { toast('Failed: ' + e.message, 'error'); }
}

var _promoteId = null;

function openPromoteModal(id) {
  var idea = ideas.find(function(i) { return i.id === id; });
  if (!idea) return;
  _promoteId = id;
  document.getElementById('promoteTitle').value = idea.title;
  document.getElementById('promoteDesc').value = idea.description || '';
  document.getElementById('promotePriority').value = idea.priority || 'medium';
  document.getElementById('promoteModal').style.display = 'flex';
  setTimeout(function() { document.getElementById('promoteTitle').focus(); }, 50);
}

function closePromoteModal() {
  _promoteId = null;
  document.getElementById('promoteModal').style.display = 'none';
}

async function confirmPromote() {
  if (!_promoteId) return;
  var title = document.getElementById('promoteTitle').value.trim();
  if (!title) { document.getElementById('promoteTitle').focus(); return; }
  var desc = document.getElementById('promoteDesc').value.trim();
  var priority = document.getElementById('promotePriority').value;
  try {
    var result = await api('/ideas/' + _promoteId + '/promote', {
      method: 'POST',
      body: JSON.stringify({ title: title, description: desc, priority: priority })
    });
    closePromoteModal();
    toast('Goal created: ' + result.goal.title, 'success');
    loadIdeas();
  } catch(e) { toast('Failed: ' + e.message, 'error'); }
}

async function deleteIdea(id) {
  if (!confirm('Delete this idea?')) return;
  try {
    await api('/ideas/' + id + '/delete', { method: 'POST' });
    toast('Idea deleted', 'success');
    loadIdeas();
  } catch(e) { toast('Failed: ' + e.message, 'error'); }
}

// Seed ideas on first load if empty, then render
async function init() {
  try {
    var d = await api('/ideas');
    ideas = d.ideas || [];
    if (ideas.length === 0) {
      var seedData = [
        { title: "Dynamic followup urgency", category: "improvement", priority: "high", description: "Followups should inherit urgency from parent goal instead of always being low. followup urgency = max(low, parentGoal.urgency - 1 tier). Eliminates need for 'unblock pending milestones' workaround." },
        { title: "Signal decay / aging", category: "improvement", priority: "medium", description: "Signals like stale_goal and blocked_goal have fixed thresholds, but urgency should escalate continuously. stale_goal: medium at 48h, high at 96h, critical at 120h+. blocked_goal at 14d+ could trigger user message: 'should we drop this goal?'" },
        { title: "Cost-aware model selection", category: "improvement", priority: "medium", description: "Instead of binary high/critical = Sonnet, else Haiku: if dailyCost < budget * 0.5, allow Sonnet for medium signals too. Let the agent be smarter when it's cheap to be smart." },
        { title: "Signal correlation", category: "improvement", priority: "medium", description: "Some signals together mean more than individually. stale_goal + conversation_gap = user disengaged (nudge). memory_pressure + error_spike = single incident. cost_spike + Sonnet calls = auto-downgrade." },
        { title: "Cooldown per signal type", category: "improvement", priority: "low", description: "If failing_cron fires every cycle for the same cron, wasting cycles. Add cooldown: after acting on a signal, suppress same type+source for N cycles (e.g. 30 min)." },
        { title: "User feedback loop on signals", category: "improvement", priority: "medium", description: "Track which signals lead to valued actions. If low_engagement_cron keeps firing but user dismisses, lower priority. If user acts on deadline_approaching, trigger earlier (72h vs 48h)." },
        { title: "Proactive trigger sub-types", category: "improvement", priority: "low", description: "Split vague proactive triggers into: 15a goal_momentum (3+ actions this week), 15b anomaly_detected (unusual pattern), 15c idle_opportunity (nothing urgent, do maintenance). More predictable and debuggable." },
        { title: "Re-cycle cap", category: "improvement", priority: "low", description: "The 2-min re-cycle on productive cycles is great, but add max consecutive re-cycles (3-4) to prevent runaway loops burning API calls." },
        { title: "Self-generated goals", category: "agent-feature", priority: "high", description: "Agent should create its own goals via pattern detection. E.g. noticing user asks about expenses every Sunday -> propose 'Prepare weekly expense summary'. Pattern detection -> hypothesis -> proposed goal -> user approval. That's agency." },
        { title: "Planning and decomposition", category: "agent-feature", priority: "high", description: "Complex goals should be autonomously broken into milestone dependency graphs with sequencing and cost estimation. Not just flat task lists." },
        { title: "Internal monologue / reasoning journal", category: "agent-feature", priority: "high", description: "Persistent REASONING_LOG.md (append-only). Agent forms hypotheses, tests them, records conclusions. E.g. 'the user didn't respond to summary in 3 days. Try shorter format. -> Got thumbs up. Hypothesis 2 correct.'" },
        { title: "Tool discovery and self-extension", category: "agent-feature", priority: "medium", description: "Agent recognizes missing capabilities and proposes its own upgrades. E.g. 'User wants weather messages, I lack weather API -> propose new MCP tool for OpenWeatherMap.'" },
        { title: "Multi-step autonomous execution", category: "agent-feature", priority: "high", description: "Persistent intent across cycles. Agent holds a plan (e.g. debug failing cron: query logs -> analyze -> fix -> verify) rather than starting fresh each cycle. Includes abandon conditions." },
        { title: "Confidence scoring and uncertainty", category: "agent-feature", priority: "medium", description: "Agent knows what it doesn't know. Before acting, score confidence. High confidence -> act autonomously. Low confidence -> ask. Prevents dumb actions while being proactive." },
        { title: "User model", category: "agent-feature", priority: "medium", description: "Explicit user model: response times by time of day, preferences (message length, humor), patterns (asks about goals Monday mornings, ignores Friday nights). Drives when/how the agent communicates." },
        { title: "Reflection cycles", category: "agent-feature", priority: "medium", description: "Daily reflection (what did I accomplish, what signals did I miss, what patterns am I noticing) + weekly reflection (goal progress, token efficiency, propose/retire goals). Agent improving itself on schedule." },
        { title: "Negotiation with user", category: "agent-feature", priority: "low", description: "Agent pushes back with opinions. E.g. 'exercise daily goal set 3 weeks ago, no logs. Suggestions: 1) lower to 3x/week, 2) morning nudge at 7am, 3) drop it.' Difference between tool and agent." },
        { title: "Sandboxed experimentation", category: "agent-feature", priority: "low", description: "Agent forms hypotheses about own effectiveness and tests them. A/B test over 2 weeks (e.g. emoji-rich vs plain messages), measure response rate, auto-revert if worse." }
      ];
      await api('/ideas/seed', { method: 'POST', body: JSON.stringify({ ideas: seedData }) });
      var d2 = await api('/ideas');
      ideas = d2.ideas || [];
    }
    renderIdeas();
  } catch(e) {
    document.getElementById('ideasList').innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
  }
}

init();
</script>
</body>
</html>`;
