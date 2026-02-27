/**
 * Projects — Project onboarding and management.
 *
 * A "project" is a parent goal (category='project') with child goals linked
 * via parentGoalId. Each project gets a workspace directory and metadata
 * stored in kv_state.
 *
 * createProject(brief) — Decompose a project brief into goals + milestones
 * listProjects()       — List all projects with child goals and metadata
 * getProject(id)       — Get a single project with full detail
 */

import { mkdirSync, readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, basename, extname, resolve } from 'path';
import { execSync } from 'child_process';
import config from './config.js';
import { addGoal, listGoals, getGoal } from './goals.js';
import { kvGet, kvSet } from './db.js';
import { chatOneShot } from './claude.js';
import { createLogger } from './logger.js';
import { emit as wsEmit } from './ws-events.js';

const log = createLogger('projects');

// ── Create project from brief ───────────────────────────────────────────────

export async function createProject(brief, { title, priority } = {}) {
  if (!brief || typeof brief !== 'string') throw new Error('Project brief is required');

  // Decompose via Haiku (cheap, fast)
  let parsed;
  try {
    let raw = '';
    await chatOneShot(
      `You are a project decomposition engine. Given a project brief, produce a structured breakdown.

Project brief: ${brief.slice(0, 4000)}

Return ONLY valid JSON with this structure:
{
  "title": "Short project title (max 60 chars)",
  "description": "2-3 sentence project description",
  "slug": "kebab-case-slug",
  "goals": [
    {
      "title": "Goal title",
      "description": "What this goal achieves",
      "priority": "high|medium|low",
      "milestones": ["Milestone 1", "Milestone 2", "Milestone 3"]
    }
  ]
}

Rules:
- 2-5 goals, each with 2-5 milestones
- Goals should be independent workstreams
- Slug: lowercase, hyphens only, max 30 chars
- Milestones: concrete, verifiable deliverables`,
      (chunk) => { raw += chunk; },
      'haiku'
    );

    // Extract JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in decomposition response');
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    log.error({ err }, 'Failed to decompose project brief');
    throw new Error(`Decomposition failed: ${err.message}`);
  }

  // Validate parsed structure
  if (!parsed.goals || !Array.isArray(parsed.goals) || parsed.goals.length === 0) {
    throw new Error('Decomposition produced no goals');
  }

  const projectTitle = title || parsed.title || 'Untitled Project';
  const slug = (parsed.slug || projectTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)).replace(/^-|-$/g, '');

  // Create parent project goal
  const projectGoal = addGoal(projectTitle, {
    description: parsed.description || brief.slice(0, 500),
    priority: priority || 'high',
    category: 'project',
    milestones: parsed.goals.map(g => g.title),
    source: 'user',
  });

  // Create child goals
  const childGoals = [];
  for (const g of parsed.goals) {
    const child = addGoal(g.title, {
      description: g.description || '',
      priority: g.priority || 'medium',
      category: 'project-task',
      milestones: g.milestones || [],
      source: 'decomposition',
      parentGoalId: projectGoal.id,
    });
    childGoals.push(child);
  }

  // Create workspace directory
  const workspacePath = join(config.workspaceDir, slug);
  try {
    mkdirSync(workspacePath, { recursive: true });
  } catch (err) {
    log.warn({ err, workspacePath }, 'Failed to create workspace dir');
  }

  // Store project metadata
  kvSet(`project:${projectGoal.id}`, JSON.stringify({
    slug,
    brief: brief.slice(0, 5000),
    workspacePath,
    createdAt: Date.now(),
  }));

  // Auto-register QMD collection for searchability
  registerQmdCollection(slug, workspacePath);

  wsEmit('goals:updated', { count: 1 + childGoals.length });

  log.info({ id: projectGoal.id, slug, goals: childGoals.length }, 'Project created');
  return { project: projectGoal, slug, childGoals, workspacePath };
}

// ── List projects ───────────────────────────────────────────────────────────

export function listProjects() {
  const allGoals = listGoals({});
  // Only show goals that were explicitly created via createProject() — they have kv_state metadata
  const projectGoals = allGoals.filter(g => g.category === 'project' && kvGet(`project:${g.id}`));

  return projectGoals.map(pg => {
    const metaRaw = kvGet(`project:${pg.id}`);
    const meta = metaRaw ? JSON.parse(metaRaw) : {};
    const childGoals = allGoals.filter(g => g.parentGoalId === pg.id);
    const fileCount = countWorkspaceFiles(meta.slug || meta.workspacePath);

    // Aggregate progress from child goals (or fallback to own progress)
    const aggProgress = childGoals.length > 0
      ? Math.round(childGoals.reduce((sum, g) => sum + (g.progress || 0), 0) / childGoals.length)
      : pg.progress;

    return {
      ...pg,
      progress: aggProgress,
      slug: meta.slug || pg.id,
      brief: meta.brief || pg.description,
      workspacePath: meta.workspacePath,
      childGoals,
      fileCount,
    };
  });
}

// ── Get single project ──────────────────────────────────────────────────────

export function getProject(idOrSlug) {
  // Try direct goal lookup
  let pg = getGoal(idOrSlug);
  if (pg && pg.category !== 'project') pg = null;

  // Try slug lookup
  if (!pg) {
    const allProjects = listGoals({ category: 'project' });
    pg = allProjects.find(g => {
      const raw = kvGet(`project:${g.id}`);
      if (!raw) return false;
      const meta = JSON.parse(raw);
      return meta.slug === idOrSlug;
    });
  }

  if (!pg) return null;

  const metaRaw = kvGet(`project:${pg.id}`);
  const meta = metaRaw ? JSON.parse(metaRaw) : {};
  const allGoals = listGoals({});
  const childGoals = allGoals.filter(g => g.parentGoalId === pg.id);
  const fileCount = countWorkspaceFiles(meta.slug || meta.workspacePath);

  return {
    ...pg,
    slug: meta.slug,
    brief: meta.brief,
    workspacePath: meta.workspacePath,
    childGoals,
    fileCount,
  };
}

// ── Import existing project from folder ──────────────────────────────────────

export function importProject(folderPath, { title, description, priority } = {}) {
  const resolved = resolve(folderPath);
  if (!existsSync(resolved)) throw new Error(`Folder not found: ${folderPath}`);
  const stat = statSync(resolved);
  if (!stat.isDirectory()) throw new Error('Path is not a directory');

  const slug = basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/^-|-$/g, '') || 'project';
  const projectTitle = title || basename(resolved);

  // Scan the directory for a description
  const autoDesc = description || detectProjectDescription(resolved);

  // Scan files
  const tree = scanDirectory(resolved, 3); // 3 levels deep

  // Create parent project goal
  const projectGoal = addGoal(projectTitle, {
    description: autoDesc,
    priority: priority || 'medium',
    category: 'project',
    milestones: [],
    source: 'user',
  });

  // Store metadata — point to the actual folder, not workspace
  kvSet(`project:${projectGoal.id}`, JSON.stringify({
    slug,
    brief: autoDesc,
    workspacePath: resolved,
    createdAt: Date.now(),
    fileTree: tree,
  }));

  // Auto-register QMD collection for searchability
  registerQmdCollection(slug, resolved);

  wsEmit('goals:updated', { count: 1 });

  log.info({ id: projectGoal.id, slug, path: resolved, files: tree.totalFiles }, 'Project imported from folder');
  return { project: projectGoal, slug, workspacePath: resolved, fileTree: tree };
}

// ── Add goal to existing project ────────────────────────────────────────────

export function addGoalToProject(projectId, goalTitle, { description, priority, milestones } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');

  const child = addGoal(goalTitle, {
    description: description || '',
    priority: priority || 'medium',
    category: 'project-task',
    milestones: milestones || [],
    source: 'user',
    parentGoalId: project.id,
  });

  wsEmit('goals:updated', { count: 1 });
  log.info({ projectId: project.id, goalId: child.id, title: goalTitle }, 'Goal added to project');
  return child;
}

// ── Scan directory ──────────────────────────────────────────────────────────

export function scanDirectory(dirPath, maxDepth = 3, _depth = 0) {
  const IGNORE = new Set([
    'node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv',
    '.next', '.nuxt', 'dist', 'build', 'coverage', '.cache', '.turbo',
    'vendor', 'target', 'bin', 'obj', '.idea', '.vscode',
  ]);
  const result = { dirs: [], files: [], totalFiles: 0, totalDirs: 0 };

  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (IGNORE.has(entry.name)) continue;

    if (entry.isDirectory()) {
      result.totalDirs++;
      const sub = _depth < maxDepth
        ? scanDirectory(join(dirPath, entry.name), maxDepth, _depth + 1)
        : { dirs: [], files: [], totalFiles: 0, totalDirs: 0 };
      result.dirs.push({ name: entry.name, ...sub });
      result.totalFiles += sub.totalFiles;
      result.totalDirs += sub.totalDirs;
    } else if (entry.isFile()) {
      result.totalFiles++;
      try {
        const st = statSync(join(dirPath, entry.name));
        result.files.push({ name: entry.name, size: st.size });
      } catch {
        result.files.push({ name: entry.name, size: 0 });
      }
    }
  }
  return result;
}

// ── Detect project description from common files ────────────────────────────

function detectProjectDescription(dirPath) {
  // Try README
  for (const name of ['README.md', 'readme.md', 'README.txt', 'README']) {
    const p = join(dirPath, name);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf-8').slice(0, 2000);
        // Extract first paragraph after title
        const lines = content.split('\n');
        const descLines = [];
        let pastTitle = false;
        for (const line of lines) {
          if (!pastTitle && (line.startsWith('#') || line.trim() === '')) { pastTitle = line.startsWith('#'); continue; }
          if (pastTitle && line.trim() === '' && descLines.length > 0) break;
          if (pastTitle && line.trim()) descLines.push(line.trim());
        }
        if (descLines.length > 0) return descLines.join(' ').slice(0, 500);
      } catch {}
    }
  }

  // Try package.json description
  const pkgPath = join(dirPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.description) return pkg.description;
    } catch {}
  }

  // Try pyproject.toml or setup.py description
  const pyprojectPath = join(dirPath, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf-8');
      const match = content.match(/description\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {}
  }

  // Fallback: list top-level file types
  try {
    const files = readdirSync(dirPath);
    const exts = new Set(files.map(f => extname(f)).filter(Boolean));
    const techHints = [];
    if (exts.has('.js') || exts.has('.ts')) techHints.push('JavaScript/TypeScript');
    if (exts.has('.py')) techHints.push('Python');
    if (exts.has('.go')) techHints.push('Go');
    if (exts.has('.rs')) techHints.push('Rust');
    if (exts.has('.java')) techHints.push('Java');
    if (exts.has('.cs')) techHints.push('C#');
    if (files.includes('Dockerfile')) techHints.push('Docker');
    if (techHints.length) return `Project using ${techHints.join(', ')}`;
  } catch {}

  return '';
}

// ── QMD collection auto-registration ────────────────────────────────────────

function registerQmdCollection(slug, dirPath) {
  try {
    const qmdBin = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'qmd.cmd' : 'qmd');
    // Detect source directories to index
    const srcDirs = ['src', 'lib', 'server', 'frontend/src', 'app', 'pages', 'components'];
    let targetDir = dirPath;
    for (const sub of srcDirs) {
      const candidate = join(dirPath, sub);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        targetDir = candidate;
        break;
      }
    }
    // Detect file types
    const mask = detectMask(targetDir);
    const name = `proj-${slug}`;
    execSync(`"${qmdBin}" collection add "${targetDir}" --name ${name} --mask "${mask}"`, {
      timeout: 30_000, stdio: 'ignore',
    });
    log.info({ name, targetDir, mask }, 'QMD collection registered for project');
  } catch (err) {
    log.warn({ err: err.message, slug }, 'Failed to register QMD collection for project');
  }
}

function detectMask(dirPath) {
  try {
    const files = readdirSync(dirPath, { recursive: false });
    const exts = new Set(files.map(f => extname(f)).filter(Boolean));
    if (exts.has('.tsx') || exts.has('.ts')) return '**/*.{ts,tsx}';
    if (exts.has('.jsx')) return '**/*.{js,jsx}';
    if (exts.has('.js')) return '**/*.js';
    if (exts.has('.py')) return '**/*.py';
    if (exts.has('.go')) return '**/*.go';
    if (exts.has('.rs')) return '**/*.rs';
    if (exts.has('.java')) return '**/*.java';
    if (exts.has('.cs')) return '**/*.cs';
  } catch {}
  return '**/*.{js,jsx,ts,tsx,py}';
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function countWorkspaceFiles(pathOrSlug) {
  if (!pathOrSlug) return 0;
  try {
    const dir = pathOrSlug.includes('/') || pathOrSlug.includes('\\')
      ? pathOrSlug
      : join(config.workspaceDir, pathOrSlug);
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}
