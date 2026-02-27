/**
 * Daily Digest — one LLM-synthesized morning briefing replacing scattered raw data dumps.
 *
 * Gathers data from 9+ modules, sends a single WhatsApp message with a concise
 * briefing, and injects structured proposals into the agent-brain pipeline.
 *
 * Follows the same pattern as recap.js: gather → prompt → chatOneShot → store state.
 */

import { chatOneShot } from './claude.js';
import { getNotesForDate } from './daily-notes.js';
import { getCostOverview } from './cost-analytics.js';
import { getDetailedMetrics } from './metrics.js';
import { getGoalSummary, getStaleGoals, getUpcomingDeadlines } from './goals.js';
import { listCrons } from './crons.js';
import { getBrainStatus, injectDigestProposals } from './agent-brain.js';
import { getOutcomeSummary, formatPatternInsights } from './outcome-tracker.js';
import { listNotes } from './user-notes.js';
import { isConnected as isMcpConnected } from './mcp-gateway.js';
import { getMemoryDashboard } from './memory-guardian.js';
import { getState, setState } from './state.js';
import { createLogger } from './logger.js';
import config from './config.js';

const log = createLogger('daily-digest');
const STATE_KEY = 'daily-digest';
const TZ = config.timezone;

/**
 * Get yesterday's date string in YYYY-MM-DD format (Israel time).
 */
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

/**
 * Get today's date string in YYYY-MM-DD format (Israel time).
 */
function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

/**
 * Gather data from all available sources for the digest prompt.
 * All operations are safe — return empty/null on failure.
 */
function gatherDigestData() {
  const data = {};

  // Yesterday's conversation notes
  try {
    data.yesterdayNotes = getNotesForDate(yesterdayStr()) || '';
  } catch { data.yesterdayNotes = ''; }

  // Cost overview
  try {
    data.cost = getCostOverview();
  } catch { data.cost = null; }

  // Detailed metrics
  try {
    data.metrics = getDetailedMetrics();
  } catch { data.metrics = null; }

  // Goals
  try {
    data.goalSummary = getGoalSummary();
    data.staleGoals = getStaleGoals(48);
    data.upcomingDeadlines = getUpcomingDeadlines(3);
  } catch {
    data.goalSummary = '';
    data.staleGoals = [];
    data.upcomingDeadlines = [];
  }

  // Crons
  try {
    data.crons = listCrons();
  } catch { data.crons = []; }

  // Agent brain
  try {
    data.brainStatus = getBrainStatus();
  } catch { data.brainStatus = ''; }

  // Outcome tracking
  try {
    data.outcomeSummary = getOutcomeSummary();
  } catch { data.outcomeSummary = ''; }

  // Pattern insights
  try {
    data.patternInsights = formatPatternInsights(30);
  } catch { data.patternInsights = ''; }

  // User notes
  try {
    data.userNotes = listNotes();
  } catch { data.userNotes = []; }

  // System health (enhanced with Memory Guardian)
  try {
    const mem = process.memoryUsage();
    let memGuardian = null;
    try { memGuardian = getMemoryDashboard(); } catch {}
    data.systemHealth = {
      rssMb: Math.round(mem.rss / 1048576),
      heapMb: Math.round(mem.heapUsed / 1048576),
      mcpConnected: isMcpConnected(),
      memoryTier: memGuardian?.tier || 'unknown',
      memoryChronic: memGuardian?.chronic?.chronic || false,
      memoryTrend: memGuardian?.trend || 'unknown',
      memoryShedCount: memGuardian?.shedCount || 0,
    };
  } catch {
    data.systemHealth = null;
  }

  return data;
}

/**
 * Build the LLM prompt from gathered data, capped at config.digestMaxPromptChars.
 */
function buildDigestPrompt(data) {
  const parts = [];
  const maxNotes = config.digestMaxNotesChars;

  // Instruction header
  parts.push(`You are a personal AI assistant writing a morning briefing for your user the user.
Write a concise 5-10 line morning briefing using WhatsApp formatting (*bold*, _italic_).
Focus on: what happened yesterday, what needs attention today, anomalies.
Skip sections where nothing interesting happened. Be direct and specific.
Start with "Good morning." — do not add greetings beyond that.

After the briefing, if you find actionable patterns, append 0-3 structured proposals.
Each proposal must be wrapped exactly like this:
[PROPOSAL type="<type>" confidence=<0.0-1.0>]
<message to show the user, 1-2 sentences>
[/PROPOSAL]

Valid proposal types: recurring_query, cost_optimization, cron_management, goal_nudge, system_health, workflow_suggestion
Only propose things that are clearly actionable. If nothing stands out, include zero proposals.`);

  // Yesterday's notes
  if (data.yesterdayNotes && data.yesterdayNotes.length > 50) {
    parts.push(`\n--- Yesterday's conversation notes ---\n${data.yesterdayNotes.slice(0, maxNotes)}`);
  }

  // Cost
  if (data.cost) {
    const c = data.cost;
    const lines = [];
    if (c.yesterday) lines.push(`Yesterday: $${c.yesterday.total?.toFixed(4) || '0'} (${c.yesterday.count || 0} calls)`);
    if (c.today) lines.push(`Today so far: $${c.today.total?.toFixed(4) || '0'}`);
    if (c.weekTotal) lines.push(`Week: $${c.weekTotal.toFixed(4)}`);
    if (c.dailyAvg) lines.push(`Daily avg: $${c.dailyAvg.toFixed(4)}`);
    if (lines.length > 0) parts.push(`\n--- Cost ---\n${lines.join('\n')}`);
  }

  // Metrics
  if (data.metrics) {
    const m = data.metrics;
    const lines = [
      `Uptime: ${m.uptime || '?'}`,
      `Messages: ${m.messages_in || 0} in / ${m.messages_out || 0} out`,
      `Errors: ${m.errors || 0}`,
      `Avg latency: ${m.avg_latency_ms || 0}ms`,
    ];
    if (m.recent_errors?.length > 0) {
      lines.push(`Recent errors: ${m.recent_errors.slice(0, 3).map(e => e.type).join(', ')}`);
    }
    parts.push(`\n--- System metrics ---\n${lines.join('\n')}`);
  }

  // Goals
  if (data.goalSummary && data.goalSummary.length > 10) {
    let goalSection = `Goals:\n${data.goalSummary}`;
    if (data.upcomingDeadlines.length > 0) {
      const dlLines = data.upcomingDeadlines.map(g => {
        const dl = new Date(g.deadline);
        const daysLeft = Math.ceil((dl - new Date()) / (1000 * 60 * 60 * 24));
        return `- ${g.title}: ${daysLeft <= 0 ? 'OVERDUE' : daysLeft + 'd left'}`;
      }).join('\n');
      goalSection += `\nDeadlines within 3 days:\n${dlLines}`;
    }
    if (data.staleGoals.length > 0) {
      goalSection += `\nStale (no activity 48h): ${data.staleGoals.map(g => g.title).join(', ')}`;
    }
    parts.push(`\n--- Goals ---\n${goalSection}`);
  }

  // Crons
  if (data.crons.length > 0) {
    const failing = data.crons.filter(j => j.enabled && j.state?.consecutiveErrors > 0);
    const total = data.crons.filter(j => j.enabled).length;
    let cronSection = `${total} active crons`;
    if (failing.length > 0) {
      cronSection += `\nFailing: ${failing.map(j => `${j.name} (${j.state.consecutiveErrors} errors)`).join(', ')}`;
    }
    parts.push(`\n--- Crons ---\n${cronSection}`);
  }

  // Agent brain
  if (data.brainStatus && data.brainStatus.length > 20) {
    parts.push(`\n--- Agent brain ---\n${data.brainStatus.slice(0, 500)}`);
  }

  // Outcome summary
  if (data.outcomeSummary && data.outcomeSummary.length > 10) {
    parts.push(`\n--- Proposal outcomes ---\n${data.outcomeSummary}`);
  }

  // Pattern insights
  if (data.patternInsights && data.patternInsights.length > 10) {
    parts.push(`\n--- Response patterns ---\n${data.patternInsights}`);
  }

  // User notes count
  if (data.userNotes.length > 0) {
    parts.push(`\n--- User notes ---\n${data.userNotes.length} personal notes stored`);
  }

  // System health (with Memory Guardian data)
  if (data.systemHealth) {
    const h = data.systemHealth;
    const lines = [
      `Memory: ${h.rssMb}MB RSS / ${h.heapMb}MB heap`,
      `Memory tier: ${h.memoryTier || 'unknown'}${h.memoryChronic ? ' [CHRONIC PRESSURE]' : ''}`,
      `Memory trend: ${h.memoryTrend || 'unknown'} (${h.memoryShedCount || 0} cache sheds)`,
      `Vestige MCP: ${h.mcpConnected ? 'connected' : 'DISCONNECTED'}`,
    ];
    parts.push(`\n--- System health ---\n${lines.join('\n')}`);
  }

  // Join and cap
  let prompt = parts.join('\n');
  if (prompt.length > config.digestMaxPromptChars) {
    prompt = prompt.slice(0, config.digestMaxPromptChars) + '\n\n[...truncated]';
  }

  return prompt;
}

/**
 * Parse [PROPOSAL] blocks from LLM output.
 * Returns array of { type, confidence, message, actionParams }.
 */
function parseProposals(llmOutput) {
  const proposals = [];
  const regex = /\[PROPOSAL\s+type="([^"]+)"\s+confidence=([\d.]+)\]([\s\S]*?)\[\/PROPOSAL\]/g;
  let match;

  while ((match = regex.exec(llmOutput)) !== null) {
    const type = match[1].trim();
    const confidence = parseFloat(match[2]);
    const message = match[3].trim();

    if (type && message && confidence > 0) {
      proposals.push({ type, confidence, message, actionParams: { source: 'digest', type } });
    }
  }

  return proposals.slice(0, 3); // max 3 proposals
}

/**
 * Strip proposal blocks from LLM output, returning only the human-readable briefing.
 */
function extractBriefing(llmOutput) {
  return llmOutput
    .replace(/\[PROPOSAL\s+type="[^"]+"\s+confidence=[\d.]+\][\s\S]*?\[\/PROPOSAL\]/g, '')
    .trim();
}

/**
 * Check if gathered data is uneventful enough to skip the LLM call.
 * Returns true if nothing interesting happened.
 */
function isUneventful(data) {
  // Yesterday had meaningful conversation?
  if (data.yesterdayNotes.length > 100) return false;

  // Any cron failures?
  const failingCrons = (data.crons || []).filter(j => j.enabled && j.state?.consecutiveErrors > 0);
  if (failingCrons.length > 0) return false;

  // Any upcoming deadlines or stale goals?
  if (data.upcomingDeadlines.length > 0) return false;
  if (data.staleGoals.length > 0) return false;

  // Cost spike? (yesterday > 1.5x daily average)
  if (data.cost?.yesterday?.total > 0 && data.cost?.dailyAvg > 0) {
    if (data.cost.yesterday.total > data.cost.dailyAvg * 1.5) return false;
  }

  // MCP disconnected?
  if (data.systemHealth && !data.systemHealth.mcpConnected) return false;

  // High memory?
  if (data.systemHealth && data.systemHealth.rssMb > 450) return false;

  return true;
}

/**
 * Main entry point. Generates digest, sends briefing, injects proposals.
 * Deduplicates via state key + date check.
 * Skips LLM call on uneventful days; sends a one-liner after 3 consecutive skips.
 *
 * @param {Function} sendFn - WhatsApp send function
 * @returns {{ briefing: string, proposals: number, costUsd: number } | null}
 */
export async function generateDigest(sendFn) {
  const today = todayStr();
  const state = getState(STATE_KEY);

  // Dedup — don't send twice on same day
  if (state.lastDate === today && !state.forced) {
    log.info({ lastDate: state.lastDate }, 'Digest already sent today, skipping');
    return null;
  }

  log.info('Generating daily digest');
  const startMs = Date.now();

  try {
    // Gather data
    const data = gatherDigestData();

    // Skip LLM call on uneventful days to save cost and reduce noise
    if (isUneventful(data) && !state.forced) {
      const consecutiveSkips = (state.consecutiveSkips || 0) + 1;
      log.info({ consecutiveSkips }, 'Uneventful day, skipping digest');

      // After 3+ consecutive skips, send a one-liner so the user knows we're alive
      if (consecutiveSkips >= 3 && sendFn) {
        await sendFn(`_All quiet for ${consecutiveSkips} days, nothing to flag._`);
      }

      setState(STATE_KEY, {
        lastDate: today,
        lastGeneratedAt: Date.now(),
        skipped: true,
        consecutiveSkips,
        forced: false,
      });
      return null;
    }

    // Build prompt
    const prompt = buildDigestPrompt(data);
    log.debug({ promptLen: prompt.length }, 'Digest prompt built');

    // LLM call
    const { reply, costUsd } = await chatOneShot(prompt, null);
    if (!reply) throw new Error('Empty LLM reply');

    // Extract briefing and proposals
    const briefing = extractBriefing(reply);
    const digestProposals = parseProposals(reply);

    // Send briefing via WhatsApp
    if (sendFn && briefing) {
      await sendFn(briefing);
      log.info({ briefingLen: briefing.length }, 'Digest briefing sent');
    }

    // Inject proposals into agent-brain pipeline
    let injectedCount = 0;
    if (digestProposals.length > 0) {
      try {
        const injected = injectDigestProposals(digestProposals);
        injectedCount = injected.length;
        // Send proposals via WhatsApp (they go through the normal approve/reject flow)
        for (const p of injected) {
          if (sendFn) {
            await sendFn(`*Agent observation:*\n${p.message}\n\nConfidence: ${Math.round(p.confidence * 100)}%\n_Reply "do it" to approve, "skip" to dismiss, or "later" to snooze._`);
          }
        }
        log.info({ parsed: digestProposals.length, injected: injectedCount }, 'Digest proposals injected');
      } catch (err) {
        log.warn({ err: err.message }, 'Failed to inject digest proposals (non-critical)');
      }
    }

    const durationMs = Date.now() - startMs;

    // Save state (reset skip counter on successful digest)
    setState(STATE_KEY, {
      lastDate: today,
      lastGeneratedAt: Date.now(),
      briefingLen: briefing.length,
      proposalCount: digestProposals.length,
      injectedCount,
      costUsd: costUsd || 0,
      durationMs,
      consecutiveSkips: 0,
      skipped: false,
      forced: false,
    });

    log.info({ durationMs, costUsd, proposals: digestProposals.length }, 'Daily digest complete');
    return { briefing, proposals: injectedCount, costUsd: costUsd || 0 };
  } catch (err) {
    log.warn({ err: err.message }, 'Daily digest generation failed');

    // Save failure state (don't block retry on next cycle)
    setState(STATE_KEY, {
      ...state,
      lastError: err.message,
      lastErrorAt: Date.now(),
      forced: false,
    });

    throw err; // Let caller handle fallback
  }
}

/**
 * Force-generate a digest (for /digest command). Bypasses date dedup.
 */
export async function forceDigest(sendFn) {
  setState(STATE_KEY, { ...getState(STATE_KEY), forced: true });
  return generateDigest(sendFn);
}

/**
 * Get digest status for /digest status command.
 */
export function getDigestStatus() {
  const state = getState(STATE_KEY);
  const parts = ['*Daily Digest*'];

  parts.push(`Enabled: ${config.digestEnabled ? 'yes' : 'no'}`);
  parts.push(`Scheduled hour: ${config.digestHour}:00 (Israel)`);

  if (state.lastDate) {
    parts.push(`Last digest: ${state.lastDate}`);
  }
  if (state.lastGeneratedAt) {
    const time = new Date(state.lastGeneratedAt).toLocaleTimeString('en-IL', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit',
    });
    parts.push(`Generated at: ${time}`);
  }
  if (state.costUsd != null) {
    parts.push(`Cost: $${state.costUsd.toFixed(4)}`);
  }
  if (state.proposalCount != null) {
    parts.push(`Proposals: ${state.proposalCount} parsed, ${state.injectedCount || 0} injected`);
  }
  if (state.durationMs) {
    parts.push(`Duration: ${(state.durationMs / 1000).toFixed(1)}s`);
  }
  if (state.lastError) {
    parts.push(`Last error: ${state.lastError}`);
  }

  return parts.join('\n');
}
