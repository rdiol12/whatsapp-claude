/**
 * Auto-coder — Autonomous milestone implementation support.
 *
 * pickMilestone(goals)        — Selects the next pending milestone from the
 *                               highest-priority active/in_progress goal.
 * buildMilestoneBrief(g, ms)  — Returns a prompt-injection block that tells the
 *                               Sonnet cycle exactly what to implement this run.
 * runTests()                  — Runs syntax check + test suite via tool-bridge.
 * commitAndReport(g, ms, ev)  — Git commit + Telegram notify when a milestone ships.
 *
 * Wired into agent-loop.js Sonnet cycle:
 *   • buildAgentPrompt() injects the brief so the cycle has a concrete task.
 *   • milestone_complete handler calls runTests() + commitAndReport() after success.
 */

import { createLogger } from './logger.js';
import { executeTool } from './tool-bridge.js';
import { notify } from './notify.js';
import config from './config.js';

const log = createLogger('auto-coder');
const PROJECT_ROOT = config.projectRoot.replace(/\\/g, '/');

/** Priority sort order — lower number = higher priority */
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, normal: 3, low: 4 };

// ---------------------------------------------------------------------------
// pickMilestone
// ---------------------------------------------------------------------------

/**
 * Find the highest-priority active/in_progress goal that has at least one
 * pending milestone, and return the first pending milestone from it.
 *
 * @param {object[]} goals   Array returned by listGoals() from goals.js
 * @returns {{ goal: object, milestone: object } | null}
 */
export function pickMilestone(goals) {
  if (!Array.isArray(goals) || goals.length === 0) return null;

  const candidates = goals
    .filter(g => ['active', 'in_progress'].includes(g.status))
    .filter(g => Array.isArray(g.milestones) && g.milestones.some(m => m.status === 'pending'))
    .sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 5;
      const pb = PRIORITY_ORDER[b.priority] ?? 5;
      return pa - pb;
    });

  if (!candidates.length) return null;

  const goal = candidates[0];
  const milestone = goal.milestones.find(m => m.status === 'pending');

  log.info({ goalId: goal.id, milestoneId: milestone.id, title: milestone.title }, 'pickMilestone: selected');
  return { goal, milestone };
}

// ---------------------------------------------------------------------------
// buildMilestoneBrief
// ---------------------------------------------------------------------------

/**
 * Build a structured implementation brief to inject into the Sonnet cycle prompt.
 * The brief tells the agent exactly what to build, and includes the XML tags
 * required to signal completion.
 *
 * @param {object} goal
 * @param {object} milestone
 * @returns {string}
 */
export function buildMilestoneBrief(goal, milestone) {
  return [
    `## AUTO-CODER: Your coding task this cycle`,
    `**Goal**: ${goal.title} (id: \`${goal.id}\`)`,
    `**Milestone**: ${milestone.id} — ${milestone.title}`,
    `**Goal description**: ${goal.description}`,
    ``,
    `**Implementation instructions**:`,
    `1. Check \`lib/\` for existing modules that do something similar — extend, don't duplicate.`,
    `2. Every new file MUST be imported by at least one existing module. Dead code = failed milestone.`,
    `3. After writing code, verify the import exists: use \`shell_exec\` with a grep command.`,
    `4. Run syntax check after writing (platform-agnostic, works on Windows and Linux):`,
    `   <tool_call name="shell_exec">{"command": "node -e \\"const fs=require('fs'),cp=require('child_process'),p=require('path');const d=p.join(process.env.PROJECT_ROOT||process.cwd(),'lib');let ok=true;fs.readdirSync(d).filter(f=>f.endsWith('.js')).forEach(f=>{const r=cp.spawnSync(process.execPath,['--check',p.join(d,f)],{encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr||r.stdout||f+'\\\\n');ok=false;}});if(ok)console.log('SYNTAX_OK');else process.exit(1)\\"", "timeout": 60000}</tool_call>`,
    `5. When the milestone is complete, emit:`,
    `   <milestone_complete goal="${goal.id}" milestone="${milestone.id}">brief description of what you built and where it's wired</milestone_complete>`,
    `6. Update goal progress:`,
    `   <goal_update id="${goal.id}" status="in_progress" progress="${computeExpectedProgress(goal, milestone)}">completed ${milestone.id}: ${milestone.title}</goal_update>`,
    ``,
    `Do NOT declare the milestone complete until the code is written AND syntax-checked.`,
  ].join('\n');
}

/** Estimate progress % after completing this milestone */
function computeExpectedProgress(goal, milestone) {
  const milestones = goal.milestones || [];
  if (!milestones.length) return 50;
  const idx = milestones.findIndex(m => m.id === milestone.id);
  // Mark as if this one is now done
  const doneSoFar = milestones.filter(m => m.status !== 'pending').length + 1;
  return Math.round((doneSoFar / milestones.length) * 100);
}

// ---------------------------------------------------------------------------
// runTests
// ---------------------------------------------------------------------------

/**
 * Run syntax check on all lib/*.js files, then run the test suite.
 * Uses tool-bridge's shell_exec so results flow through the normal
 * error-recovery and rate-limit machinery.
 *
 * @returns {Promise<{ passed: boolean, output: string }>}
 */
export async function runTests() {
  // Step 1: ESM syntax check — pure Node.js, platform-agnostic (no PowerShell, no glob)
  const syntax = await executeTool('shell_exec', {
    command: `cd "${PROJECT_ROOT}" && node -e "const fs=require('fs'),cp=require('child_process'),p=require('path');const d=p.join(process.cwd(),'lib');let ok=true;fs.readdirSync(d).filter(f=>f.endsWith('.js')).forEach(f=>{const r=cp.spawnSync(process.execPath,['--check',p.join(d,f)],{encoding:'utf8'});if(r.status!==0){process.stderr.write(r.stderr||r.stdout||f+'\\n');ok=false;}});if(ok)console.log('SYNTAX_OK');else process.exit(1)"`,
    timeout: 60000,
  });

  const syntaxOut = (syntax.result?.stdout || '') + (syntax.result?.stderr || '') + (syntax.error || '');
  if (!syntaxOut.includes('SYNTAX_OK')) {
    log.warn({ output: syntaxOut.slice(0, 500) }, 'auto-coder: syntax check failed');
    return { passed: false, output: `Syntax check failed:\n${syntaxOut.slice(0, 1000)}` };
  }

  // Step 2: Full test suite
  const tests = await executeTool('shell_exec', {
    command: `cd "${PROJECT_ROOT}" && node test/run-all.js 2>&1`,
    timeout: 120000,
  });

  const testOut = (tests.result?.stdout || '') + (tests.result?.stderr || '') + (tests.error || '');
  // Rely on exit code only — test output legitimately contains "Error:" strings in passing tests
  const passed = tests.result?.exitCode === 0;

  log.info({ passed, exitCode: tests.result?.exitCode }, 'auto-coder: test run complete');
  return { passed, output: testOut.slice(0, 2000) };
}

// ---------------------------------------------------------------------------
// commitAndReport
// ---------------------------------------------------------------------------

/**
 * Stage lib/ and test/ changes, commit with a structured message, and send a
 * Telegram + WhatsApp notification summarising what shipped.
 *
 * @param {object}   goal        The goal object
 * @param {object}   milestone   The milestone that was completed
 * @param {string}   evidence    Short description from <milestone_complete> tag
 * @param {Function} [sendFn]    Optional WhatsApp send function — notifies the user directly
 * @returns {Promise<{ committed: boolean, hash: string, skipped: boolean }>}
 */
export async function commitAndReport(goal, milestone, evidence, sendFn = null) {
  // Check if there's anything to commit — and collect the exact changed files
  const diffCheck = await executeTool('shell_exec', {
    command: `cd "${PROJECT_ROOT}" && git status --short lib/ test/ 2>&1`,
    timeout: 15000,
  });

  const diffOut = diffCheck.result?.stdout || '';
  if (!diffOut.trim()) {
    log.info({ goalId: goal.id, milestoneId: milestone.id }, 'auto-coder: nothing to commit, skipping');
    return { committed: false, hash: '', skipped: true };
  }

  // Parse changed files from git status --short output (e.g. " M lib/foo.js")
  // Only add files that are actually modified — avoids pulling in unrelated staged changes
  const changedFilesList = diffOut
    .split('\n')
    .map(l => l.trim().split(/\s+/).pop())
    .filter(f => f && (f.startsWith('lib/') || f.startsWith('test/')));

  // Sanitise all dynamic content — strip shell metacharacters to prevent injection
  const safeEvidence = (evidence || '').replace(/[`'";&|$(){}[\]<>!#*?\n\r\\]/g, '').slice(0, 200) || 'auto-coder milestone';
  const safeTitle = (milestone.title || '').replace(/[`'";&|$(){}[\]<>!#*?\n\r\\]/g, '');
  const safeGoalId = String(goal.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const subject = `feat(${safeGoalId}): ${safeTitle}`.slice(0, 72);
  const body2 = `Auto-coder: ${milestone.id} of ${goal.milestones?.length ?? '?'} milestones`;
  // Quote each filename individually to handle paths with spaces safely
  const quotedFiles = changedFilesList.map(f => `"${f.replace(/"/g, '')}"`).join(' ');
  const commit = await executeTool('shell_exec', {
    command: `cd "${PROJECT_ROOT}" && git add ${quotedFiles} && git commit -m "${subject}" -m "${safeEvidence}" -m "${body2}"`,
    timeout: 30000,
  });

  const commitOut = commit.result?.stdout || '';
  const committed = commit.result?.exitCode === 0;
  const hash = commitOut.match(/\[[\w\-/]+ ([a-f0-9]{7})\]/)?.[1] || '';

  const telegramMsg = committed
    ? `✅ *Auto-coder shipped: ${milestone.id}*\nGoal: ${goal.title}\nMilestone: ${milestone.title}\nCommit: \`${hash}\``
    : `⚠️ *Auto-coder: ${milestone.id} done but commit failed*\nGoal: ${goal.title}\n${(commit.result?.stderr || '').slice(0, 200)}`;

  notify(telegramMsg);

  // WhatsApp notification so the user knows what shipped
  if (sendFn) {
    const waMsg = committed
      ? `✅ *שיפור אוטומטי נשלח*\n*${milestone.title}*\ncommit \`${hash}\``
      : `⚠️ *אוטו-קודר: commit נכשל*\n${milestone.title}`;
    try { await sendFn(waMsg); } catch (e) {
      log.warn({ err: e.message }, 'auto-coder: WhatsApp notify failed (non-fatal)');
    }
  }

  log.info({ goalId: goal.id, milestoneId: milestone.id, committed, hash }, 'auto-coder: commitAndReport done');
  return { committed, hash, skipped: false };
}
