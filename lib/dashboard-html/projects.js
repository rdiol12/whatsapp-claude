// Projects dashboard page — collapsible project cards with goals, milestones, progress
export const PROJECTS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Projects</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>&#128193;</text></svg>">
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
  .header-actions { margin-left: auto; }
  .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 14px; }
  .card-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; cursor: pointer; flex-wrap: wrap; gap: 8px; }
  .card-header:hover { background: var(--surface2); }
  .card-title { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .card-body { padding: 14px; border-top: 1px solid var(--border); }
  .empty { color: var(--text3); font-size: 12px; padding: 20px; text-align: center; }
  .toast-container { position: fixed; top: 16px; right: 16px; z-index: 10000; display: flex; flex-direction: column; gap: 8px; }
  .toast { padding: 8px 14px; border-radius: 6px; background: var(--surface); border: 1px solid var(--border); font-size: 11px; animation: fadeUp 0.2s ease; }
  .toast.success { border-color: var(--green); color: var(--green); }
  .toast.error { border-color: var(--red); color: var(--red); }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Status badges */
  .status-badge { display: inline-block; font-size: 9px; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
  .s-active { background: rgba(34,211,160,0.12); color: var(--green); }
  .s-in_progress { background: rgba(124,106,247,0.12); color: var(--accent); }
  .s-completed { background: rgba(34,211,160,0.2); color: var(--green); }
  .s-pending { background: rgba(136,136,170,0.12); color: var(--text2); }
  .s-blocked { background: rgba(244,63,94,0.12); color: var(--red); }
  .s-proposed { background: rgba(245,158,11,0.12); color: var(--yellow); }
  .s-abandoned { background: rgba(68,68,102,0.15); color: var(--text3); }
  .s-draft { background: rgba(34,211,238,0.12); color: var(--cyan); }

  /* Progress bar */
  .progress-bar { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--green)); border-radius: 2px; transition: width 0.3s; }

  /* Toggle icon */
  .toggle-icon { font-size: 10px; color: var(--text3); transition: transform 0.2s; display: inline-block; width: 14px; }
  .toggle-icon.open { transform: rotate(90deg); }

  /* New project form */
  .new-project-form { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 20px; overflow: hidden; }
  .form-toggle { display: flex; align-items: center; gap: 8px; padding: 10px 14px; cursor: pointer; font-size: 12px; color: var(--accent); }
  .form-toggle:hover { background: var(--surface2); }
  .form-body { padding: 14px; border-top: 1px solid var(--border); display: none; }
  .form-body.open { display: block; }
  .form-row { margin-bottom: 10px; }
  .form-row label { display: block; font-size: 10px; color: var(--text3); margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.5px; }
  .form-row textarea, .form-row input, .form-row select {
    width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); font-family: var(--font-mono); font-size: 12px; padding: 8px 10px; outline: none;
  }
  .form-row textarea:focus, .form-row input:focus, .form-row select:focus { border-color: var(--accent); }
  .form-row textarea { min-height: 100px; resize: vertical; }
  .form-row select { max-width: 200px; }
  .btn-create { background: var(--accent); border: none; border-radius: 4px; color: white; padding: 8px 20px; cursor: pointer; font-family: var(--font-mono); font-size: 12px; font-weight: 600; }
  .btn-create:hover { background: var(--accent2); }
  .btn-create:disabled { opacity: 0.5; cursor: not-allowed; }
  .tab-btn { background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--text3); padding: 8px 16px; cursor: pointer; font-family: var(--font-mono); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .tab-btn:hover { color: var(--text2); }
  .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
  .add-goal-row { display: flex; gap: 6px; margin-top: 10px; }
  .add-goal-row input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-family: var(--font-mono); font-size: 11px; padding: 5px 8px; outline: none; }
  .add-goal-row input:focus { border-color: var(--accent); }
  .add-goal-row button { background: var(--accent); border: none; border-radius: 4px; color: white; padding: 5px 12px; cursor: pointer; font-family: var(--font-mono); font-size: 10px; font-weight: 600; white-space: nowrap; }
  .add-goal-row button:hover { background: var(--accent2); }
  .btn-board { display: inline-block; background: var(--accent); color: white; font-family: var(--font-mono); font-size: 10px; font-weight: 600; padding: 3px 10px; border-radius: 4px; text-decoration: none; white-space: nowrap; }
  .btn-board:hover { background: var(--accent2); color: white; }

  /* Project card details */
  .project-meta { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--text2); }
  .project-brief { font-size: 12px; color: var(--text2); margin-bottom: 14px; line-height: 1.5; }
  .child-goal { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
  .child-goal-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .child-goal-title { font-size: 12px; font-weight: 500; flex: 1; }
  .child-goal-meta { display: flex; align-items: center; gap: 6px; }
  .milestone-list { margin-top: 8px; }
  .milestone-item { font-size: 10px; padding: 2px 0; display: flex; align-items: center; gap: 6px; }
  .milestone-item.done { color: var(--green); }
  .milestone-item.pending { color: var(--text3); }
  .milestone-icon { width: 12px; text-align: center; }
  .section-label { font-size: 10px; color: var(--text3); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; font-weight: 600; }

  /* Folder browser modal */
  .fb-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 5000; display: flex; align-items: center; justify-content: center; }
  .fb-modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 10px; width: 520px; max-width: 94vw; max-height: 70vh; display: flex; flex-direction: column; overflow: hidden; }
  .fb-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .fb-header-title { font-family: var(--font-display); font-size: 15px; font-weight: 700; }
  .fb-close { background: none; border: none; color: var(--text3); cursor: pointer; font-size: 18px; padding: 2px 6px; }
  .fb-close:hover { color: var(--text); }
  .fb-path-bar { display: flex; align-items: center; gap: 4px; padding: 8px 16px; border-bottom: 1px solid var(--border); font-size: 11px; background: var(--bg); overflow-x: auto; white-space: nowrap; }
  .fb-path-seg { color: var(--accent); cursor: pointer; padding: 2px 4px; border-radius: 3px; }
  .fb-path-seg:hover { background: var(--surface2); color: var(--accent2); }
  .fb-path-sep { color: var(--text3); }
  .fb-list { flex: 1; overflow-y: auto; padding: 4px 0; }
  .fb-item { display: flex; align-items: center; gap: 8px; padding: 7px 16px; cursor: pointer; font-size: 12px; color: var(--text); }
  .fb-item:hover { background: var(--surface2); }
  .fb-item-icon { font-size: 14px; width: 18px; text-align: center; flex-shrink: 0; }
  .fb-item-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .fb-item.up { color: var(--text2); font-style: italic; }
  .fb-footer { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--border); }
  .fb-footer input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-family: var(--font-mono); font-size: 11px; padding: 6px 10px; outline: none; }
  .fb-footer input:focus { border-color: var(--accent); }
  .fb-footer button { background: var(--accent); border: none; border-radius: 4px; color: white; padding: 6px 16px; cursor: pointer; font-family: var(--font-mono); font-size: 11px; font-weight: 600; white-space: nowrap; }
  .fb-footer button:hover { background: var(--accent2); }
  .fb-empty { color: var(--text3); font-size: 11px; padding: 20px; text-align: center; }
  .fb-loading { color: var(--text3); font-size: 11px; padding: 20px; text-align: center; }

  /* Mini kanban board inside project cards */
  .mini-kanban { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
  .mk-col { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; min-height: 60px; }
  .mk-col-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
  .mk-col-label { font-family: var(--font-display); font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .mk-col-count { font-size: 9px; color: var(--text3); background: var(--surface2); padding: 1px 5px; border-radius: 3px; }
  .mk-card { background: var(--surface); border: 1px solid var(--border); border-radius: 5px; padding: 7px 9px; margin-bottom: 5px; cursor: pointer; transition: border-color 0.15s; }
  .mk-card:hover { border-color: var(--accent); }
  .mk-card-title { font-size: 11px; font-weight: 500; margin-bottom: 3px; }
  .mk-card-meta { display: flex; align-items: center; gap: 4px; }
  .mk-card-pri { font-size: 8px; padding: 1px 4px; border-radius: 2px; }
  .mk-card-ms { font-size: 9px; color: var(--text3); }
  .mk-empty { font-size: 9px; color: var(--text3); text-align: center; padding: 8px 0; }

  /* Goal detail modal */
  .gm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 5000; display: flex; align-items: center; justify-content: center; }
  .gm-modal { background: var(--surface); border: 1px solid var(--border2); border-radius: 10px; width: 500px; max-width: 94vw; max-height: 80vh; overflow-y: auto; padding: 18px; }
  .gm-title { font-family: var(--font-display); font-size: 15px; font-weight: 700; display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .gm-close { background: none; border: none; color: var(--text3); font-size: 18px; cursor: pointer; padding: 2px 6px; }
  .gm-close:hover { color: var(--text); }
  .gm-desc { color: var(--text2); font-size: 12px; line-height: 1.6; margin-bottom: 12px; }
  .gm-transitions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .gm-transitions button { padding: 4px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--surface2); color: var(--text2); cursor: pointer; font-family: var(--font-mono); font-size: 10px; transition: all 0.15s; }
  .gm-transitions button:hover { border-color: var(--accent); color: var(--accent2); }
  .gm-ms-item { font-size: 11px; padding: 4px 0; display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .gm-ms-item:hover { color: var(--accent2); }
  .gm-ms-item.done { color: var(--green); }
  .gm-ms-item.pending { color: var(--text3); }
  .gm-ms-icon { width: 14px; text-align: center; font-size: 12px; }

  @media (max-width: 900px) {
    .mini-kanban { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 600px) {
    .container { padding: 12px; }
    .card-header { padding: 10px 12px; }
    .project-meta { flex-wrap: wrap; }
    .fb-modal { width: 100%; max-width: 100vw; max-height: 80vh; border-radius: 0; }
    .mini-kanban { grid-template-columns: 1fr; }
    .gm-modal { width: 100%; max-width: 100vw; border-radius: 0; }
  }
</style>
</head>
<body>
<div class="toast-container" id="toastContainer"></div>

<div class="header">
  <a href="/">&larr; Dashboard</a>
  <div>
    <div class="header-title">&#128193; Projects</div>
    <div class="header-sub">onboard &amp; track projects</div>
  </div>
</div>

<div class="container">
  <!-- New Project Form -->
  <div class="new-project-form">
    <div class="form-toggle" onclick="toggleForm()">
      <span class="toggle-icon" id="formToggle">&#x25b6;</span>
      <span>+ Add Project</span>
    </div>
    <div class="form-body" id="formBody">
      <div style="display:flex;gap:0;margin-bottom:14px;border-bottom:1px solid var(--border)">
        <button class="tab-btn active" id="tabBrief" onclick="switchTab('brief')">From Brief</button>
        <button class="tab-btn" id="tabImport" onclick="switchTab('import')">Import Folder</button>
      </div>
      <div id="panelBrief">
        <div class="form-row">
          <label>Project Brief *</label>
          <textarea id="projectBrief" placeholder="Describe the project... The agent will decompose this into goals and milestones."></textarea>
        </div>
        <div class="form-row">
          <label>Title (optional — auto-generated)</label>
          <input type="text" id="projectTitle" placeholder="Custom project title...">
        </div>
        <div class="form-row">
          <label>Priority</label>
          <select id="projectPriority">
            <option value="high" selected>High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <button class="btn-create" id="createBtn" onclick="submitProject()">Create Project</button>
      </div>
      <div id="panelImport" style="display:none">
        <div class="form-row">
          <label>Folder Path *</label>
          <div style="display:flex;gap:6px">
            <input type="text" id="importPath" placeholder="Click Browse to pick a folder..." style="flex:1" readonly>
            <button type="button" class="btn-create" style="padding:6px 14px;font-size:11px" onclick="openFolderBrowser()">Browse...</button>
          </div>
        </div>
        <div class="form-row">
          <label>Title (optional — auto-detected from folder name)</label>
          <input type="text" id="importTitle" placeholder="Custom project title...">
        </div>
        <div class="form-row">
          <label>Description (optional — auto-detected from README/package.json)</label>
          <input type="text" id="importDesc" placeholder="Project description...">
        </div>
        <div class="form-row">
          <label>Priority</label>
          <select id="importPriority">
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
            <option value="low">Low</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <button class="btn-create" id="importBtn" onclick="submitImport()">Import Project</button>
        <div id="scanPreview" style="margin-top:12px"></div>
      </div>
    </div>
  </div>

  <!-- Projects List -->
  <div id="projectsList">
    <div class="empty">Loading projects...</div>
  </div>
</div>

<!-- Folder Browser Modal -->
<div class="fb-overlay" id="fbOverlay" style="display:none" onclick="if(event.target===this)closeFolderBrowser()">
  <div class="fb-modal">
    <div class="fb-header">
      <span class="fb-header-title">Select Folder</span>
      <button class="fb-close" onclick="closeFolderBrowser()">&times;</button>
    </div>
    <div class="fb-path-bar" id="fbPathBar"></div>
    <div class="fb-list" id="fbList">
      <div class="fb-loading">Loading...</div>
    </div>
    <div class="fb-footer">
      <input type="text" id="fbCurrentPath" placeholder="Path..." readonly>
      <button onclick="selectFolder()">Select</button>
    </div>
  </div>
</div>

<!-- Goal Detail Modal -->
<div class="gm-overlay" id="gmOverlay" style="display:none" onclick="if(event.target===this)closeGoalModal()">
  <div class="gm-modal">
    <div class="gm-title">
      <span id="gmTitle">Goal</span>
      <button class="gm-close" onclick="closeGoalModal()">&times;</button>
    </div>
    <div id="gmContent"></div>
  </div>
</div>

<script>
var API_BASE = '/api';

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function api(path, opts) {
  var r = await fetch(API_BASE + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  var data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showToast(msg, type) {
  var el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(function() { el.remove(); }, 4000);
}

// ── Form ──────────────────────────────────────────────────────────────────

function toggleForm() {
  var body = document.getElementById('formBody');
  var icon = document.getElementById('formToggle');
  if (body.classList.contains('open')) {
    body.classList.remove('open');
    icon.classList.remove('open');
  } else {
    body.classList.add('open');
    icon.classList.add('open');
  }
}

async function submitProject() {
  var brief = document.getElementById('projectBrief').value.trim();
  if (!brief) { showToast('Brief is required', 'error'); return; }
  var title = document.getElementById('projectTitle').value.trim() || undefined;
  var priority = document.getElementById('projectPriority').value;
  var btn = document.getElementById('createBtn');
  btn.disabled = true;
  btn.textContent = 'Decomposing...';
  try {
    var res = await api('/projects', { method: 'POST', body: JSON.stringify({ brief: brief, title: title, priority: priority }) });
    showToast('Project created: ' + (res.title || res.slug) + ' (' + res.goals + ' goals)', 'success');
    document.getElementById('projectBrief').value = '';
    document.getElementById('projectTitle').value = '';
    toggleForm();
    loadProjects();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Project';
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.getElementById('panelBrief').style.display = tab === 'brief' ? 'block' : 'none';
  document.getElementById('panelImport').style.display = tab === 'import' ? 'block' : 'none';
  document.getElementById('tabBrief').className = 'tab-btn' + (tab === 'brief' ? ' active' : '');
  document.getElementById('tabImport').className = 'tab-btn' + (tab === 'import' ? ' active' : '');
}

// ── Import ────────────────────────────────────────────────────────────────

async function submitImport() {
  var path = document.getElementById('importPath').value.trim();
  if (!path) { showToast('Folder path is required', 'error'); return; }
  var title = document.getElementById('importTitle').value.trim() || undefined;
  var desc = document.getElementById('importDesc').value.trim() || undefined;
  var priority = document.getElementById('importPriority').value;
  var btn = document.getElementById('importBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning...';
  try {
    var res = await api('/projects/import', { method: 'POST', body: JSON.stringify({ path: path, title: title, description: desc, priority: priority }) });
    showToast('Imported: ' + (res.title || res.slug) + ' (' + res.files + ' files, ' + res.dirs + ' dirs)', 'success');
    document.getElementById('importPath').value = '';
    document.getElementById('importTitle').value = '';
    document.getElementById('importDesc').value = '';
    toggleForm();
    loadProjects();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import Project';
  }
}

// ── Folder Browser ────────────────────────────────────────────────────────

var fbCurrentDir = '';

function openFolderBrowser() {
  document.getElementById('fbOverlay').style.display = 'flex';
  // Start from whatever is in the path input, or home directory
  var startPath = document.getElementById('importPath').value.trim() || '';
  browseDir(startPath || '');
}

function closeFolderBrowser() {
  document.getElementById('fbOverlay').style.display = 'none';
}

function selectFolder() {
  if (fbCurrentDir) {
    document.getElementById('importPath').value = fbCurrentDir;
  }
  closeFolderBrowser();
}

async function browseDir(dirPath) {
  var listEl = document.getElementById('fbList');
  listEl.innerHTML = '<div class="fb-loading">Loading...</div>';
  try {
    var qp = dirPath ? '?path=' + encodeURIComponent(dirPath) : '';
    var data = await api('/projects/browse' + qp);
    fbCurrentDir = data.current || dirPath;
    document.getElementById('fbCurrentPath').value = fbCurrentDir;
    renderPathBar(fbCurrentDir);
    renderDirList(data);
  } catch (err) {
    listEl.innerHTML = '<div class="fb-empty">Error: ' + esc(err.message) + '</div>';
  }
}

function renderPathBar(fullPath) {
  var bar = document.getElementById('fbPathBar');
  // Split path into segments — handle both / and \\
  var normalized = fullPath.replace(/\\\\/g, '/');
  var parts = normalized.split('/').filter(Boolean);
  var html = '';
  // Add root
  var isWindows = /^[A-Z]:$/i.test(parts[0] || '');
  if (isWindows) {
    // e.g. C: / Users / rdiol
    for (var i = 0; i < parts.length; i++) {
      var partPath = parts.slice(0, i + 1).join('/');
      if (i === 0) partPath = parts[0] + '/';
      if (i > 0) html += '<span class="fb-path-sep">/</span>';
      html += '<span class="fb-path-seg" onclick="browseDir(\\'' + esc(partPath.replace(/'/g, "\\\\'")) + '\\')">' + esc(parts[i]) + '</span>';
    }
  } else {
    html += '<span class="fb-path-seg" onclick="browseDir(\\'/'+'\\')"> / </span>';
    for (var i = 0; i < parts.length; i++) {
      var partPath = '/' + parts.slice(0, i + 1).join('/');
      html += '<span class="fb-path-sep">/</span>';
      html += '<span class="fb-path-seg" onclick="browseDir(\\'' + esc(partPath.replace(/'/g, "\\\\'")) + '\\')">' + esc(parts[i]) + '</span>';
    }
  }
  bar.innerHTML = html;
}

function renderDirList(data) {
  var listEl = document.getElementById('fbList');
  var html = '';
  // Go up
  if (data.parent) {
    html += '<div class="fb-item up" onclick="browseDir(\\'' + esc(data.parent.replace(/'/g, "\\\\'")) + '\\')">' +
      '<span class="fb-item-icon">&#x2191;</span>' +
      '<span class="fb-item-name">..</span>' +
    '</div>';
  }
  var dirs = data.dirs || [];
  if (!dirs.length && !data.parent) {
    html += '<div class="fb-empty">No sub-directories</div>';
  }
  for (var i = 0; i < dirs.length; i++) {
    var childPath = (data.current || '').replace(/\\\\/g, '/').replace(/\\/$/, '') + '/' + dirs[i];
    html += '<div class="fb-item" onclick="browseDir(\\'' + esc(childPath.replace(/'/g, "\\\\'")) + '\\')">' +
      '<span class="fb-item-icon">&#128193;</span>' +
      '<span class="fb-item-name">' + esc(dirs[i]) + '</span>' +
    '</div>';
  }
  listEl.innerHTML = html;
}

// ── Add Goal ──────────────────────────────────────────────────────────────

async function addGoalToProject(projectId) {
  var input = document.getElementById('addGoalTitle-' + projectId);
  if (!input) return;
  var title = input.value.trim();
  if (!title) { showToast('Goal title is required', 'error'); return; }
  try {
    await api('/projects/' + projectId + '/goals', { method: 'POST', body: JSON.stringify({ title: title }) });
    showToast('Goal added: ' + title, 'success');
    input.value = '';
    loadProjects();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ── Goal Detail Modal ─────────────────────────────────────────────────────

function closeGoalModal() {
  document.getElementById('gmOverlay').style.display = 'none';
}

async function showGoalDetail(goalId) {
  document.getElementById('gmOverlay').style.display = 'flex';
  document.getElementById('gmTitle').textContent = 'Loading...';
  document.getElementById('gmContent').innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3)">Loading...</div>';
  try {
    var d = await api('/goals/' + encodeURIComponent(goalId));
    var g = d.goal || d;
    document.getElementById('gmTitle').textContent = g.title;
    var html = '';

    // Progress bar + status
    html += '<div style="margin-bottom:12px">' +
      '<div class="progress-bar" style="height:5px;margin-bottom:6px"><div class="progress-fill" style="width:' + (g.progress||0) + '%"></div></div>' +
      '<div style="color:var(--text3);font-size:10px;display:flex;align-items:center;gap:8px">' +
        '<span class="status-badge s-' + esc(g.status||'pending') + '">' + esc((g.status||'pending').replace('_',' ')) + '</span>' +
        (g.progress||0) + '% \\u00b7 ' + esc(g.priority||'medium') +
      '</div>' +
    '</div>';

    // Description
    if (g.description) {
      html += '<div class="gm-desc">' + esc(g.description) + '</div>';
    }

    // Milestones — clickable to complete
    var ms = g.milestones || [];
    if (ms.length) {
      html += '<div class="section-label">Milestones</div>';
      ms.forEach(function(m) {
        var done = m.status === 'completed' || m.status === 'done';
        html += '<div class="gm-ms-item ' + (done ? 'done' : 'pending') + '"' +
          (done ? '' : ' onclick="completeMilestone(\\'' + esc(goalId) + '\\', \\'' + esc((m.id || m.title).replace(/'/g, "\\\\'")) + '\\')" title="Click to complete"') + '>' +
          '<span class="gm-ms-icon">' + (done ? '&#10003;' : '&#9675;') + '</span>' +
          '<span style="flex:1;' + (done ? 'text-decoration:line-through;opacity:0.6' : '') + '">' + esc(m.title) + '</span>' +
        '</div>';
      });
    }

    // Status transitions
    var transitions = {
      draft: ['pending', 'active', 'abandoned'],
      pending: ['active', 'in_progress', 'abandoned'],
      proposed: ['active', 'pending', 'abandoned'],
      active: ['in_progress', 'pending', 'blocked', 'completed', 'abandoned'],
      in_progress: ['pending', 'blocked', 'completed', 'abandoned'],
      blocked: ['in_progress', 'pending', 'abandoned'],
      completed: [], abandoned: []
    };
    var labels = { pending: 'Pending', active: 'Activate', in_progress: 'Start Work', blocked: 'Block', completed: 'Complete', abandoned: 'Abandon' };
    var allowed = transitions[g.status] || [];
    if (allowed.length) {
      html += '<div class="section-label" style="margin-top:14px">Change Status</div>';
      html += '<div class="gm-transitions">';
      allowed.forEach(function(s) {
        var cls = '';
        if (s === 'completed') cls = ' style="border-color:rgba(34,211,160,0.4);color:var(--green)"';
        if (s === 'abandoned') cls = ' style="border-color:rgba(244,63,94,0.3);color:var(--red)"';
        html += '<button' + cls + ' onclick="changeGoalStatus(\\'' + esc(goalId) + '\\', \\'' + s + '\\')">' + (labels[s] || s) + '</button>';
      });
      html += '</div>';
    }

    document.getElementById('gmContent').innerHTML = html;
  } catch (err) {
    document.getElementById('gmContent').innerHTML = '<div style="text-align:center;padding:20px;color:var(--red)">' + esc(err.message) + '</div>';
  }
}

async function changeGoalStatus(goalId, newStatus) {
  try {
    await api('/goals/' + encodeURIComponent(goalId) + '/update', {
      method: 'POST', body: JSON.stringify({ status: newStatus })
    });
    showToast('Status changed to ' + newStatus.replace('_', ' '), 'success');
    showGoalDetail(goalId);
    loadProjects();
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

async function completeMilestone(goalId, milestoneIdOrTitle) {
  try {
    await api('/goals/' + encodeURIComponent(goalId) + '/milestone-complete', {
      method: 'POST', body: JSON.stringify({ milestone: milestoneIdOrTitle })
    });
    showToast('Milestone completed', 'success');
    showGoalDetail(goalId);
    loadProjects();
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
}

// ── Projects ──────────────────────────────────────────────────────────────

async function loadProjects() {
  try {
    var data = await api('/projects');
    renderProjects(data.projects || []);
  } catch (err) {
    document.getElementById('projectsList').innerHTML = '<div class="empty">Failed to load: ' + esc(err.message) + '</div>';
  }
}

function renderProjects(projects) {
  var el = document.getElementById('projectsList');
  if (!projects.length) {
    el.innerHTML = '<div class="empty">No projects yet. Create one above!</div>';
    return;
  }

  // Sort: active/in_progress first, then by updatedAt desc
  projects.sort(function(a, b) {
    var sa = (a.status === 'active' || a.status === 'in_progress') ? 0 : 1;
    var sb = (b.status === 'active' || b.status === 'in_progress') ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  el.innerHTML = projects.map(function(p) {
    var childCount = (p.childGoals || []).length;
    return '<div class="card" data-id="' + esc(p.id) + '">' +
      '<div class="card-header" onclick="toggleProject(\\'' + esc(p.id) + '\\')">' +
        '<div class="card-title">' +
          '<span class="toggle-icon" id="ti-' + esc(p.id) + '">&#x25b6;</span> ' +
          esc(p.title) + ' ' +
          '<span class="status-badge s-' + esc(p.status) + '">' + esc(p.status) + '</span>' +
        '</div>' +
        '<div class="project-meta">' +
          '<span>' + (p.progress || 0) + '%</span>' +
          '<div class="progress-bar" style="width:80px"><div class="progress-fill" style="width:' + (p.progress || 0) + '%"></div></div>' +
          '<span>' + childCount + ' goal' + (childCount !== 1 ? 's' : '') + '</span>' +
          '<span>' + (p.fileCount || 0) + ' file' + ((p.fileCount || 0) !== 1 ? 's' : '') + '</span>' +
          '<a href="/projects/' + encodeURIComponent(p.id) + '/board" class="btn-board" onclick="event.stopPropagation()">Goals Board</a>' +
        '</div>' +
      '</div>' +
      '<div class="card-body" id="body-' + esc(p.id) + '" style="display:none">' +
        renderProjectBody(p) +
      '</div>' +
    '</div>';
  }).join('');
}

function renderProjectBody(p) {
  var html = '';

  // Brief / description
  if (p.brief || p.description) {
    html += '<div class="project-brief">' + esc(p.brief || p.description) + '</div>';
  }

  // Workspace info
  if (p.workspacePath) {
    html += '<div style="font-size:10px;color:var(--text3);margin-bottom:14px">Path: <span style="color:var(--text2)">' + esc(p.workspacePath) + '</span></div>';
  } else if (p.slug) {
    html += '<div style="font-size:10px;color:var(--text3);margin-bottom:14px">Workspace: <span style="color:var(--text2)">workspace/' + esc(p.slug) + '/</span></div>';
  }

  // Child goals — mini kanban board
  var goals = p.childGoals || [];
  if (goals.length) {
    html += '<div class="section-label">Goals Board</div>';
    var cols = [
      { key: 'pending', label: 'Pending', color: 'var(--yellow)', statuses: ['pending','draft','proposed'] },
      { key: 'active', label: 'In Progress', color: 'var(--cyan)', statuses: ['active','in_progress'] },
      { key: 'completed', label: 'Done', color: 'var(--green)', statuses: ['completed'] },
      { key: 'other', label: 'Blocked/Other', color: 'var(--text3)', statuses: ['blocked','abandoned'] }
    ];
    var grouped = {};
    cols.forEach(function(c) { grouped[c.key] = []; });
    goals.forEach(function(g) {
      var placed = false;
      for (var ci = 0; ci < cols.length; ci++) {
        if (cols[ci].statuses.indexOf(g.status) !== -1) { grouped[cols[ci].key].push(g); placed = true; break; }
      }
      if (!placed) grouped['pending'].push(g);
    });
    var priColors = { critical: 'var(--red)', high: 'var(--yellow)', medium: 'var(--cyan)', low: 'var(--text3)' };
    html += '<div class="mini-kanban">';
    cols.forEach(function(col) {
      var items = grouped[col.key];
      html += '<div class="mk-col">' +
        '<div class="mk-col-header">' +
          '<span class="mk-col-label" style="color:' + col.color + '">' + col.label + '</span>' +
          '<span class="mk-col-count">' + items.length + '</span>' +
        '</div>';
      if (!items.length) {
        html += '<div class="mk-empty">None</div>';
      }
      items.forEach(function(g) {
        var ms = g.milestones || [];
        var msDone = ms.filter(function(m) { return m.status === 'completed' || m.status === 'done'; }).length;
        var msText = ms.length ? msDone + '/' + ms.length : '';
        html += '<div class="mk-card" onclick="showGoalDetail(\\'' + esc(g.id) + '\\')">' +
          '<div class="mk-card-title">' + esc(g.title) + '</div>' +
          '<div class="mk-card-meta">' +
            '<span class="mk-card-pri" style="color:' + (priColors[g.priority] || 'var(--text3)') + '">' + esc(g.priority || 'medium') + '</span>' +
            (msText ? '<span class="mk-card-ms">' + msText + ' ms</span>' : '') +
            '<span style="font-size:9px;color:var(--text3)">' + (g.progress || 0) + '%</span>' +
          '</div>' +
          '<div class="progress-bar" style="margin-top:3px;height:2px"><div class="progress-fill" style="width:' + (g.progress || 0) + '%"></div></div>' +
        '</div>';
      });
      html += '</div>';
    });
    html += '</div>';
  } else {
    // Show parent milestones if no child goals
    var ms = p.milestones || [];
    if (ms.length) {
      html += '<div class="section-label">Milestones</div>';
      html += '<div style="margin-bottom:8px">' + ms.map(function(m) {
        var done = m.status === 'completed' || m.status === 'done';
        return '<div class="milestone-item ' + (done ? 'done' : 'pending') + '">' +
          '<span class="milestone-icon">' + (done ? '&#10003;' : '&#9675;') + '</span>' +
          esc(m.title) +
        '</div>';
      }).join('') + '</div>';
    }
  }

  // Add goal form
  html += '<div class="section-label" style="margin-top:14px">Add Goal</div>';
  html += '<div class="add-goal-row">' +
    '<input type="text" id="addGoalTitle-' + esc(p.id) + '" placeholder="New goal title..." onkeydown="if(event.key===\\'Enter\\')addGoalToProject(\\'' + esc(p.id) + '\\')">' +
    '<button onclick="addGoalToProject(\\'' + esc(p.id) + '\\')">+ Add</button>' +
  '</div>';

  return html;
}

// ── Toggle ────────────────────────────────────────────────────────────────

function toggleProject(id) {
  var body = document.getElementById('body-' + id);
  var icon = document.getElementById('ti-' + id);
  if (!body) return;
  if (body.style.display === 'none') {
    body.style.display = 'block';
    if (icon) icon.classList.add('open');
  } else {
    body.style.display = 'none';
    if (icon) icon.classList.remove('open');
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────

(function initWS() {
  try {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'goals:updated' || msg.type === 'agent:cycle:goal_created' || msg.type === 'agent:cycle:goal_updated') {
          loadProjects();
        }
      } catch {}
    };
    ws.onclose = function() { setTimeout(initWS, 5000); };
  } catch {}
})();

// ── Init ──────────────────────────────────────────────────────────────────

loadProjects();
</script>
</body>
</html>`;
