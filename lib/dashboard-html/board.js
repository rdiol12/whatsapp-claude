// Auto-extracted from dashboard.js
export const BOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Goals Board</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>&#x25a6;</text></svg>">
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
  .page-header { display: flex; align-items: center; gap: 16px; padding: 18px 24px; border-bottom: 1px solid var(--border); background: var(--surface); position: sticky; top: 0; z-index: 100; }
  .page-header a { color: var(--accent); text-decoration: none; font-size: 13px; }
  .page-header h1 { font-family: var(--font-display); font-size: 18px; font-weight: 700; flex: 1; }
  .content { padding: 20px 24px; }
  .add-form { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
  .input { background: var(--surface2); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 6px; font-family: var(--font-mono); font-size: 12px; outline: none; }
  .input:focus { border-color: var(--accent); }
  .btn-primary { background: var(--accent); border: none; color: white; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-family: var(--font-mono); font-size: 12px; font-weight: 600; }
  .btn-primary:hover { background: var(--accent2); }
  .kanban { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  @media (max-width: 900px) { .kanban { grid-template-columns: 1fr; } }
  .kanban-col { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; min-height: 150px; }
  .kanban-col-header { display: flex; align-items: center; justify-content: space-between; padding: 4px 6px 10px; }
  .kanban-col-label { font-family: var(--font-display); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .kanban-col-count { font-size: 10px; color: var(--text3); background: var(--bg); padding: 2px 7px; border-radius: 4px; }
  .kanban-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; margin-bottom: 7px; cursor: pointer; transition: border-color 0.15s; }
  .kanban-card:hover { border-color: var(--border2); }
  .kanban-card-title { font-size: 12px; font-weight: 500; margin-bottom: 4px; }
  .kanban-card-meta { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; }
  .kanban-card-actions { display: flex; gap: 4px; flex-wrap: wrap; }
  .kanban-card-actions button { background: var(--surface2); border: 1px solid var(--border); color: var(--text3); padding: 3px 8px; border-radius: 4px; cursor: pointer; font-family: var(--font-mono); font-size: 10px; transition: all 0.15s; }
  .kanban-card-actions button:hover { border-color: var(--accent); color: var(--accent2); }
  .badge { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 9px; font-weight: 600; }
  .empty { text-align: center; padding: 24px; color: var(--text3); font-size: 12px; }
  .loading { text-align: center; padding: 24px; color: var(--text3); }
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  .toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 8px; }
  .toast { padding: 10px 16px; border-radius: 6px; font-size: 12px; animation: fadeUp 0.2s ease; }
  .toast.success { background: rgba(34,211,160,0.15); color: var(--green); border: 1px solid rgba(34,211,160,0.2); }
  .toast.error { background: rgba(244,63,94,0.15); color: var(--red); border: 1px solid rgba(244,63,94,0.2); }
  .toast.info { background: rgba(124,106,247,0.15); color: var(--accent2); border: 1px solid rgba(124,106,247,0.2); }
  .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 1000; align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; width: 480px; max-width: 92vw; max-height: 85vh; overflow-y: auto; padding: 20px; }
  .modal-title { font-family: var(--font-display); font-weight: 700; font-size: 15px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
  .modal-close { background: none; border: none; color: var(--text3); font-size: 18px; cursor: pointer; }
  .section-label { font-family: var(--font-display); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--text3); margin-bottom: 8px; margin-top: 6px; }
  .row { display: flex; align-items: center; gap: 4px; font-size: 12px; padding: 3px 0; }
  .progress-bar { height: 4px; background: var(--border); border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.3s; }
  .status-badge { font-size: 9px; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
  .s-active,.s-in_progress { background: rgba(34,211,238,0.12); color: var(--cyan); }
  .s-pending,.s-draft,.s-blocked { background: rgba(245,158,11,0.12); color: var(--yellow); }
  .s-completed { background: rgba(34,211,160,0.12); color: var(--green); }
  .s-abandoned { background: rgba(244,63,94,0.12); color: var(--red); }
  .goal-transitions { display: flex; gap: 6px; flex-wrap: wrap; }
  .goal-transitions button { padding: 5px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--surface2); color: var(--text2); cursor: pointer; font-family: var(--font-mono); font-size: 11px; transition: all 0.15s; }
  .goal-transitions button:hover { border-color: var(--accent); color: var(--accent2); }
  .t-completed { border-color: rgba(34,211,160,0.3) !important; color: var(--green) !important; }
  .t-abandoned { border-color: rgba(244,63,94,0.3) !important; color: var(--red) !important; }
</style>
</head>
<body>
<div class="page-header">
  <a href="/">&larr; Dashboard</a>
  <h1>Goals Board</h1>
</div>
<div class="content">
  <div class="add-form">
    <input class="input" id="taskTitleInput" type="text" placeholder="New goal..." style="flex:1;min-width:200px" onkeydown="if(event.key==='Enter')addTask()">
    <select class="input" id="taskAssignee" style="width:auto;padding:8px">
      <option value="ron">ron</option>
      <option value="jarvis">jarvis</option>
    </select>
    <select class="input" id="taskPriority" style="width:auto;padding:8px">
      <option value="medium">medium</option>
      <option value="high">high</option>
      <option value="low">low</option>
    </select>
    <button class="btn-primary" onclick="addTask()">Add Goal</button>
  </div>
  <div class="kanban" id="kanbanBoard">
    <div class="loading"><div class="spinner"></div></div>
  </div>
</div>

<div class="toast-container" id="toastContainer"></div>

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
  var API_BASE = '/api';
  async function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
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

  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }

  // --- Kanban ---
  var taskStore = [];

  async function loadTasks() {
    try {
      var d = await api('/goals?all=1');
      taskStore = (d.goals || []).map(function(g) {
        var st = 'pending';
        if (g.status === 'in_progress' || g.status === 'active') st = 'in_progress';
        else if (g.status === 'completed') st = 'done';
        else if (g.status === 'abandoned') st = 'cancelled';
        return { id: g.id, title: g.title, status: st, assignee: g.source || 'ron', priority: g.priority || 'medium', raw: g };
      });
      renderKanban();
    } catch(e) {
      document.getElementById('kanbanBoard').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  function renderKanban() {
    var cols = [
      { key: 'pending', label: 'Pending', color: 'var(--yellow)' },
      { key: 'in_progress', label: 'In Progress', color: 'var(--cyan)' },
      { key: 'done', label: 'Done', color: 'var(--green)' },
      { key: 'cancelled', label: 'Cancelled', color: 'var(--text3)' }
    ];
    var grouped = {};
    cols.forEach(function(c) { grouped[c.key] = []; });
    taskStore.forEach(function(t) { if (grouped[t.status]) grouped[t.status].push(t); });

    document.getElementById('kanbanBoard').innerHTML = cols.map(function(col) {
      var items = grouped[col.key];
      var priColors = { high: 'var(--red)', medium: 'var(--yellow)', low: 'var(--green)' };
      return '<div class="kanban-col">' +
        '<div class="kanban-col-header">' +
          '<span class="kanban-col-label" style="color:' + col.color + '">' + col.label + '</span>' +
          '<span class="kanban-col-count">' + items.length + '</span>' +
        '</div>' +
        (items.length === 0 ? '<div class="empty">No goals</div>' : '') +
        items.map(function(t) {
          var g = t.raw;
          var transitions = ['pending','in_progress','done','cancelled'].filter(function(s) { return s !== t.status; });
          var btnLabels = { pending: 'Reopen', in_progress: 'Start', done: 'Done', cancelled: 'Cancel' };
          var desc = g.description ? '<div style="font-size:10px;color:var(--text3);margin-bottom:4px;line-height:1.4">' + esc(g.description).slice(0, 100) + (g.description.length > 100 ? '...' : '') + '</div>' : '';
          var ms = g.milestones || [];
          var msDone = ms.filter(function(m) { return m.status === 'completed'; }).length;
          var msBar = ms.length > 0 ? '<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px"><div style="flex:1;height:3px;border-radius:2px;background:var(--border);overflow:hidden"><div style="height:100%;border-radius:2px;background:var(--green);width:' + Math.round(msDone/ms.length*100) + '%"></div></div><span style="font-size:9px;color:var(--text3)">' + msDone + '/' + ms.length + '</span></div>' : '';
          return '<div class="kanban-card" onclick="showGoal(\\'' + esc(t.id) + '\\')">' +
            '<div class="kanban-card-title">' + esc(t.title) + '</div>' +
            desc +
            msBar +
            '<div class="kanban-card-meta">' +
              '<span class="badge" style="background:rgba(124,106,247,0.12);color:var(--accent2)">' + esc(t.assignee) + '</span>' +
              '<span class="badge" style="color:' + (priColors[t.priority] || 'var(--text3)') + '">' + t.priority + '</span>' +
            '</div>' +
            '<div class="kanban-card-actions">' +
              transitions.map(function(s) {
                return '<button onclick="event.stopPropagation();moveTask(\\'' + esc(t.id) + '\\',\\'' + s + '\\')">' + btnLabels[s] + '</button>';
              }).join('') +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    }).join('');
  }

  async function moveTask(goalId, newStatus) {
    var goalMap = { pending: 'pending', in_progress: 'in_progress', done: 'completed', cancelled: 'abandoned' };
    try {
      await api('/goals/' + encodeURIComponent(goalId) + '/update', {
        method: 'POST', body: JSON.stringify({ status: goalMap[newStatus] })
      });
      toast('Goal moved to ' + newStatus, 'success');
      loadTasks();
    } catch(e) { toast('Move failed: ' + e.message, 'error'); }
  }

  async function addTask() {
    var title = document.getElementById('taskTitleInput').value.trim();
    if (!title) return;
    var assignee = document.getElementById('taskAssignee').value;
    var priority = document.getElementById('taskPriority').value;
    try {
      await api('/goals', {
        method: 'POST', body: JSON.stringify({ title: title, priority: priority, source: assignee })
      });
      document.getElementById('taskTitleInput').value = '';
      toast('Goal added', 'success');
      loadTasks();
    } catch(e) { toast('Add failed: ' + e.message, 'error'); }
  }

  // --- Goal detail modal ---
  async function showGoal(id) {
    openModal('goalModal');
    document.getElementById('goalModalContent').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      var d = await api('/goals/' + id);
      var g = d.goal || d;
      document.getElementById('goalModalTitle').textContent = g.title;
      var html = '<div style="margin-bottom:11px;">' +
        '<div class="progress-bar" style="height:5px;margin-bottom:6px;"><div class="progress-fill" style="width:' + (g.progress||0) + '%"></div></div>' +
        '<div style="color:var(--text3);font-size:10px;display:flex;align-items:center;gap:8px;">' +
          '<span class="status-badge s-' + (g.status||'active') + '">' + (g.status||'active').replace('_',' ') + '</span>' +
          (g.progress||0) + '% \\u00b7 ' + (g.category||'general') + ' \\u00b7 ' + (g.priority||'medium') +
        '</div>' +
      '</div>';
      if (g.description) html += '<div style="color:var(--text2);font-size:12px;margin-bottom:14px;line-height:1.6">' + esc(g.description) + '</div>';
      if (g.milestones && g.milestones.length) {
        html += '<div class="section-label">Milestones</div>';
        g.milestones.forEach(function(m) {
          var metaLine = '';
          if (m.status === 'completed') {
            var parts = [];
            if (m.completedBy) parts.push(m.completedBy);
            if (m.completedAt) parts.push(new Date(m.completedAt).toLocaleString('en-IL', {timeZone:(window.__SELA_TZ||'UTC'), month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false}));
            if (parts.length) metaLine = '<div style="font-size:10px;color:var(--text3);margin:1px 0 4px 24px;opacity:0.7">' + esc(parts.join(' \\u00b7 ')) + '</div>';
          }
          html += '<div class="row">' +
            '<span style="color:' + (m.status==='completed'?'var(--green)':'var(--text3)') + '">' + (m.status==='completed'?'\\u2713':'\\u25cb') + '</span>' +
            '<span style="flex:1;margin-left:8px;' + (m.status==='completed'?'text-decoration:line-through;color:var(--text3)':'') + '">' + esc(m.title) + '</span>' +
          '</div>' + metaLine;
        });
      }
      if (g.retrospective) {
        html += '<div class="section-label" style="margin-top:14px">Retrospective</div>' +
          '<div style="color:var(--text2);font-size:12px;line-height:1.7;padding:9px;background:var(--surface2);border-radius:6px;border:1px solid var(--border)">' + esc(g.retrospective) + '</div>';
      }
      var goalTransitions = {
        draft: ['pending', 'active', 'abandoned'],
        pending: ['active', 'abandoned'],
        active: ['in_progress', 'pending', 'blocked', 'abandoned'],
        in_progress: ['pending', 'blocked', 'completed', 'abandoned'],
        blocked: ['in_progress', 'pending', 'abandoned'],
        completed: [], abandoned: []
      };
      var prios = ['low','medium','high','critical'];
      html += '<div class="section-label" style="margin-top:14px">Priority</div><div style="display:flex;gap:6px;flex-wrap:wrap">';
      prios.forEach(function(p) {
        var colors = {low:'var(--text3)',medium:'var(--cyan)',high:'var(--yellow)',critical:'var(--red)'};
        var active = (g.priority||'medium') === p;
        html += '<button style="padding:4px 12px;border-radius:4px;border:1px solid ' + (active ? colors[p] : 'var(--border)') + ';background:' + (active ? colors[p]+'22' : 'var(--surface2)') + ';color:' + (active ? colors[p] : 'var(--text3)') + ';cursor:pointer;font-size:11px;font-weight:' + (active?'600':'400') + '" onclick="changeGoalPriority(\\'' + g.id + '\\',\\'' + p + '\\')">' + p + '</button>';
      });
      html += '</div>';
      var btnLabels = { pending: 'Under Review', active: 'Activate', in_progress: 'Start Work', blocked: 'Block', completed: 'Complete', abandoned: 'Abandon' };
      var allowed = goalTransitions[g.status] || [];
      if (allowed.length) {
        html += '<div class="section-label" style="margin-top:14px">Change Status</div><div class="goal-transitions">';
        allowed.forEach(function(s) {
          html += '<button class="t-' + s + '" onclick="changeGoalStatus(\\'' + g.id + '\\', \\'' + s + '\\')">' + (btnLabels[s] || s) + '</button>';
        });
        html += '</div>';
      }
      document.getElementById('goalModalContent').innerHTML = html;
    } catch(e) {
      document.getElementById('goalModalContent').innerHTML = '<div class="empty">' + e.message + '</div>';
    }
  }

  async function changeGoalStatus(id, newStatus) {
    try {
      await api('/goals/' + id + '/update', { method: 'POST', body: JSON.stringify({ status: newStatus }) });
      toast('Status changed to ' + newStatus.replace('_',' '), 'success');
      showGoal(id); loadTasks();
    } catch(e) { toast('Failed: ' + e.message, 'error'); }
  }

  async function changeGoalPriority(id, newPriority) {
    try {
      await api('/goals/' + id + '/update', { method: 'POST', body: JSON.stringify({ priority: newPriority }) });
      toast('Priority set to ' + newPriority, 'success');
      showGoal(id); loadTasks();
    } catch(e) { toast('Failed: ' + e.message, 'error'); }
  }

  loadTasks();
</script>
</body>
</html>`;
