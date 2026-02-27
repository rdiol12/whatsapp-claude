/**
 * modules/hattrick/hattrick.js — Hattrick team management module.
 *
 * Provides URL builders, config helpers, match analysis, transfer market,
 * training, bid management, and brief builders for the agent loop.
 *
 * Team ID must be set via HATTRICK_TEAM_ID env var.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import config from '../../lib/config.js';
import { createLogger } from '../../lib/logger.js';
import { getState, setState } from '../../lib/state.js';
import { addEntry as addLearningEntry } from '../../lib/learning-journal.js';

const log = createLogger('hattrick');

const BASE = 'https://www.hattrick.org/en';
const SNAPSHOT_PATH = join(config.dataDir, 'state', 'hattrick-snapshot.json');
const NEEDS_SCRAPE_PATH = join(config.dataDir, 'state', 'hattrick-needs-scrape.json');
const ANALYSIS_PATH = join(config.dataDir, 'state', 'hattrick-analysis.json');
const MATCH_HISTORY_PATH = join(config.dataDir, 'state', 'hattrick-match-history.json');
const TRANSFER_WATCHLIST_PATH = join(config.dataDir, 'state', 'hattrick-transfer-watchlist.json');
const OPPONENT_SCOUT_PATH     = join(config.dataDir, 'state', 'hattrick-opponent-scout.json');
const TRAINING_RECOMMENDATION_PATH = join(config.dataDir, 'state', 'hattrick-training-recommendation.json');
const WEEKLY_DASHBOARD_PATH         = join(config.dataDir, 'state', 'hattrick-weekly-dashboard.json');
const DECISIONS_PATH                = join(config.dataDir, 'state', 'hattrick-decisions.json');
const SKILL_HISTORY_PATH            = join(config.dataDir, 'state', 'hattrick-skill-history.json');
const TRAINING_STATE_PATH           = join(config.dataDir, 'state', 'hattrick-training.json');
const BID_AUDIT_LOG_PATH            = join(config.dataDir, 'state', 'hattrick-bid-audit.jsonl');
const MAX_DECISIONS = 200;

// ─── URL Builders ─────────────────────────────────────────────────────────

/** Team overview page */
export function getTeamUrl(teamId = config.hattrickTeamId) {
  if (!teamId) throw new Error('HATTRICK_TEAM_ID not configured');
  return `${BASE}/Club/?TeamID=${teamId}`;
}

/** Upcoming matches */
export function getMatchesUrl(teamId = config.hattrickTeamId) {
  if (!teamId) throw new Error('HATTRICK_TEAM_ID not configured');
  return `${BASE}/Club/Matches/?TeamID=${teamId}`;
}

/** Squad / players list */
export function getPlayersUrl(teamId = config.hattrickTeamId) {
  if (!teamId) throw new Error('HATTRICK_TEAM_ID not configured');
  return `${BASE}/Club/Players/?TeamID=${teamId}`;
}

/** Training settings */
export function getTrainingUrl(teamId = config.hattrickTeamId) {
  if (!teamId) throw new Error('HATTRICK_TEAM_ID not configured');
  return `${BASE}/Club/Training/?TeamID=${teamId}`;
}

/** Transfer market for team */
export function getTransferUrl(teamId = config.hattrickTeamId) {
  if (!teamId) throw new Error('HATTRICK_TEAM_ID not configured');
  return `${BASE}/Transfer/?TeamID=${teamId}`;
}

// ─── Config Helpers ───────────────────────────────────────────────────────

/** True if HATTRICK_TEAM_ID is set. */
export function isConfigured() {
  return !!(config.hattrickTeamId);
}

/** Returns the configured team ID, or null. */
export function getTeamId() {
  return config.hattrickTeamId || null;
}

// ─── Match Analysis ───────────────────────────────────────────────────────

/**
 * Build an LLM prompt for pre-match analysis and lineup recommendation.
 * Pass in raw scraped text from hattrick.org pages.
 *
 * @param {object} opts
 * @param {string} [opts.teamData]       - scraped team/squad info
 * @param {string} [opts.opponentData]   - scraped opponent team info
 * @param {string} [opts.leagueStandings]- current league table snippet
 * @returns {string}
 */
export function buildMatchAnalysisPrompt({ teamData, opponentData, leagueStandings } = {}) {
  return `You are analyzing the user's Hattrick football team for an upcoming match.

## the user's Team Data
${teamData || '(not yet scraped — call getPlayersUrl() to fetch)'}

## Opponent Data
${opponentData || '(not yet scraped — call getMatchesUrl() to fetch opponent details)'}

## League Standings
${leagueStandings || '(not yet scraped)'}

## Your Task
1. Recommend the optimal formation (e.g. 4-4-2, 4-5-1, 3-5-2) based on player skills.
2. Name the starting 11 with their positions.
3. Suggest one training focus for the next 7 days.
4. If any weak positions are visible, suggest a transfer target profile (age, skill, budget-conscious).
5. Predict match outcome: Win / Draw / Loss probability.

Be specific, concise, and actionable. Format with bullet points.`;
}

// ─── Pre-match scrape plan ────────────────────────────────────────────────

/**
 * Returns a list of URLs to scrape before the next match.
 * Use these with the scrapling MCP tool in the agent cycle.
 *
 * @param {string} [teamId]
 * @returns {string[]}
 */
export function getPreMatchScrapeUrls(teamId = config.hattrickTeamId) {
  if (!teamId) {
    log.warn('getPreMatchScrapeUrls called without teamId configured');
    return [];
  }
  return [
    getTeamUrl(teamId),
    getMatchesUrl(teamId),
    getPlayersUrl(teamId),
  ];
}

// ─── Snapshot State Persistence ──────────────────────────────────────────

/**
 * Save a team data snapshot to disk.
 * Called by the Sonnet agent cycle after scraping hattrick.org.
 *
 * @param {object} data - scraped team data (players, matches, economy, etc.)
 * @returns {object} the saved snapshot with savedAt timestamp
 */
export function saveSnapshot(data) {
  try {
    mkdirSync(join(config.dataDir, 'state'), { recursive: true });
    const snapshot = { ...data, savedAt: Date.now() };
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
    log.info({ path: SNAPSHOT_PATH }, 'Hattrick snapshot saved');
    // Append TSI history for trend tracking
    try { appendTsiSnapshot(data.players || []); } catch {}
    // Append skill history when players carry skill data (e.g. after a full scrape)
    try { appendSkillHistorySnapshot(data.players || [], { season: data.season, week: data.week }); } catch {}
    // Clear the needs-scrape flag if present
    try {
      if (existsSync(NEEDS_SCRAPE_PATH)) writeFileSync(NEEDS_SCRAPE_PATH, '{}', 'utf8');
    } catch {}
    return snapshot;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save hattrick snapshot');
    throw err;
  }
}

/**
 * Load the last saved team snapshot from disk.
 * Returns null if no snapshot exists or if it's unreadable.
 *
 * @returns {object|null}
 */
export function loadSnapshot() {
  try {
    if (!existsSync(SNAPSHOT_PATH)) return null;
    return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to load hattrick snapshot');
    return null;
  }
}

/**
 * True if no snapshot exists or it's older than maxAgeMs (default: 7 days).
 * Used by detectHattrickSignals to decide when to re-scrape.
 *
 * @param {number} [maxAgeMs] - max age in ms before snapshot is considered stale
 * @returns {boolean}
 */
export function isSnapshotStale(maxAgeMs = 7 * 24 * 3600_000) {
  const snap = loadSnapshot();
  if (!snap?.savedAt) return true;
  return (Date.now() - snap.savedAt) > maxAgeMs;
}

/**
 * Check if the weekly cron has scheduled a scrape.
 * Returns the scheduledAt timestamp, or null if no pending scrape.
 *
 * @returns {number|null}
 */
export function getScrapeRequest() {
  try {
    if (!existsSync(NEEDS_SCRAPE_PATH)) return null;
    const data = JSON.parse(readFileSync(NEEDS_SCRAPE_PATH, 'utf8'));
    return data?.scheduledAt || null;
  } catch {
    return null;
  }
}

// ─── Analysis Persistence ─────────────────────────────────────────────────

/**
 * Save a pre-match analysis result to disk.
 * Called by the agent after generating lineup recommendation.
 *
 * @param {object} analysis - { formation, lineup, trainingFocus, transferHint, prediction, rawAnalysis }
 * @returns {object} saved record with savedAt timestamp
 */
export function saveAnalysis(analysis) {
  try {
    mkdirSync(join(config.dataDir, 'state'), { recursive: true });
    const record = { ...analysis, savedAt: Date.now() };
    writeFileSync(ANALYSIS_PATH, JSON.stringify(record, null, 2), 'utf8');
    log.info({ path: ANALYSIS_PATH }, 'Hattrick analysis saved');
    // Auto-log lineup decision for outcome tracking
    if (analysis.formation) {
      try {
        const snap = loadSnapshot();
        logDecision({ type: 'lineup', matchId: snap?.upcomingMatch?.matchId || null, round: snap?.upcomingMatch?.round || null, reasoning: analysis.rawAnalysis?.slice(0, 200) || '', details: { formation: analysis.formation, opponent: snap?.upcomingMatch?.opponent || '', venue: snap?.upcomingMatch?.isHome ? 'home' : 'away' } });
      } catch {}
    }
    return record;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save hattrick analysis');
    throw err;
  }
}

/**
 * Load the most recent pre-match analysis from disk.
 * Returns null if no analysis exists or it's unreadable.
 *
 * @returns {object|null}
 */
export function loadLastAnalysis() {
  try {
    if (!existsSync(ANALYSIS_PATH)) return null;
    return JSON.parse(readFileSync(ANALYSIS_PATH, 'utf8'));
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to load hattrick analysis');
    return null;
  }
}

// ─── Prompt Injection (agent-loop context block) ──────────────────────────

/**
 * Build a Hattrick match prep context block for injection into the agent prompt.
 * Called by agent-loop.buildAgentPrompt() when a hattrick_match_prep signal fires.
 * Mirrors the error-analytics pattern: signal detected → context injected → agent acts.
 *
 * Tells the agent exactly what to scrape, how to build the analysis prompt,
 * and what to send the user via WhatsApp.
 *
 * @param {object} signal - the hattrick_match_prep signal object
 * @returns {string} markdown context block
 */
export function buildHattrickMatchBrief(signal) {
  const { data = {} } = signal || {};
  const { teamId, scrapeUrls = [] } = data;
  const lastAnalysis = loadLastAnalysis();
  const lastSnap = loadSnapshot();

  const urlList = scrapeUrls.length
    ? scrapeUrls.map((u, i) => `   ${i + 1}. ${u}`).join('\n')
    : '   (no URLs — HATTRICK_TEAM_ID not set)';

  const snapAge = lastSnap?.savedAt
    ? `Last snapshot: ${Math.round((Date.now() - lastSnap.savedAt) / 3_600_000)}h ago`
    : 'No snapshot yet';
  const analysisAge = lastAnalysis?.savedAt
    ? `Last analysis: ${Math.round((Date.now() - lastAnalysis.savedAt) / (24 * 3_600_000))}d ago`
    : 'No previous analysis';

  const prevSummary = lastAnalysis
    ? [
        `Formation: ${lastAnalysis.formation || 'N/A'}`,
        `Prediction: ${lastAnalysis.prediction || 'N/A'}`,
        `Saved: ${new Date(lastAnalysis.savedAt).toLocaleDateString('en-IL')}`,
      ].join(' | ')
    : 'None yet — this is the first analysis run.';

  const lineupPatterns = getDecisionPatterns('lineup');
  const historicalBlock = lineupPatterns.patterns.length
    ? `### Historical Insights (from past decisions):\n${lineupPatterns.patterns.join('\n')}`
    : '';

  return `## Hattrick Match Prep (TeamID: ${teamId || 'unknown'})
${snapAge} | ${analysisAge}

### URLs to scrape (use web_scrape_stealth tool):
${urlList}

### Action plan (execute in order):
1. Use \`web_scrape_stealth\` to fetch each URL and collect the page text.
2. Extract: players list (skills/ratings), upcoming opponent name, league table position.
3. Call \`buildMatchAnalysisPrompt({ teamData, opponentData, leagueStandings })\` from lib/hattrick.js.
4. Run the analysis prompt through Haiku — extract formation, starting 11, training focus, prediction.
5. Call \`saveAnalysis({ formation, lineup, trainingFocus, prediction, rawAnalysis })\` from lib/hattrick.js.
6. IMPORTANT: Output your match briefing in a <wa_message> tag so the user receives it.
7. Set \`state.lastHattrickScrapeHandledAt = Date.now()\` so the signal doesn't re-fire.

### Previous analysis:
${prevSummary}
${historicalBlock ? historicalBlock + '\n' : ''}${HT_ERROR_HANDLING}
8. **VERIFY**: After saving analysis, call hattrick_get_matches to confirm lineup was saved. Report any discrepancy.`;
}

// ─── Match History ─────────────────────────────────────────────────────────

/**
 * Save a completed match result to the match history log.
 * Appends to an array in hattrick-match-history.json.
 * Deduplicates by matchDate — safe to call multiple times.
 *
 * @param {object} result - { matchDate, round, homeTeam, awayTeam, isHome, goalsFor, goalsAgainst, result, playerRatings }
 * @returns {object} the saved record with savedAt timestamp
 */
export function saveMatchResult(result) {
  try {
    mkdirSync(join(config.dataDir, 'state'), { recursive: true });
    const history = loadMatchHistory();
    const record = { ...result, savedAt: Date.now() };
    // Avoid duplicates: skip if same matchDate already exists
    const exists = history.some(r => r.matchDate === result.matchDate);
    if (!exists) history.push(record);
    writeFileSync(MATCH_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
    log.info({ matchDate: result.matchDate, result: result.result }, 'Hattrick match result saved');
    // Auto-link outcome to lineup decision
    try {
      const avgRating = result.playerRatings?.length
        ? Math.round(result.playerRatings.reduce((s, p) => s + (p.rating || 0), 0) / result.playerRatings.length * 10) / 10
        : null;
      linkOutcome(result.matchId || String(result.round) || String(result.matchDate), {
        result: result.result, goalsFor: result.goalsFor, goalsAgainst: result.goalsAgainst,
        avgRating, success: result.result === 'W',
      });
    } catch {}
    return record;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save hattrick match result');
    throw err;
  }
}

/**
 * Load full match history array (oldest → newest).
 * Returns empty array if no history exists.
 *
 * @returns {object[]}
 */
export function loadMatchHistory() {
  try {
    if (!existsSync(MATCH_HISTORY_PATH)) return [];
    return JSON.parse(readFileSync(MATCH_HISTORY_PATH, 'utf8')) || [];
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to load hattrick match history');
    return [];
  }
}

/**
 * True if snapshot contains a lastMatchDate newer than lastReviewedAt.
 * Used by detectHattrickSignals to decide when to emit hattrick_post_match_review.
 *
 * @param {number} [lastReviewedAt=0] - timestamp of last review
 * @returns {boolean}
 */
export function hasUnreviewedMatch(lastReviewedAt = 0) {
  const snap = loadSnapshot();
  if (!snap?.lastMatchDate) return false;
  return snap.lastMatchDate > lastReviewedAt;
}

// ─── Post-match Review ────────────────────────────────────────────────────

/**
 * Build an LLM prompt for post-match review.
 * Compares actual result vs pre-match prediction and recommends tactical adjustments.
 *
 * @param {object} opts
 * @param {object} [opts.lastResult]         - the completed match result record
 * @param {object[]} [opts.matchHistory=[]]  - full history array for form analysis
 * @param {object} [opts.snapshot]           - current team snapshot
 * @param {object} [opts.previousAnalysis]   - pre-match prediction that was made
 * @returns {string} the LLM prompt
 */
export function buildPostMatchReviewPrompt({ lastResult, matchHistory = [], snapshot, previousAnalysis } = {}) {
  const resultLine = lastResult
    ? `${lastResult.homeTeam || '?'} ${lastResult.goalsFor ?? '?'}-${lastResult.goalsAgainst ?? '?'} ${lastResult.awayTeam || '?'} (${lastResult.isHome ? 'HOME' : 'AWAY'}) — Round ${lastResult.round || '?'} — ${lastResult.result || '?'}`
    : '(no result data available)';

  const formString = matchHistory.slice(-5).map(r =>
    `R${r.round}: ${r.goalsFor}-${r.goalsAgainst} vs ${r.isHome ? r.awayTeam : r.homeTeam} (${r.result})`
  ).join(' | ') || '(no history yet)';

  const predLine = previousAnalysis?.prediction
    ? `Pre-match prediction: ${previousAnalysis.prediction} | Formation used: ${previousAnalysis.formation || 'N/A'}`
    : '(no prediction on file — first analysis run)';

  const playerRatingsBlock = lastResult?.playerRatings?.length
    ? lastResult.playerRatings.map(p => `  - ${p.name} (${p.position}): ${p.rating}`).join('\n')
    : snapshot?.players?.length
      ? snapshot.players.map(p => `  - ${p.name} (${p.lastMatchPosition || '?'}): ${p.lastMatchRating || '?'}`).join('\n')
      : '(no player ratings available — re-scrape players page)';

  return `You are doing a post-match review of the user's Hattrick football team (configured via HATTRICK_TEAM_ID).

## Last Match Result
${resultLine}

## Form (Last 5 matches)
${formString}

## Pre-Match Prediction vs Reality
${predLine}

## Player Ratings (Last Match)
${playerRatingsBlock}

## Your Task
1. **Result analysis** — What went right/wrong? Why did this result happen?
2. **Prediction accuracy** — Did the pre-match prediction match reality? What was missed?
3. **Top 3 performers** — Name top 3 rated players and why they stood out.
4. **3 worst performers** — Who underperformed? Consider benching or repositioning.
5. **Tactical adjustment** — What should change for the next match? (formation/tactics)
6. **Training focus** — Should we keep current training or pivot? (1 specific skill)
7. **Transfer need** — Is there a position so weak it needs a market signing? (age/skill/budget profile)
8. **Next match outlook** — What's the prediction for the next fixture?

Be direct, specific, and actionable. Format as short bullet points the user can act on immediately.`;
}

/**
 * Build a post-match context block for injection into the agent prompt.
 * Called by agent-loop.buildAgentPrompt() when hattrick_post_match_review signal fires.
 * Mirrors the error-analytics + hattrick_match_prep pattern.
 *
 * @param {object} signal - the hattrick_post_match_review signal object
 * @returns {string} markdown context block
 */
export function buildPostMatchBrief(signal) {
  const { data = {} } = signal || {};
  const { lastMatchDate, round } = data;
  const lastAnalysis = loadLastAnalysis();
  const history = loadMatchHistory();
  const snap = loadSnapshot();

  const matchLine = lastMatchDate
    ? `Last match: ${new Date(lastMatchDate).toLocaleDateString('en-IL')} (Round ${round || '?'})`
    : 'Last match date: unknown — check snapshot';

  const historyLine = history.length
    ? `${history.length} result(s) on record`
    : 'No match history yet';

  const prevLine = lastAnalysis?.prediction
    ? `Pre-match prediction: ${lastAnalysis.prediction} | Formation: ${lastAnalysis.formation || 'N/A'}`
    : 'No previous prediction on file';

  const snapLine = snap
    ? `Snapshot saved: ${new Date(snap.savedAt).toLocaleDateString('en-IL')} | Players: ${snap.playersCount || snap.players?.length || '?'}`
    : 'No snapshot — consider re-scraping before review';

  return `## Hattrick Post-Match Review
${matchLine} | History: ${historyLine}
${prevLine}
${snapLine}

### Action plan (execute in order):
1. Call \`buildPostMatchReviewPrompt({ lastResult, matchHistory, snapshot, previousAnalysis })\` from lib/hattrick.js.
2. Run the prompt through Haiku to generate the review.
3. Extract: result analysis, top/worst performers, tactical adjustment, training focus, transfer hint, next match prediction.
4. Call \`saveMatchResult({ matchDate, round, homeTeam, awayTeam, isHome, goalsFor, goalsAgainst, result, playerRatings })\` from lib/hattrick.js.
5. IMPORTANT: Output your post-match report in a <wa_message> tag so the user receives it.
6. Set \`state.lastHattrickPostMatchReviewAt = Date.now()\` to suppress signal until next match.
${HT_ERROR_HANDLING}`;
}

// ─── Transfer Market Monitoring ───────────────────────────────────────────

/**
 * Save the transfer target watchlist to disk.
 * Each item: { position, minSkill, maxSkill, maxAge, maxWage, priority, reason, addedAt }
 *
 * @param {object[]} items - array of transfer target profiles
 * @returns {object} { items, updatedAt }
 */
export function saveTransferWatchlist(items) {
  try {
    mkdirSync(join(config.dataDir, 'state'), { recursive: true });
    const record = { items, updatedAt: Date.now() };
    writeFileSync(TRANSFER_WATCHLIST_PATH, JSON.stringify(record, null, 2), 'utf8');
    log.info({ count: items.length }, 'Transfer watchlist saved');
    return record;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save transfer watchlist');
    throw err;
  }
}

/**
 * Load the transfer target watchlist from disk.
 * Returns { items: [], updatedAt: null } if no watchlist exists.
 *
 * @returns {{ items: object[], updatedAt: number|null }}
 */
export function loadTransferWatchlist() {
  try {
    if (!existsSync(TRANSFER_WATCHLIST_PATH)) return { items: [], updatedAt: null };
    return JSON.parse(readFileSync(TRANSFER_WATCHLIST_PATH, 'utf8'));
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to load transfer watchlist');
    return { items: [], updatedAt: null };
  }
}

/**
 * Build Hattrick transfer search URLs for the given watchlist items.
 * Each item produces one URL with position/skill/age filters.
 *
 * @param {object[]} [items=[]] - watchlist items
 * @returns {string[]} array of search URLs
 */
export function getTransferSearchUrls(items = []) {
  // NOTE: /Transfer/SearchPlayers/ requires Hattrick Supporter subscription → AccessDenied without it.
  // Use the non-Supporter workaround URL: /World/Transfers/TransfersSearchResult.aspx?showTransfersFromSimilarTeams=1
  // This page is accessible without Supporter and shows players from similar-level teams.
  const WORKAROUND_BASE = 'https://www.hattrick.org/World/Transfers/TransfersSearchResult.aspx';

  if (items.length === 0) {
    // No specific targets — return the general similar-teams browse page
    return [`${WORKAROUND_BASE}?showTransfersFromSimilarTeams=1`];
  }

  return items.map(item => {
    const params = new URLSearchParams();
    params.set('showTransfersFromSimilarTeams', '1');
    if (item.position) params.set('Position', item.position);
    if (item.minSkill != null) params.set('MinSkill', item.minSkill);
    if (item.maxSkill != null) params.set('MaxSkill', item.maxSkill);
    if (item.maxAge != null) params.set('MaxAge', item.maxAge);
    return `${WORKAROUND_BASE}?${params.toString()}`;
  });
}

/**
 * Build an LLM prompt for transfer market analysis.
 * Combines squad weaknesses with market data to recommend specific signings.
 *
 * @param {object} opts
 * @param {string} [opts.squadWeaknesses] - text summary of weak positions
 * @param {object[]} [opts.watchlist=[]]  - current watchlist items
 * @param {string} [opts.marketData]      - scraped player listings from transfer search
 * @param {string} [opts.budget]          - available wage budget (NIS/week)
 * @returns {string} the LLM prompt
 */
export function buildTransferSearchPrompt({ squadWeaknesses, watchlist = [], marketData, budget } = {}) {
  const watchlistBlock = watchlist.length
    ? watchlist.map((item, i) =>
        `${i + 1}. **${item.position}** — min skill: ${item.minSkill ?? 'any'}, max age: ${item.maxAge ?? 'any'}, max wage: ${item.maxWage ?? 'any'} NIS/wk | ${item.priority} priority — ${item.reason}`
      ).join('\n')
    : '(no targets defined yet — generate from squad weaknesses)';

  return `You are managing transfer market activity for the user's Hattrick team (configured via HATTRICK_TEAM_ID).

## Squad Weaknesses
${squadWeaknesses || '(not provided — check snapshot and match history for low-rated positions)'}

## Available Wage Budget
${budget || '(unknown — check economy page for available funds)'}

## Active Transfer Targets (Watchlist)
${watchlistBlock}

## Transfer Market Data (scraped)
${marketData || '(not yet scraped — use getTransferSearchUrls() to fetch player listings)'}

## Your Task
1. **Priority signing** — Which position needs a transfer most urgently? Why?
2. **Target profile** — Age range (aim for <24 for long-term value), minimum skill, max weekly wage.
3. **Market availability** — Based on scraped data, are there players that match? List top 2-3.
4. **Sell candidates** — Any squad players worth selling? (age >30 + declining TSI = free up wages).
5. **Budget check** — Is current wage bill (37,100 NIS/wk) leaving room for a new signing?
6. **72h action** — What specific action should the user take in the next 72 hours?

Be direct and specific. Format as actionable bullet points the user can act on.`;
}

/**
 * Build a transfer market context block for injection into the agent prompt.
 * Called by agent-loop.buildAgentPrompt() when hattrick_transfer_watch signal fires.
 * Mirrors the match-prep and post-match brief patterns.
 *
 * @param {object} signal - the hattrick_transfer_watch signal object
 * @returns {string} markdown context block
 */
export function buildTransferMarketBrief(signal) {
  const watchlistData = loadTransferWatchlist();
  const snap = loadSnapshot();
  const history = loadMatchHistory();
  const items = watchlistData.items || [];

  const watchlistBlock = items.length
    ? items.map(i => `- **${i.position}** (${i.priority}): ${i.reason}`).join('\n')
    : '- GK: O. Aharon rated 1.5 last match — needs replacement\n- CD: both CBs rated 2.0 — upgrade needed';

  const snapLine = snap
    ? `Squad: ${snap.playersCount || snap.players?.length || '?'} players, avg TSI ${snap.teamTSI ? Math.round(snap.teamTSI / (snap.playersCount || 18)) : '?'}`
    : 'No snapshot — re-scrape first';

  const formLine = history.length
    ? `Recent form: ${history.slice(-3).map(r => r.result).join(' ')} (W=win, D=draw, L=loss)`
    : 'No match history yet';

  const searchUrls = getTransferSearchUrls(
    items.length ? items.slice(0, 2) : [
      { position: 'Goalkeeper', minSkill: 5, maxAge: 26 },
      { position: 'CentralDefender', minSkill: 5, maxAge: 24 },
    ]
  );

  const urlList = searchUrls.map((u, i) => `   ${i + 1}. ${u}`).join('\n');

  return `## Hattrick Transfer Market Check
${snapLine} | ${formLine}
Watchlist: ${items.length} target(s) | Last check: ${watchlistData.updatedAt ? new Date(watchlistData.updatedAt).toLocaleDateString('en-IL') : 'never'}

### Current transfer targets:
${watchlistBlock}

### Action plan (execute in order):
1. Use \`hattrick_scrape\` (MCP) or \`web_scrape_stealth\` to fetch the transfer search pages below.
2. Call \`buildTransferSearchPrompt({ squadWeaknesses, watchlist, marketData, budget })\` from lib/hattrick.js.
3. Run through Haiku — identify top 2 available players matching watchlist profiles.
4. Call \`saveTransferWatchlist(items)\` to update priorities if needed.
5. IMPORTANT: Output your transfer report in a <wa_message> tag so the user receives it.
6. Set \`state.lastHattrickTransferCheckAt = Date.now()\` to suppress signal for 3 days.

### Transfer search URLs (scrape these):
${urlList}
${HT_ERROR_HANDLING}
7. **VERIFY**: After saving watchlist, confirm save succeeded without error.`;
}

// ─── Brief Builders for Agent-Loop Signal Injection ─────────────────────────
// These are injected into the agent-loop prompt when the corresponding
// hattrick signal fires. Each returns a context block Claude can act on.

const HT_BASE = `You are managing the user's Hattrick football team (configured via HATTRICK_TEAM_ID).
You have access to hattrick MCP tools. Use them to complete this task.
Be concise and actionable — the user reads this on WhatsApp.
IMPORTANT: Always output your findings in a <wa_message> tag so the user receives the update.

### MCP Tool Error Handling
- If an MCP tool returns an error, empty data, or a login/session page, **retry once**.
- If it fails again, do NOT guess or hallucinate data. Report in <wa_message>: "MCP tool [name] failed: [error]. Browser session may need re-login."
- If hattrick_get_players returns empty/zero players, session expired. Report: "Hattrick session expired — the user, run hattrick_login."
- When tools are down, use cached data in this brief (if any) and mark report: "Based on cached data from [date] — live data unavailable."`;

const HT_ERROR_HANDLING = `
### MCP Tool Error Handling
- If an MCP tool returns an error, empty data, or a login/session page, retry once.
- If it fails again, report the failure in <wa_message> — do NOT guess or hallucinate.
- Empty player list = session expired. Report: "Hattrick session expired — the user, run hattrick_login."
- If tools are completely down, use any cached data provided above and mark report as "PARTIAL — cached data".`;

export function buildEconomyCheckBrief(signal) {
  return `## Hattrick Economy Check

${HT_BASE}

### Task:
1. Use get_economy to fetch current financial data
2. Report: cash balance, weekly income, weekly expenses, net cash flow
3. Flag any financial concerns (wage bill too high, low cash reserves)
4. Brief recommendation (1-2 sentences) on financial health
5. Call saveAnalysis({ action: 'economy_check', rawAnalysis: <your report> }) to persist

Keep it short — just the key numbers and any concerns.`;
}

export function buildFullRefreshBrief(signal) {
  const snap = loadSnapshot();
  const snapAge = snap?.savedAt ? `${Math.round((Date.now() - snap.savedAt) / (24 * 3_600_000))}d old` : 'missing';
  return `## Hattrick Full Team Data Refresh
Snapshot: ${snapAge}

${HT_BASE}

### Task:
1. Use get_team for overall team info
2. Use get_players for full squad data
3. Use get_matches for recent results and upcoming fixtures
4. Use get_economy for financial overview
5. Provide a brief team status summary: league position, form, squad health, finances

This is a routine data refresh. Summarize the key numbers.
Call saveAnalysis({ action: 'full_refresh', rawAnalysis: <your summary> }) to persist.`;
}

export function buildTrainingCheckBrief(signal) {
  const snap = loadSnapshot();
  const history = loadMatchHistory();
  const basePrompt = buildTrainingRecommendationPrompt(snap, history);
  const progressReport = getTrainingProgressReport();
  const progressSection = progressReport ? `\n\n${progressReport}` : '';
  const skillSnapshotReminder = `\n\n### Skill Snapshot (IMPORTANT)
After your analysis, also capture a fresh skill snapshot:
1. Call hattrick_get_players to fetch the current roster with skill levels.
2. Call saveSnapshot({ players: <parsed player data>, season: <current season>, week: <current week> }) to persist.
This ensures weekly training progress is tracked for Mallet + Kassab scoring skill monitoring.`;
  return `## Hattrick Training Check\n\n${basePrompt}${progressSection}${skillSnapshotReminder}\n\nAfter analysis, call saveTrainingRecommendation({ rawReply: <your analysis>, checkedAt: Date.now() }) to persist.`;
}

// ─── Training Progress Monitoring (ms_2) ──────────────────────────────────

/**
 * Append a new dated skill-snapshot entry to hattrick-skill-history.json.
 * Called automatically from saveSnapshot() when players carry skill data
 * (keeper/defending/scoring fields present), and also callable directly after
 * a hattrick_get_players MCP call.
 *
 * @param {Array} players  - player objects that include skill fields
 * @param {object} meta    - optional { season, week } metadata
 * @returns {Array} updated history array (empty on error)
 */
export function appendSkillHistorySnapshot(players = [], meta = {}) {
  // Only proceed if at least one player carries meaningful skill data
  if (!players.some(p => p.scoring != null || p.defending != null)) return [];
  try {
    mkdirSync(join(config.dataDir, 'state'), { recursive: true });
    let history = [];
    if (existsSync(SKILL_HISTORY_PATH)) {
      const raw = JSON.parse(readFileSync(SKILL_HISTORY_PATH, 'utf8'));
      history = Array.isArray(raw)
        ? raw
        : Object.values(raw).filter(e => Array.isArray(e?.players));
    }
    const today = new Date().toISOString().slice(0, 10);
    // Avoid same-day duplicates — update in-place if entry already exists
    const existingIdx = history.findIndex(e => e.date === today);
    const entry = {
      date: today,
      season: meta.season ?? null,
      week:   meta.week   ?? null,
      players: players.map(p => ({
        playerID:   p.playerID || p.id || null,
        name:       p.name,
        age:        p.age        ?? null,
        specialty:  p.specialty  ?? null,
        TSI:        p.tsi ?? p.TSI ?? null,
        wage:       p.wage       ?? null,
        form:       p.form       ?? null,
        stamina:    p.stamina    ?? null,
        keeper:     p.keeper     ?? null,
        defending:  p.defending  ?? null,
        playmaking: p.playmaking ?? null,
        winger:     p.winger     ?? null,
        passing:    p.passing    ?? null,
        scoring:    p.scoring    ?? null,
        set_pieces: p.set_pieces ?? null,
      })),
    };
    if (existingIdx >= 0) {
      history[existingIdx] = entry;
    } else {
      history.push(entry);
    }
    writeFileSync(SKILL_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
    log.info({ date: today, players: players.length }, 'Skill history snapshot appended');
    return history;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to append skill history snapshot');
    return [];
  }
}

/**
 * Build a scoring-skill progress report for specific players by reading
 * all entries in hattrick-skill-history.json and comparing over time.
 * Designed for the Mallet + Kassab scoring-training monitoring (ms_2).
 *
 * @param {string[]} playerNames - players to track (default: Mallet + Kassab)
 * @param {string}   skill       - skill field to track (default: 'scoring')
 * @returns {string|null} formatted markdown report, or null if no data
 */
export function getTrainingProgressReport(
  playerNames = ['Yoann Mallet', 'Adnan Kassab'],
  skill = 'scoring'
) {
  try {
    if (!existsSync(SKILL_HISTORY_PATH)) return null;
    const raw = JSON.parse(readFileSync(SKILL_HISTORY_PATH, 'utf8'));
    const entries = (Array.isArray(raw) ? raw : Object.values(raw))
      .filter(e => Array.isArray(e?.players))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (!entries.length) return null;

    // Load training switch context for baseline labelling
    let trainingStartDate = null;
    let trainingType = null;
    try {
      if (existsSync(TRAINING_STATE_PATH)) {
        const ts = JSON.parse(readFileSync(TRAINING_STATE_PATH, 'utf8'));
        if (ts.switchedAt) trainingStartDate = new Date(ts.switchedAt).toISOString().slice(0, 10);
        trainingType = ts.currentTraining?.type || ts.recommendedTraining || null;
      }
    } catch {}

    const skillLabel = skill.charAt(0).toUpperCase() + skill.slice(1);
    const lines = [];
    lines.push(`## ${skillLabel} Training Progress` + (trainingType ? ` (${trainingType})` : ''));
    if (trainingStartDate) lines.push(`Training switched: ${trainingStartDate}`);

    let hasAnyData = false;
    for (const name of playerNames) {
      const progression = [];
      for (const entry of entries) {
        const p = (entry.players || []).find(pl => pl.name === name);
        if (!p) continue;
        const val = p[skill];
        if (val == null) continue;
        progression.push({ date: entry.date, week: entry.week, value: val });
      }
      if (!progression.length) {
        lines.push(`- ${name}: no skill data in history yet`);
        continue;
      }
      hasAnyData = true;
      const baseline = progression[0];
      const latest   = progression[progression.length - 1];
      const delta    = latest.value - baseline.value;
      const snapshots = progression.length;
      const trend = delta > 0 ? `+${delta} 📈` : delta < 0 ? `${delta} 📉` : '→ unchanged';
      lines.push(
        `- **${name}**: ${skillLabel} ${baseline.value} (${baseline.date})` +
        ` → ${latest.value} (${latest.date}) [${trend}, ${snapshots} snapshot${snapshots !== 1 ? 's' : ''}]`
      );
    }
    if (!hasAnyData && entries.length === 1) {
      lines.push('Baseline recorded. Re-check in 1 week after training takes effect.');
    }
    return lines.join('\n');
  } catch (err) {
    log.warn({ err: err.message }, 'getTrainingProgressReport failed');
    return null;
  }
}

// ─── Training Effectiveness Evaluation (ms_2 enhancement) ─────────────────

/**
 * Evaluate whether Scoring training is producing results for Mallet + Kassab.
 * Returns structured assessment used by the weekly training progress signal.
 *
 * @param {string[]} playerNames - players to track (default: Mallet + Kassab)
 * @param {string}   skill       - skill to evaluate (default: 'scoring')
 * @param {object}   opts        - { stallWeeks: 3, targetSkill: 6 }
 * @returns {{ status, weeksSinceSwitch, players[], recommendation, summary }}
 */
export function evaluateTrainingEffectiveness(
  playerNames = ['Yoann Mallet', 'Adnan Kassab'],
  skill = 'scoring',
  opts = {}
) {
  const { stallWeeks = 3, targetSkill = 5 } = opts;
  const result = {
    status: 'unknown',       // too_early | on_track | stalled | target_reached | no_data
    weeksSinceSwitch: 0,
    players: [],
    recommendation: '',
    summary: '',
  };

  try {
    // Load training switch date
    let switchedAt = null;
    if (existsSync(TRAINING_STATE_PATH)) {
      const ts = JSON.parse(readFileSync(TRAINING_STATE_PATH, 'utf8'));
      switchedAt = ts.switchedAt ? new Date(ts.switchedAt) : null;
    }
    if (!switchedAt) {
      result.status = 'no_data';
      result.summary = 'No training switch date recorded — cannot evaluate.';
      return result;
    }

    result.weeksSinceSwitch = Math.floor((Date.now() - switchedAt.getTime()) / (7 * 24 * 3600_000));

    // Load skill history
    if (!existsSync(SKILL_HISTORY_PATH)) {
      result.status = 'no_data';
      result.summary = 'No skill history snapshots recorded yet.';
      return result;
    }
    const raw = JSON.parse(readFileSync(SKILL_HISTORY_PATH, 'utf8'));
    const entries = (Array.isArray(raw) ? raw : Object.values(raw))
      .filter(e => Array.isArray(e?.players))
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (!entries.length) {
      result.status = 'no_data';
      result.summary = 'Skill history file is empty.';
      return result;
    }

    // Find baseline (first snapshot on or after training switch date)
    const switchDate = switchedAt.toISOString().slice(0, 10);
    // Use first available snapshot as baseline if it's before switch,
    // or first snapshot on/after switch date
    let allReachedTarget = true;
    let anyImproved = false;

    for (const name of playerNames) {
      const progression = [];
      for (const entry of entries) {
        const p = (entry.players || []).find(pl => pl.name === name);
        if (!p || p[skill] == null) continue;
        progression.push({ date: entry.date, value: p[skill], tsi: p.TSI });
      }
      const baseline = progression.length > 0 ? progression[0] : null;
      const latest = progression.length > 0 ? progression[progression.length - 1] : null;
      const delta = (baseline && latest) ? latest.value - baseline.value : 0;
      const reachedTarget = latest && latest.value >= targetSkill;
      if (!reachedTarget) allReachedTarget = false;
      if (delta > 0) anyImproved = true;

      result.players.push({
        name,
        baseline: baseline?.value ?? null,
        baselineDate: baseline?.date ?? null,
        current: latest?.value ?? null,
        currentDate: latest?.date ?? null,
        delta,
        reachedTarget: !!reachedTarget,
        snapshots: progression.length,
      });
    }

    // Determine status
    if (result.players.every(p => p.baseline == null)) {
      result.status = 'no_data';
      result.summary = 'No skill data found for tracked players.';
    } else if (allReachedTarget && result.players.every(p => p.reachedTarget)) {
      result.status = 'target_reached';
      result.summary = `All tracked players reached Scoring >= ${targetSkill}. Consider switching training.`;
      result.recommendation = 'TARGET_REACHED: Switch training to next priority (Wing/Defending).';
    } else if (result.weeksSinceSwitch < 2) {
      result.status = 'too_early';
      result.summary = `Only ${result.weeksSinceSwitch} week(s) since training switch. Too early for skill-up (typically 2-4 weeks).`;
      result.recommendation = 'WAIT: Continue Scoring training, re-check next week.';
    } else if (anyImproved) {
      result.status = 'on_track';
      const improved = result.players.filter(p => p.delta > 0).map(p => `${p.name} +${p.delta}`).join(', ');
      result.summary = `Training is working: ${improved}. ${result.weeksSinceSwitch} weeks in.`;
      result.recommendation = 'CONTINUE: Scoring training is producing results.';
    } else if (result.weeksSinceSwitch >= stallWeeks) {
      result.status = 'stalled';
      result.summary = `No scoring improvement after ${result.weeksSinceSwitch} weeks. Check: lineup positions, match minutes, training intensity.`;
      result.recommendation = 'INVESTIGATE: Ensure Mallet + Kassab play FW/LW positions in lineup for full training effect. If still stalled after 4 weeks, consider switching training.';
    } else {
      result.status = 'on_track';
      result.summary = `${result.weeksSinceSwitch} weeks in, no improvement yet — still within normal range (2-4 weeks typical).`;
      result.recommendation = 'WAIT: Skill-ups happen in discrete steps, be patient.';
    }

    return result;
  } catch (err) {
    log.error({ err: err.message }, 'evaluateTrainingEffectiveness failed');
    result.status = 'no_data';
    result.summary = `Error: ${err.message}`;
    return result;
  }
}

// ─── Training Switch-Back Evaluation (ms_3) ──────────────────────────────

/**
 * Maps position gap urgency to Hattrick training type.
 * Used when deciding what to train next after Scoring target is reached.
 */
const GAP_TO_TRAINING = {
  CB: { training: 'Defending (הגנה)', skill: 'defending', reason: 'strengthen central defence' },
  WB: { training: 'Defending (הגנה)', skill: 'defending', reason: 'improve wing-back defence contribution' },
  W:  { training: 'Wing (כנף)', skill: 'winger', reason: 'develop winger attack/crossing' },
  CM: { training: 'Playmaking (יצירה)', skill: 'playmaking', reason: 'boost midfield creativity and possession' },
  FW: { training: 'Scoring (הבקעה)', skill: 'scoring', reason: 'maintain forward finishing' },
  GK: { training: 'Goalkeeping (שוער)', skill: 'keeper', reason: 'improve goalkeeping' },
};

/**
 * Evaluate whether Scoring training target has been reached and recommend next training.
 * This is the ms_3 decision function: when forwards reach Scoring >= 5, analyse squad gaps
 * and recommend the best training to switch to.
 *
 * @param {object} opts - { targetSkill: 5 }
 * @returns {{ shouldSwitch, evaluation, nextTraining, rationale, gapAnalysis, switchAction }}
 */
export function evaluateTrainingSwitchBack(opts = {}) {
  const { targetSkill = 5 } = opts;

  const evaluation = evaluateTrainingEffectiveness(
    ['Yoann Mallet', 'Adnan Kassab'],
    'scoring',
    { targetSkill }
  );

  const result = {
    shouldSwitch: false,
    evaluation,
    nextTraining: null,
    rationale: '',
    gapAnalysis: [],
    switchAction: null,   // { trainingType, skill, reason } if shouldSwitch
  };

  // Only recommend switch when target is reached
  if (evaluation.status !== 'target_reached') {
    result.rationale = `Training status: ${evaluation.status}. ` +
      (evaluation.status === 'too_early'
        ? `Only ${evaluation.weeksSinceSwitch} weeks — wait for skill-ups.`
        : evaluation.status === 'stalled'
          ? 'Investigate: verify lineup positions and training settings.'
          : 'Continue Scoring training — progress ongoing.');
    return result;
  }

  // Target reached! Analyse squad gaps to determine next training
  result.shouldSwitch = true;

  // Load player data for gap analysis
  const snap = loadSnapshot();
  const players = snap?.players || [];
  const gaps = identifyPositionGaps(players);
  result.gapAnalysis = gaps;

  if (gaps.length === 0) {
    result.nextTraining = 'Playmaking (יצירה)';
    result.rationale = 'All positions meet targets. Defaulting to Playmaking — strongest all-round benefit.';
    result.switchAction = { trainingType: 'Playmaking (יצירה)', skill: 'playmaking', reason: 'no gaps, Playmaking is best default' };
    return result;
  }

  // Pick the training that addresses the most urgent gap (excluding FW/Scoring since we just trained it)
  const nonScoringGaps = gaps.filter(g => g.position !== 'FW');
  const topGap = nonScoringGaps.length > 0 ? nonScoringGaps[0] : gaps[0];
  const mapping = GAP_TO_TRAINING[topGap.position];

  if (mapping) {
    result.nextTraining = mapping.training;
    result.switchAction = {
      trainingType: mapping.training,
      skill: mapping.skill,
      reason: mapping.reason,
    };
    result.rationale = `Scoring target reached (both forwards >= ${targetSkill}). ` +
      `Biggest gap: ${topGap.position} (best skill ${topGap.bestSkill}, target ${topGap.targetSkill}). ` +
      `Recommend switching to ${mapping.training} to ${mapping.reason}.`;
  } else {
    result.nextTraining = 'Playmaking (יצירה)';
    result.rationale = `Scoring target reached. Gap at ${topGap.position} has no direct training mapping — defaulting to Playmaking.`;
    result.switchAction = { trainingType: 'Playmaking (יצירה)', skill: 'playmaking', reason: 'unmapped gap, Playmaking as versatile default' };
  }

  // Log this as a training decision for outcome tracking
  try {
    logDecision({
      type: 'training_switch',
      action: `Switch from Scoring to ${result.nextTraining}`,
      reasoning: result.rationale,
      context: {
        malletScoring: evaluation.players.find(p => p.name === 'Yoann Mallet')?.current,
        kassabScoring: evaluation.players.find(p => p.name === 'Adnan Kassab')?.current,
        weeksTrained: evaluation.weeksSinceSwitch,
        topGap: topGap,
      },
    });
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to log training switch decision');
  }

  return result;
}

/**
 * Build brief for the weekly training progress signal.
 * Includes evaluation results, recommended actions, and snapshot reminder.
 */
export function buildTrainingProgressBrief(signal) {
  const evaluation = evaluateTrainingEffectiveness();
  const progressReport = getTrainingProgressReport();
  const snap = loadSnapshot();
  const snapAge = snap?.savedAt ? `${Math.round((Date.now() - snap.savedAt) / (24 * 3_600_000))}d` : 'unknown';

  const lines = [];
  lines.push('## Weekly Training Progress Evaluation');
  lines.push('');
  lines.push(`**Status**: ${evaluation.status.toUpperCase()}`);
  lines.push(`**Weeks since switch**: ${evaluation.weeksSinceSwitch}`);
  lines.push(`**Summary**: ${evaluation.summary}`);
  lines.push('');

  if (evaluation.players.length) {
    lines.push('### Player Progress');
    for (const p of evaluation.players) {
      const delta = p.delta > 0 ? `+${p.delta} \u{1F4C8}` : p.delta < 0 ? `${p.delta} \u{1F4C9}` : '\u{2192} no change';
      lines.push(`- **${p.name}**: Scoring ${p.baseline ?? '?'} (${p.baselineDate ?? '?'}) \u{2192} ${p.current ?? '?'} (${p.currentDate ?? '?'}) [${delta}]`);
    }
    lines.push('');
  }

  lines.push(`**Recommendation**: ${evaluation.recommendation}`);
  lines.push('');

  if (progressReport) {
    lines.push(progressReport);
    lines.push('');
  }

  // Action instructions based on status
  if (evaluation.status === 'target_reached') {
    // Use the switch-back evaluation to provide concrete next-training recommendation
    const switchBack = evaluateTrainingSwitchBack();
    lines.push('### Action Required: SWITCH TRAINING');
    lines.push(`**Next training recommendation**: ${switchBack.nextTraining || 'Playmaking (יצירה)'}`);
    lines.push(`**Rationale**: ${switchBack.rationale}`);
    if (switchBack.gapAnalysis.length > 0) {
      lines.push('**Squad gaps (by urgency)**:');
      for (const g of switchBack.gapAnalysis.slice(0, 4)) {
        lines.push(`  - ${g.position}: best skill ${g.bestSkill}, target ${g.targetSkill} (gap: ${g.urgency})`);
      }
    }
    lines.push('');
    lines.push('**Steps**:');
    lines.push('1. Call hattrick_get_training to verify current training type');
    lines.push(`2. Use hattrick_action to switch training to ${switchBack.nextTraining || 'the recommended type'}`);
    lines.push('3. Update hattrick-training.json with new switchedAt timestamp');
    lines.push('4. Message the user: "Scoring target reached! Switching to [training]."');
    lines.push('5. Mark goal 65108985 as completed');
  } else if (evaluation.status === 'stalled') {
    lines.push('### Investigation Required');
    lines.push('1. Call hattrick_get_players to get fresh skill data');
    lines.push('2. Verify Mallet + Kassab are playing FW/Forward positions (not midfield/wing)');
    lines.push('3. Check training intensity is 100% and stamina share is 10-15%');
    lines.push('4. If positions are wrong, note this for next lineup');
    lines.push('5. Message the user if training appears ineffective');
  } else {
    lines.push('### Routine Actions');
    lines.push('1. Call hattrick_get_players to capture fresh skill snapshot');
    lines.push(`2. Snapshot age: ${snapAge} — refresh if >3 days`);
    lines.push('3. Call saveSnapshot() with updated player data to track week-over-week changes');
  }

  return lines.join('\n');
}

export function buildWeeklyDashboardBrief(signal) {
  const snap = loadSnapshot();
  const history = loadMatchHistory();
  const trainingRec = loadTrainingRecommendation();
  const opponentScout = loadOpponentScout();
  const basePrompt = buildWeeklyDashboardPrompt(snap, history, trainingRec, opponentScout);
  return `## Hattrick Weekly Dashboard\n\n${basePrompt}\n\nAfter analysis, call saveWeeklyDashboard({ rawReport: <your report> }) to persist.`;
}

export function buildAutonomousBidBrief(signal) {
  const snap = loadSnapshot();
  const watchlist = loadTransferWatchlist();
  const bidPatterns = getDecisionPatterns('bid');

  const players = snap?.players || [];
  const positionGaps = identifyPositionGaps(players);

  // Pre-compute financial limits from last known economy
  const economy = getState('hattrick-economy') || {};
  const cash = economy.cash ?? 3_000_000;
  const weeklyNet = (economy.weeklyIncome ?? 500_000) - (economy.weeklyExpenses ?? 0);
  const maxBid = Math.floor(cash * 0.30);
  const cashFloor = 300_000;
  const effectiveMaxBid = Math.min(maxBid, cash - cashFloor);

  const insightBlock = bidPatterns.patterns.length
    ? `\n### Historical Bid Insights:\n${bidPatterns.patterns.join('\n')}`
    : '';

  const gapBlock = positionGaps.length
    ? positionGaps.map(g => `- ${g.position}: current best skill ${g.bestSkill}, need ${g.targetSkill}+`).join('\n')
    : '- No critical gaps identified';

  const watchlistItems = (watchlist?.items || []).slice(0, 5);
  const watchlistBlock = watchlistItems.length
    ? watchlistItems.map(p => {
        const est = estimatePlayerValue(p);
        const hardCap = Math.round(est * 1.1);
        return `- ${p.name || '?'}: ${p.position || '?'}, skill ${p.skill || '?'}, est. value ${est.toLocaleString()} NIS, HARD CAP ${hardCap.toLocaleString()} NIS`;
      }).join('\n')
    : '(empty)';

  const activeBids = loadActiveBids();
  const activeBidsBlock = activeBids.length
    ? activeBids.map(b => `- ${b.playerName} (ID: ${b.playerId || '?'}): bid ${(b.bidAmount || 0).toLocaleString()} NIS, deadline ${b.deadlineMs ? new Date(b.deadlineMs).toLocaleTimeString() : '?'}`).join('\n')
    : '(none)';

  // Build a hard block list of player IDs/names we already bid on
  const blockedPlayers = activeBids.map(b => b.playerName || b.playerId).filter(Boolean);
  const blockWarning = blockedPlayers.length
    ? `\n### ⛔ BLOCKED PLAYERS (already have active bids — DO NOT BID on these):\n${blockedPlayers.map(p => `- ${p}`).join('\n')}\nThe system will REJECT any duplicate bid via trackActiveBid(). Do not waste a bid cycle on these.\n`
    : '';

  return `## Hattrick Autonomous Bid Check

### 💰 PRE-COMPUTED FINANCIAL LIMITS (from last economy snapshot):
- **Cash on hand:** ${cash.toLocaleString()} NIS
- **MAX SINGLE BID:** ${effectiveMaxBid.toLocaleString()} NIS (30% of cash, with 300K reserve)
- **CASH FLOOR:** ${cashFloor.toLocaleString()} NIS (must remain after bid)
- Any bid above ${effectiveMaxBid.toLocaleString()} NIS will be flagged as a VIOLATION.
- Refresh cash via hattrick_get_economy first — these are last-known values.

### Squad Gaps (code-computed):
${gapBlock}
${insightBlock}

### Active Bids:
${activeBidsBlock}
${blockWarning}
### Transfer Watchlist (with hard caps):
${watchlistBlock}
- HARD CAP = 110% of estimated value. NEVER bid above a player's hard cap.

### BIDDING RULES (CRITICAL — NEVER VIOLATE):
1. Use hattrick_get_economy to get CURRENT cash (the values above may be stale)
2. Use hattrick_scrape on ${`https://www.hattrick.org/en/World/Transfers/TransfersSearchResult.aspx?showTransfersFromSimilarTeams=1`} to find candidates
3. For each candidate, extract: current highest bid, whether we are already leading
4. If we are already leading → DO NOT BID (skip this player)
5. If the player is in the BLOCKED PLAYERS list above → DO NOT BID (we already have an active bid)
6. Compute bid: bidAmount = currentHighestBid + 1000. EXACTLY. Nothing more.
7. Verify: bidAmount <= ${effectiveMaxBid.toLocaleString()} NIS AND bidAmount <= HARD CAP for that player
8. If checks pass → place bid with hattrick_action at EXACTLY bidAmount
9. After placing: call trackActiveBid({ playerName, playerId, position, skill, age, wage, bidAmount, currentHighestBid, deadlineMs })
   IMPORTANT: include currentHighestBid (the bid BEFORE yours) — this is logged for audit.
10. Log: logDecision({ type: 'bid', details: { playerName, skill, age, bidAmount, currentHighestBid } })

### BID AMOUNT RULE (MOST IMPORTANT):
- Your bid = currentHighestBid + 1,000 NIS. EXACTLY. No exceptions.
- NEVER bid your "estimate" of what a player is worth.
- NEVER bid a round number like 100K, 200K, 250K unless that equals currentHighestBid + 1000.
- NEVER skip ahead to a "fair value" or "market value".
- NEVER exceed the HARD CAP shown in the watchlist above.
- NEVER exceed MAX SINGLE BID (${effectiveMaxBid.toLocaleString()} NIS).
- If outbid later, the next cycle will re-bid at their bid + 1000. This is by design.

### Other Rules:
- MAX ONE bid per cycle
- If already leading an auction, do NOT raise your own bid
- If MCP tools fail: report "Bid cycle skipped" — do NOT bid on stale data
- After placing a bid, verify it registered. Do NOT retry (double-bid risk).`;
}

export function buildSellReviewBrief(signal) {
  const snap = loadSnapshot();
  const basePrompt = buildSellReleasePrompt(snap?.players || [], {});
  return `## Hattrick Sell/Release Review\n\n${basePrompt}\n\nDo NOT recommend sells or releases if MCP tools are failing. Stale data can lead to selling the wrong player. Report "Sell review skipped — MCP tools unavailable" if tools fail.\nAfter listing a player, verify the listing is active. Do NOT retry failed listings (risk of duplicates).`;
}

/**
 * buildBidFinancialCheck — ms_2: Smart bid/sell logic with financial validation.
 *
 * Before placing any bid, run this check to ensure the purchase is financially sound.
 * Rules (from hattrick-strategy.json transfer_budget):
 *   - Max bid ≤ 30% of current cash
 *   - New player wage ≤ 15% of weekly net profit
 *   - Cash after purchase must remain ≥ min_cash_reserve (300K NIS)
 *   - Weekly balance must remain positive after adding new wage
 *
 * @param {object} params
 * @param {number} params.bidAmount       - Proposed bid in NIS
 * @param {number} params.playerWeeklySalary - Estimated weekly wage of target player
 * @param {number} params.currentCash     - Current club cash in NIS
 * @param {number} params.weeklyNetProfit - Weekly net profit (income - expenses) in NIS
 * @param {number} [params.currentWageBill] - Current total weekly wage bill (optional, for context)
 * @returns {{ canBid: boolean, reason: string, details: object }}
 */
export function buildBidFinancialCheck({ bidAmount, playerWeeklySalary, currentCash, weeklyNetProfit, currentWageBill = 0 }) {
  const strategy = (() => {
    try {
      return JSON.parse(readFileSync(join(config.dataDir, 'hattrick-strategy.json'), 'utf8'));
    } catch { return {}; }
  })();

  const budget = strategy.transfer_budget || {};
  const maxBidPct       = budget.max_bid_pct_of_cash   ?? 0.30;
  const maxWagePct      = budget.max_wage_pct_of_profit ?? 0.15;
  const minCashReserve  = budget.min_cash_reserve       ?? (strategy.economy?.min_cash_reserve ?? 300000);

  const maxBid         = Math.floor(currentCash * maxBidPct);
  const maxWage        = Math.floor(weeklyNetProfit * maxWagePct);
  const cashAfter      = currentCash - bidAmount;
  const netAfterWage   = weeklyNetProfit - playerWeeklySalary;

  const checks = [
    {
      name: 'bid_vs_cash',
      pass: bidAmount <= maxBid,
      msg: `Bid ${bidAmount.toLocaleString()} NIS ${bidAmount <= maxBid ? '✅' : '❌'} (max ${maxBidPct * 100}% of cash = ${maxBid.toLocaleString()} NIS)`,
    },
    {
      name: 'cash_reserve',
      pass: cashAfter >= minCashReserve,
      msg: `Cash after purchase: ${cashAfter.toLocaleString()} NIS ${cashAfter >= minCashReserve ? '✅' : '❌'} (min reserve ${minCashReserve.toLocaleString()} NIS)`,
    },
    {
      name: 'wage_vs_profit',
      pass: playerWeeklySalary <= maxWage,
      msg: `Weekly wage ${playerWeeklySalary.toLocaleString()} NIS ${playerWeeklySalary <= maxWage ? '✅' : '❌'} (max ${maxWagePct * 100}% of profit = ${maxWage.toLocaleString()} NIS)`,
    },
    {
      name: 'positive_weekly_balance',
      pass: netAfterWage > 0,
      msg: `Weekly balance after hire: ${netAfterWage.toLocaleString()} NIS ${netAfterWage > 0 ? '✅' : '❌'}`,
    },
  ];

  const failed = checks.filter(c => !c.pass);
  const canBid = failed.length === 0;

  return {
    canBid,
    reason: canBid
      ? 'All financial checks passed — safe to bid.'
      : `Cannot bid: ${failed.map(c => c.name).join(', ')}`,
    details: {
      bidAmount,
      playerWeeklySalary,
      currentCash,
      weeklyNetProfit,
      maxBid,
      maxWage,
      cashAfter,
      netAfterWage,
      checks,
    },
  };
}

/**
 * formatBidFinancialCheck — formats the result of buildBidFinancialCheck as a markdown string.
 * Use this to include the check result in cron prompts or WhatsApp messages.
 */
export function formatBidFinancialCheck(result) {
  const { canBid, reason, details } = result;
  const lines = [
    `## Financial Bid Check: ${canBid ? '✅ APPROVED' : '❌ BLOCKED'}`,
    `**${reason}**`,
    '',
    ...details.checks.map(c => `- ${c.msg}`),
    '',
    `**Summary:** bid ${details.bidAmount.toLocaleString()} NIS | wage ${details.playerWeeklySalary.toLocaleString()} NIS/wk | cash after ${details.cashAfter.toLocaleString()} NIS | weekly net after ${details.netAfterWage.toLocaleString()} NIS`,
  ];
  return lines.join('\n');
}

// ─── Code-Gated Transfer Intelligence ─────────────────────────────────────

/**
 * estimatePlayerValue — code-based player valuation using skill/age/position.
 * Returns estimated market value in NIS (conservative estimate).
 *
 * @param {object} player - { skill|mainSkill, age, position }
 * @returns {number} estimated value in NIS
 */
export function estimatePlayerValue(player) {
  const SKILL_BASE = {
    1: 500, 2: 1500, 3: 5000, 4: 15000, 5: 40000,
    6: 100000, 7: 250000, 8: 600000, 9: 1500000, 10: 4000000,
  };

  const skill = player.skill || player.mainSkill || 5;
  const age = player.age || 25;
  const base = SKILL_BASE[Math.min(Math.max(skill, 1), 10)] || 40000;

  let ageMult = 1.0;
  if (age <= 19) ageMult = 1.3;
  else if (age <= 23) ageMult = 1.15;
  else if (age <= 26) ageMult = 1.0;
  else if (age <= 28) ageMult = 0.7;
  else if (age <= 30) ageMult = 0.4;
  else ageMult = 0.2;

  const normPos = normalizePosition(player.position);
  const scarcity = normPos === 'GK' ? 1.2
    : normPos === 'CB' ? 1.1
    : 1.0;

  return Math.round(base * ageMult * scarcity);
}

/**
 * computeBidAmount — optimal bid calculator with time-aware strategy.
 * Returns the exact NIS amount to bid, or 0 if should not bid.
 *
 * @param {object} player - player info (for logging)
 * @param {object} auctionState - { currentHighestBid, minutesRemaining, bidderCount, weAreLeading }
 * @param {number} estimatedValue - from estimatePlayerValue()
 * @returns {number} bid amount in NIS, or 0
 */
export function computeBidAmount(player, auctionState, estimatedValue) {
  const { currentHighestBid = 0, minutesRemaining = Infinity, bidderCount = 0, weAreLeading = false } = auctionState;
  const MIN_INCREMENT = 1000;

  if (weAreLeading) return 0;

  const hardCap = Math.round(estimatedValue * 1.1);

  let bidAmount;
  if (minutesRemaining <= 30) {
    bidAmount = currentHighestBid + MIN_INCREMENT;
  } else if (minutesRemaining <= 120) {
    bidAmount = currentHighestBid + Math.min(5000, MIN_INCREMENT * 3);
  } else if (bidderCount >= 5) {
    bidAmount = Math.round(currentHighestBid * 1.05);
  } else {
    bidAmount = currentHighestBid + MIN_INCREMENT;
  }

  if (bidAmount > hardCap) return 0;
  return Math.max(bidAmount, currentHighestBid + MIN_INCREMENT);
}

/**
 * validateBidDecision — multi-layer validation before placing any bid.
 * Combines financial + value + squad need + concentration checks.
 *
 * @param {number} bidAmount - proposed bid in NIS
 * @param {object} player - { skill|mainSkill, age, position, wage|weeklyWage }
 * @param {object} snapshot - from loadSnapshot()
 * @param {object} economy - { cash, weeklyIncome, weeklyExpenses }
 * @returns {{ approved: boolean, reasons: string[], estimatedValue: number }}
 */
export function validateBidDecision(bidAmount, player, snapshot, economy = {}) {
  const reasons = [];
  const estimated = estimatePlayerValue(player);

  const cash = economy.cash ?? 3_000_000;
  const weeklyNet = (economy.weeklyIncome ?? 500_000) - (economy.weeklyExpenses ?? 0);
  const financial = buildBidFinancialCheck({
    bidAmount,
    playerWeeklySalary: player.wage || player.weeklyWage || 5000,
    currentCash: cash,
    weeklyNetProfit: weeklyNet,
  });
  if (!financial.canBid) reasons.push(`Financial: ${financial.reason}`);

  if (bidAmount > estimated * 1.1) {
    reasons.push(`Value: bid ${bidAmount.toLocaleString()} exceeds 110% of estimated value ${estimated.toLocaleString()}`);
  }

  const players = snapshot?.players || [];
  const targetPos = normalizePosition(player.position);
  const posPlayers = targetPos
    ? players.filter(p => normalizePosition(p.position) === targetPos)
    : [];
  const bestExisting = Math.max(...posPlayers.map(p => p.skill || p.mainSkill || 0), 0);
  const targetSkill = player.skill || player.mainSkill || 5;
  if (targetSkill <= bestExisting) {
    reasons.push(`Squad: already have skill ${bestExisting} at ${player.position}, target is only ${targetSkill}`);
  }

  if (bidAmount > cash * 0.3) {
    reasons.push(`Concentration: bid is ${Math.round(bidAmount / cash * 100)}% of cash (max 30%)`);
  }

  return { approved: reasons.length === 0, reasons, estimatedValue: estimated };
}

// ─── Position Gap Detection ───────────────────────────────────────────────

function normalizePosition(pos) {
  if (!pos) return null;
  const p = pos.toLowerCase();
  if (p.includes('keeper') || p.includes('gk') || p.includes('וש')) return 'GK';
  if (p.includes('centre back') || p.includes('cb') || p.includes('לב')) return 'CB';
  if (p.includes('wing back') || p.includes('wb')) return 'WB';
  if (p.includes('midfield') || p.includes('cm') || p.includes('גמ')) return 'CM';
  if (p.includes('winger') || p.includes('wing') || p.includes('יק') || p.includes('שק')) return 'W';
  if (p.includes('forward') || p.includes('fw') || p.includes('לח')) return 'FW';
  return null;
}

function loadSkillHistory() {
  try {
    if (!existsSync(SKILL_HISTORY_PATH)) return [];
    const raw = JSON.parse(readFileSync(SKILL_HISTORY_PATH, 'utf8'));
    // Skill history is stored as { "0": { date, players: [...] }, "1": {...} }
    const entries = Object.values(raw).filter(e => Array.isArray(e?.players));
    if (!entries.length) return [];
    // Return the most recent entry's players
    return entries.sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0].players;
  } catch {
    return [];
  }
}

function identifyPositionGaps(players) {
  const POSITION_TARGETS = { GK: 7, CB: 7, WB: 6, CM: 7, W: 6, FW: 7 };
  // Snapshot players don't carry skill data — use skill history for accurate gaps
  const skillPlayers = loadSkillHistory();
  const posMap = {};
  if (skillPlayers.length > 0) {
    for (const p of skillPlayers) {
      // GK: keeper skill
      if (p.keeper != null) {
        if (!posMap.GK || p.keeper > posMap.GK) posMap.GK = p.keeper;
      }
      // CB: defending skill (non-keeper players)
      if (p.defending != null && (p.keeper == null || p.defending >= p.keeper)) {
        if (!posMap.CB || p.defending > posMap.CB) posMap.CB = p.defending;
      }
      // CM: playmaking
      if (p.playmaking != null) {
        if (!posMap.CM || p.playmaking > posMap.CM) posMap.CM = p.playmaking;
      }
      // W: winger
      if (p.winger != null) {
        if (!posMap.W || p.winger > posMap.W) posMap.W = p.winger;
      }
      // FW: scoring
      if (p.scoring != null) {
        if (!posMap.FW || p.scoring > posMap.FW) posMap.FW = p.scoring;
      }
      // WB: average of defending + winger
      if (p.defending != null && p.winger != null) {
        const wbSkill = Math.round((p.defending + p.winger) / 2);
        if (!posMap.WB || wbSkill > posMap.WB) posMap.WB = wbSkill;
      }
    }
  } else {
    // Fallback: use snapshot players if skill history unavailable
    for (const p of players) {
      const pos = normalizePosition(p.position);
      if (!pos) continue;
      const skill = p.skill || p.mainSkill || 0;
      if (!posMap[pos] || skill > posMap[pos]) posMap[pos] = skill;
    }
  }
  const gaps = [];
  for (const [pos, target] of Object.entries(POSITION_TARGETS)) {
    const best = posMap[pos] || 0;
    if (best < target) gaps.push({ position: pos, bestSkill: best, targetSkill: target, urgency: target - best });
  }
  return gaps.sort((a, b) => b.urgency - a.urgency);
}

// ─── Active Bid Tracking ──────────────────────────────────────────────────

const ACTIVE_BIDS_KEY = 'hattrick-active-bids';

/**
 * Track a newly placed bid.
 * @param {object} bid - { playerId, playerName, position, skill, bidAmount, estimatedValue, deadlineMs }
 */
export function trackActiveBid(bid) {
  const bids = loadActiveBids();

  // Guard: reject if we already have an active bid on this player
  const playerId = bid.playerId || bid.playerName;
  const existing = bids.find(b => (b.playerId && b.playerId === bid.playerId) || (b.playerName && b.playerName === bid.playerName));
  if (existing) {
    log.warn({ player: playerId, existingBid: existing.bidAmount, newBid: bid.bidAmount }, 'DUPLICATE BID BLOCKED — already have active bid on this player');
    logBidAudit('bid_blocked_duplicate', { ...bid, reason: 'already have active bid', existingBidAmount: existing.bidAmount });
    return bids; // return unchanged
  }

  const record = { ...bid, placedAt: Date.now() };
  bids.push(record);
  // Wrap in object — setState does shallow merge which destroys raw arrays
  setState(ACTIVE_BIDS_KEY, { items: bids });
  // Append to bid audit log for forensic tracking
  logBidAudit('bid_placed', record);
  return bids;
}

/**
 * logBidAudit — append to hattrick-bid-audit.jsonl for forensic tracking.
 * Every bid action (placed, won, lost) gets a line with full context.
 */
function logBidAudit(event, data) {
  try {
    const entry = {
      event,
      ts: Date.now(),
      isoTime: new Date().toISOString(),
      playerName: data.playerName || '?',
      playerId: data.playerId || '?',
      position: data.position || '?',
      skill: data.skill || '?',
      age: data.age || '?',
      wage: data.wage || data.salary || '?',
      bidAmount: data.bidAmount || 0,
      currentHighestBid: data.currentHighestBid || null,
      estimatedValue: data.estimatedValue || null,
      deadlineMs: data.deadlineMs || null,
      outcome: data.outcome || null,
    };
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(BID_AUDIT_LOG_PATH, line, 'utf8');
    log.info({ event, player: entry.playerName, bidAmount: entry.bidAmount, currentHighestBid: entry.currentHighestBid }, 'Bid audit logged');
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to write bid audit log');
  }
}

/**
 * validateBidCycleOutput — post-cycle detective control.
 * Scans the LLM reply for bid amounts and flags violations against financial limits.
 *
 * @param {string} replyText - raw LLM reply text
 * @returns {{ violations: Array<{ amount: number, maxBid: number, reason: string }> }}
 */
export function validateBidCycleOutput(replyText) {
  const violations = [];
  const economy = getState('hattrick-economy') || {};
  const cash = economy.cash ?? 3_000_000;
  const maxBid = Math.min(Math.floor(cash * 0.30), cash - 300_000);

  // Extract bid amounts from LLM reply text
  const bidPatterns = [
    /bid(?:Amount)?[\s:=]*?(\d[\d,. ]*\d)/gi,
    /place[d]?\s+(?:a\s+)?bid\s+(?:of\s+)?(\d[\d,. ]*\d)/gi,
    /amount["\s:=]*(\d[\d,. ]*\d)/gi,
  ];
  const amounts = new Set();
  for (const pat of bidPatterns) {
    let m;
    while ((m = pat.exec(replyText)) !== null) {
      const num = parseInt(m[1].replace(/[,.\s]/g, ''), 10);
      if (num >= 1000) amounts.add(num);
    }
  }

  for (const amount of amounts) {
    if (amount > maxBid) {
      violations.push({ amount, maxBid, reason: `Bid ${amount.toLocaleString()} exceeds max ${maxBid.toLocaleString()} (30% of ${cash.toLocaleString()} cash)` });
    }
  }

  if (violations.length > 0) {
    for (const v of violations) {
      logBidAudit('bid_violation', { bidAmount: v.amount, reason: v.reason, maxBid: v.maxBid });
    }
    log.warn({ violations }, 'Bid cycle violations detected');
  }

  return { violations };
}

/**
 * buildBidResolveBrief — brief for resolving expired bids.
 * Fires when active bids have passed their deadline.
 */
export function buildBidResolveBrief(signal) {
  const activeBids = loadActiveBids();
  const now = Date.now();
  const expired = activeBids.filter(b => b.deadlineMs && b.deadlineMs < now);

  if (expired.length === 0) return '## Bid Resolution\n\nNo expired bids to resolve.';

  const bidList = expired.map(b =>
    `- **${b.playerName}** (ID: ${b.playerId || '?'}): bid ${(b.bidAmount || 0).toLocaleString()} NIS, expired ${new Date(b.deadlineMs).toISOString()}`
  ).join('\n');

  return `## Hattrick Bid Resolution

The following bids have expired and need resolution:
${bidList}

### Instructions:
1. For each expired bid, use hattrick_scrape on the player's page to check if they joined our team
2. Check our squad page to confirm: ${getTeamUrl()}
3. For each bid, call: resolveActiveBid(playerName, { won: true/false, finalPrice: <amount or 0> })
4. If won: send a WhatsApp summary with the player name, position, skill, and final price
5. If lost: note the winning price if visible for market learning

IMPORTANT: Resolve ALL expired bids. Do not skip any.`;
}

/**
 * Load all active (non-expired) bids.
 * Prunes bids whose deadline passed >24h ago.
 */
export function loadActiveBids() {
  const raw = getState(ACTIVE_BIDS_KEY);
  // Stored as { items: [...] } to survive setState shallow merge
  const bids = Array.isArray(raw?.items) ? raw.items : (Array.isArray(raw) ? raw : []);
  const now = Date.now();
  return bids.filter(b => !b.deadlineMs || (now - b.deadlineMs) < 24 * 3600_000);
}

/**
 * Resolve a bid (won or lost) and log to decision tracker.
 * @param {string} playerIdOrName
 * @param {object} outcome - { won: bool, finalPrice, reason }
 */
export function resolveActiveBid(playerIdOrName, outcome) {
  const bids = loadActiveBids();
  const idx = bids.findIndex(b =>
    b.playerId === playerIdOrName || b.playerName === playerIdOrName
  );
  if (idx === -1) return null;
  const resolved = bids.splice(idx, 1)[0];
  setState(ACTIVE_BIDS_KEY, { items: bids });

  logBidAudit(outcome.won ? 'bid_won' : 'bid_lost', { ...resolved, outcome });
  logDecision({
    type: 'bid',
    details: { ...resolved, outcome },
    reasoning: `Bid ${outcome.won ? 'WON' : 'LOST'}: ${resolved.playerName} at ${resolved.bidAmount?.toLocaleString()} NIS`,
  });
  return resolved;
}

/**
 * saveOpponentScout — persist opponent analysis to state file.
 * Called by ht-opponent-scout cron after analysis completes.
 */
export function saveOpponentScout(data) {
  const dir = join(config.dataDir, 'state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(OPPONENT_SCOUT_PATH, JSON.stringify({ ...data, scoutedAt: new Date().toISOString() }, null, 2));
}

/**
 * loadOpponentScout — load latest opponent analysis.
 * Returns null if file doesn't exist or is stale (>24h).
 */
export function loadOpponentScout({ maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  try {
    const data = JSON.parse(readFileSync(OPPONENT_SCOUT_PATH, 'utf8'));
    const age = Date.now() - new Date(data.scoutedAt).getTime();
    if (age > maxAgeMs) return null;
    return data;
  } catch { return null; }
}

/**
 * buildOpponentScoutPrompt — ms_3: generate the prompt for ht-opponent-scout cron.
 *
 * @param {{ matchType?: string }} opts
 * @returns {string} prompt string
 */
export function buildOpponentScoutPrompt({ matchType = 'league' } = {}) {
  const teamId = config.hattrickTeamId || '';
  return `You are the Hattrick scouting agent for team the team (ID ${teamId}).

TASK: Scout the upcoming ${matchType} match opponent and save a full analysis report.

STEPS:
1. Use hattrick_get_matches to find the next upcoming ${matchType} match. Extract:
   - matchId, matchDate, round, home/away (are we listed first = home?)
   - opponentName, opponentTeamId

2. Use hattrick_scrape on opponent team page /en/Club/?TeamID={opponentTeamId}
   Extract: league position, fans, confidence, team spirit, coach level.

3. Scrape /en/Club/Players/?TeamID={opponentTeamId} to get their full roster:
   For each player: name, age, TSI, form, stamina, specialty, any injury note.

4. Scrape /en/Club/Matches/?TeamID={opponentTeamId} for last 5 match results.
   Extract: date, opponent, score, result (W/D/L). Identify form streak.

5. ANALYSE:
   a. Strength rating: weak / average / strong (vs V.231 Israel level)
   b. Likely formation (based on roster positions)
   c. Danger players: top 2-3 by TSI + form + specialty
   d. Specialty summary: who has what specialty
   e. Weaknesses: injured players, low fitness, gaps in squad
   f. Recommended formation for the team (per strategy.json: home→3-5-2, away→4-5-1)
   g. Recommended tactic + key individual orders

6. Save the analysis by calling saveOpponentScout() from lib/hattrick.js.
   Data structure: { matchType, matchId, matchDate, round, venue, opponent: {...}, players: [...], analysis: {...}, recommendation: {...} }

7. Return a WhatsApp-ready summary (max 10 lines):
   - Next match: vs [name], [date], [home/away], round [X]
   - Their strength + league position
   - Top danger: [players]
   - Recommended: [formation] + [tactic]
   - ⚠️ Key warnings (max 2)`;
}

// ─── Weekly Dashboard ─────────────────────────────────────────────────────

/**
 * Persist the weekly dashboard snapshot to disk.
 * @param {object} data - { rawReport, generatedAt, weekLabel }
 */
export function saveWeeklyDashboard(data) {
  try {
    mkdirSync(join(config.dataDir, 'state'), { recursive: true });
    const payload = { ...data, savedAt: Date.now() };
    writeFileSync(WEEKLY_DASHBOARD_PATH, JSON.stringify(payload, null, 2), 'utf8');
    log.info({ path: WEEKLY_DASHBOARD_PATH }, 'Weekly dashboard saved');
    return payload;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save weekly dashboard');
    throw err;
  }
}

/**
 * Load the last weekly dashboard.
 * @returns {object|null}
 */
export function loadWeeklyDashboard() {
  try {
    if (!existsSync(WEEKLY_DASHBOARD_PATH)) return null;
    return JSON.parse(readFileSync(WEEKLY_DASHBOARD_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * buildWeeklyDashboardPrompt — ms_5: consolidated weekly team status report.
 *
 * Combines league position, form, squad TSI, training, upcoming match, finances
 * into a single WhatsApp-ready summary the user can read in under 30 seconds.
 *
 * @param {object|null} snapshot       - from loadSnapshot()
 * @param {object[]}    matchHistory   - from loadMatchHistory()
 * @param {object|null} trainingRec    - from loadTrainingRecommendation()
 * @param {object|null} opponentScout  - from loadOpponentScout()
 * @returns {string}
 */
export function buildWeeklyDashboardPrompt(snapshot = null, matchHistory = [], trainingRec = null, opponentScout = null) {
  // Form string from last 5 matches
  const recentMatches = matchHistory.slice(-5);
  const formString = recentMatches.map(m => {
    if (m.result === 'win')  return 'W';
    if (m.result === 'draw') return 'D';
    if (m.result === 'loss') return 'L';
    return '?';
  }).join('') || 'N/A';

  const lastMatch = recentMatches[recentMatches.length - 1];
  const lastMatchStr = lastMatch
    ? `Round ${lastMatch.round}: ${lastMatch.homeTeam} ${lastMatch.homeGoals}-${lastMatch.awayGoals} ${lastMatch.awayTeam}`
    : 'No recent match data';

  // Opponent context
  const opponentCtx = opponentScout
    ? `Next opponent: ${opponentScout.opponent?.name || '?'} — ${opponentScout.analysis?.strengthRating || '?'} strength. Scouted ${new Date(opponentScout.scoutedAt).toLocaleDateString()}.`
    : 'Next opponent not yet scouted.';

  // Training context
  const trainingCtx = trainingRec
    ? `Last training check: ${trainingRec.recommendedTraining || 'see raw'} — "${trainingRec.rationale || ''}"`
    : 'No training recommendation on file.';

  // Squad TSI
  const teamTSI = snapshot?.teamTSI || 'unknown';
  const squadSize = snapshot?.players?.length || 'unknown';

  const weekLabel = new Date().toLocaleDateString('en-IL', { weekday: 'long', month: 'short', day: 'numeric', timeZone: config.timezone });

  return `You are generating the weekly status dashboard for the user's Hattrick team the team (ID: ${config.hattrickTeamId}).
Today is ${weekLabel}. This runs every Monday. the user reads it on WhatsApp — max 15 lines.

## Context from last cycle
- Squad size: ${squadSize} | Team TSI: ${teamTSI}
- Recent form (last 5): ${formString}
- Last match: ${lastMatchStr}
- ${opponentCtx}
- ${trainingCtx}

## Your Task
Fetch fresh data and generate the dashboard:

1. Use hattrick_get_team → league position, team spirit, confidence, fans
2. Use hattrick_get_players → squad health (injuries/suspensions), lowest-skilled positions, top 3 players by TSI
3. Use hattrick_get_matches → next match date/opponent/venue + last 3 results
4. Use hattrick_get_economy → cash balance, weekly net profit, wages
5. Use hattrick_get_training → current training type + stamina share

## Dashboard Format (WhatsApp, max 15 lines)
\`\`\`
📊 the team Weekly — [date]

🏆 League: [position]/[total] | Spirit: [X] | Confidence: [X]
⚽ Form: [WWDLL] | Last: [score vs opponent]
👥 Squad: [N] fit | ⚠️ [injuries/suspensions if any]
💪 Best: [top player, TSI X] | Weakest: [position]
🏋️ Training: [type] [intensity]% | Stamina [X]%
💰 Cash: [X] NIS | Weekly +[X] NIS
📅 Next: vs [opponent] [date] ([home/away])
🎯 Action: [1 most important thing to do this week]
\`\`\`

After generating, call saveWeeklyDashboard({ rawReport: <full text>, weekLabel: '<date string>' }).`;
}

// ─── Formation Scorer (goal dffc3a77, ms_1) ───────────────────────────────

/**
 * Hattrick skill weights per position role.
 * Primary skill is the dominant factor; secondary skills add minor bonus.
 */
const ROLE_SKILL_WEIGHTS = {
  GK:  { goalkeeping: 1.0 },
  DEF: { defending: 1.0, playmaking: 0.2 },
  MID: { playmaking: 1.0, defending: 0.15, passing: 0.15 },
  ATT: { scoring: 1.0, passing: 0.2 },
  WIN: { winger: 1.0, passing: 0.2, scoring: 0.1 },
};

/**
 * Parse a formation string like "4-4-2" into role slots.
 * Always adds 1 GK. Wingers are inferred when midfield slots > 3.
 *
 * @param {string} formation - e.g. "3-5-2", "4-4-2", "4-5-1"
 * @returns {{ GK: number, DEF: number, MID: number, ATT: number, WIN: number }}
 */
export function parseFormation(formation) {
  const parts = String(formation).split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid formation: ${formation}`);
  }
  const [def, mid, att] = parts;
  // Wingers: if mid >= 5, assume 2 wide midfielders become wingers
  const wingers = mid >= 5 ? 2 : 0;
  const centralMid = mid - wingers;
  return { GK: 1, DEF: def, MID: centralMid, WIN: wingers, ATT: att };
}

/**
 * Score a single player for a given role using ROLE_SKILL_WEIGHTS.
 *
 * @param {object} player - e.g. { goalkeeping: 6, defending: 3, ... }
 * @param {string} role   - 'GK' | 'DEF' | 'MID' | 'ATT' | 'WIN'
 * @returns {number}
 */
export function scorePlayerForRole(player, role) {
  const weights = ROLE_SKILL_WEIGHTS[role] || {};
  return Object.entries(weights).reduce((sum, [skill, weight]) => {
    return sum + (player[skill] || 0) * weight;
  }, 0);
}

/**
 * Assign best available players to formation slots using greedy matching.
 * Returns { lineup, totalScore, positionScores }.
 *
 * @param {object[]} players   - squad from snapshot, each with skill fields
 * @param {string}   formation - e.g. "3-5-2"
 * @returns {{ lineup: object[], totalScore: number, formation: string }}
 */
export function scoreFormation(players, formation) {
  const slots = parseFormation(formation);
  const available = [...players];
  const lineup = [];
  let totalScore = 0;

  for (const [role, count] of Object.entries(slots)) {
    for (let i = 0; i < count; i++) {
      if (!available.length) break;
      // Find best available player for this role
      let bestIdx = 0;
      let bestScore = -Infinity;
      available.forEach((p, idx) => {
        const s = scorePlayerForRole(p, role);
        if (s > bestScore) { bestScore = s; bestIdx = idx; }
      });
      const chosen = available.splice(bestIdx, 1)[0];
      lineup.push({ ...chosen, assignedRole: role, roleScore: Math.round(bestScore * 10) / 10 });
      totalScore += bestScore;
    }
  }

  return {
    formation,
    lineup,
    totalScore: Math.round(totalScore * 10) / 10,
    slots,
  };
}

/**
 * Rank a list of formations by total score given the current squad.
 * Returns formations sorted best → worst.
 *
 * @param {object[]} players    - squad from snapshot
 * @param {string[]} [formations] - defaults to standard the team options
 * @returns {object[]} sorted array of { formation, totalScore, lineup }
 */
export function rankFormations(players, formations = ['3-5-2', '4-4-2', '4-5-1', '4-3-3', '5-3-2']) {
  return formations
    .map(f => scoreFormation(players, f))
    .sort((a, b) => b.totalScore - a.totalScore);
}

// ─── Player TSI Trend Tracking (goal dffc3a77, ms_2) ──────────────────────

const TSI_HISTORY_PATH = join(config.dataDir, 'state', 'hattrick-tsi-history.json');

/**
 * Append current TSI snapshot for each player to the TSI history file.
 * Call this whenever a new snapshot is saved.
 *
 * @param {object[]} players - from snapshot.players
 */
export function appendTsiSnapshot(players = []) {
  try {
    mkdirSync(join(config.dataDir, 'state'), { recursive: true });
    let history = {};
    if (existsSync(TSI_HISTORY_PATH)) {
      history = JSON.parse(readFileSync(TSI_HISTORY_PATH, 'utf8'));
    }
    const ts = Date.now();
    for (const p of players) {
      if (!p.name || p.tsi == null) continue;
      if (!history[p.name]) history[p.name] = [];
      history[p.name].push({ ts, tsi: p.tsi, age: p.age });
      // Keep last 20 data points per player
      if (history[p.name].length > 20) history[p.name].shift();
    }
    writeFileSync(TSI_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
    log.info({ players: players.length }, 'TSI snapshot appended');
    return history;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to append TSI snapshot');
    return {};
  }
}

/**
 * Load the TSI history for all players.
 * @returns {object} { playerName: [{ ts, tsi, age }, ...] }
 */
export function loadTsiHistory() {
  try {
    if (!existsSync(TSI_HISTORY_PATH)) return {};
    return JSON.parse(readFileSync(TSI_HISTORY_PATH, 'utf8'));
  } catch { return {}; }
}

/**
 * Compute TSI trend for each player: delta over last N data points.
 * Returns array sorted by trend desc (most improved first).
 *
 * @param {number} [points=3] - how many recent snapshots to compare
 * @returns {object[]} [{ name, currentTsi, trendDelta, trendPct, dataPoints }]
 */
export function getTsiTrends(points = 3) {
  const history = loadTsiHistory();
  return Object.entries(history)
    .map(([name, entries]) => {
      if (entries.length < 2) return { name, currentTsi: entries[0]?.tsi ?? 0, trendDelta: 0, trendPct: 0, dataPoints: entries.length };
      const recent = entries.slice(-Math.max(points, 2));
      const oldest = recent[0].tsi;
      const newest = recent[recent.length - 1].tsi;
      const trendDelta = newest - oldest;
      const trendPct   = oldest > 0 ? Math.round((trendDelta / oldest) * 100) : 0;
      return { name, currentTsi: newest, trendDelta, trendPct, dataPoints: entries.length };
    })
    .sort((a, b) => b.trendDelta - a.trendDelta);
}

// ─── Budget Forecast (goal dffc3a77, ms_3) ───────────────────────────────

/**
 * Build a 4-week cash flow forecast given current economy and planned transfers.
 *
 * @param {object}   economy       - { cash, weeklyIncome, weeklyExpenses, wageTotal }
 * @param {object[]} transferPlans - [{ label, bidAmount, weeklyWage, type: 'buy'|'sell' }]
 * @returns {object} { weeks: object[], finalCash, safe: boolean, warnings: string[] }
 */
export function buildBudgetForecast(economy = {}, transferPlans = []) {
  const { cash = 0, weeklyIncome = 0, weeklyExpenses = 0 } = economy;
  const weeklyNet = weeklyIncome - weeklyExpenses;

  // Compute incremental wage impact from planned transfers
  const wageDelta = transferPlans.reduce((sum, t) => {
    if (t.type === 'buy')  return sum + (t.weeklyWage || 0);
    if (t.type === 'sell') return sum - (t.weeklyWage || 0);
    return sum;
  }, 0);
  const adjustedWeeklyNet = weeklyNet - wageDelta;

  // One-time costs: buy bids are paid immediately, sell proceeds arrive week 1
  const immediateOutflow = transferPlans
    .filter(t => t.type === 'buy')
    .reduce((s, t) => s + (t.bidAmount || 0), 0);
  const immediateInflow = transferPlans
    .filter(t => t.type === 'sell')
    .reduce((s, t) => s + (t.bidAmount || 0), 0);

  let runningCash = cash - immediateOutflow + immediateInflow;
  const warnings = [];
  const weeks = [];

  for (let w = 1; w <= 4; w++) {
    runningCash += adjustedWeeklyNet;
    weeks.push({ week: w, cashEnd: Math.round(runningCash), weeklyNet: Math.round(adjustedWeeklyNet) });
    if (runningCash < 500_000) warnings.push(`Week ${w}: cash drops to ${runningCash.toLocaleString()} NIS — dangerously low`);
  }

  const safe = warnings.length === 0 && runningCash > 500_000;
  return { weeks, finalCash: Math.round(runningCash), safe, warnings, immediateOutflow, immediateInflow, adjustedWeeklyNet: Math.round(adjustedWeeklyNet) };
}

/**
 * Format buildBudgetForecast() result as markdown for WhatsApp.
 */
export function formatBudgetForecast(forecast) {
  const lines = [
    `## 4-Week Budget Forecast`,
    `**Start:** ${(forecast.weeks[0]?.cashEnd - forecast.adjustedWeeklyNet).toLocaleString()} NIS | **Weekly net:** ${forecast.adjustedWeeklyNet.toLocaleString()} NIS`,
    '',
    ...forecast.weeks.map(w => `- Week ${w.week}: ${w.cashEnd.toLocaleString()} NIS`),
    '',
    `**Final cash:** ${forecast.finalCash.toLocaleString()} NIS — ${forecast.safe ? '✅ Safe' : '⚠️ Risk'}`,
    ...forecast.warnings.map(w => `⚠️ ${w}`),
  ];
  return lines.join('\n');
}

// ─── Sell / Release Logic (goal dffc3a77, ms_5) ───────────────────────────

/**
 * Build a prompt to identify players to sell or release.
 *
 * @param {object[]} players   - from snapshot.players
 * @param {object}   economy   - { cash, weeklyExpenses, wageTotal }
 * @returns {string}
 */
export function buildSellReleasePrompt(players = [], economy = {}) {
  const tsiTrends = getTsiTrends(3);
  const decliningPlayers = tsiTrends.filter(p => p.trendDelta < -100).slice(0, 5);

  const squadStr = players.slice(0, 20).map(p =>
    `${p.name || '?'} | ${p.position || '?'} | age ${p.age || '?'} | TSI ${p.tsi || '?'} | wage ${(p.wage || 0).toLocaleString()} NIS`
  ).join('\n');

  const decliningStr = decliningPlayers.length
    ? decliningPlayers.map(p => `${p.name}: TSI ${p.trendDelta > 0 ? '+' : ''}${p.trendDelta} over last snapshots`).join('\n')
    : 'None detected yet';

  return `You are the the team squad manager. Identify players to SELL on transfer market or RELEASE (fire).

## Squad (${players.length} players)
${squadStr}

## Declining Players (TSI trend)
${decliningStr}

## Sell/Release Criteria
- **Sell**: age ≥ 28 AND skill ≤ 6 AND TSI declining → list on transfer market
- **Release**: age ≥ 30 OR (skill ≤ 4 AND wage > 3,000 NIS) → fire to reduce wage bill
- **Keep**: any player under 24 with TSI trending up — future investment

## Current wages
Weekly expenses: ${(economy.weeklyExpenses || 0).toLocaleString()} NIS

## Task
1. Use hattrick_get_players for latest squad data
2. Identify top 3 candidates to sell (name, age, skill, wage, estimated market value)
3. Identify up to 2 candidates to release (name, reason, wage saving)
4. For sells: use hattrick_action to list them on transfer market if the user approves
5. Report: total wage saving if all are removed

⚠️ Do NOT sell or release without listing them first. Report recommendations to the user before acting.`;
}

// ─── Squad Cleanup: Action Releases & Listings (goal 11fecc03, ms_2) ────────

const SQUAD_CLEANUP_PLAN_PATH = join(config.dataDir, 'state', 'hattrick-squad-cleanup-plan.json');

/**
 * Identify confirmed deadweight players from the current snapshot.
 * Criteria (any one triggers): age ≥ 33, age ≥ 30 AND TSI < 600,
 * age ≥ 28 AND TSI < 400, or last rating ≤ 2.0 AND TSI < 600.
 *
 * @param {object[]} players - from snapshot.players
 * @returns {{ release: object[], sell: object[] }}
 */
export function identifySquadDeadweight(players = []) {
  const release = [];
  const sell = [];

  for (const p of players) {
    const age = p.age || 0;
    const tsi = p.tsi || 0;
    const wage = p.wage || 0;
    const rating = p.lastMatchRating;
    const estimatedValue = estimatePlayerValue(p);

    const isAgingPlayer      = age >= 30;                            // criteria 1: age 30+
    const isLowTsi           = age >= 28 && tsi < 600;               // criteria 2: TSI <600 (age ≥28)
    const isPoorPerformer    = rating !== null && rating < 2.5 && age >= 24; // criteria 3: rating <2.5 consistently (exclude youth)

    if (isAgingPlayer || isLowTsi || isPoorPerformer) {
      const candidate = {
        name: p.name,
        id: p.id,
        age,
        tsi,
        wage,
        estimatedValue,
        lastMatchPosition: p.lastMatchPosition || null,
        reason: isAgingPlayer
          ? `Age ${age} ≥ 30 — declining years, TSI ${tsi}`
          : isLowTsi
            ? `TSI ${tsi} <600 (age ${age}) — low form`
            : `Rating ${rating} <2.5 consistently (age ${age})`,
      };

      if (estimatedValue < 30000) {
        release.push(candidate);
      } else {
        sell.push(candidate);
      }
    }
  }

  return { release, sell };
}

/**
 * Build a structured brief for executing squad cleanup actions.
 * Lists each confirmed deadweight player with explicit hattrick_action steps.
 * Saves the plan to data/state/hattrick-squad-cleanup-plan.json for audit.
 *
 * @param {object} _signal - from detectHattrickSignals (unused directly)
 * @returns {string} brief for agent loop
 */
export function buildSquadCleanupBrief(_signal) {
  const snap = loadSnapshot();
  const players = snap?.players || [];
  const teamId = config.hattrickTeamId;

  if (players.length === 0) {
    return '## Squad Cleanup Skipped\nNo snapshot available — use hattrick_get_players first to load squad data.';
  }

  const { release, sell } = identifySquadDeadweight(players);

  if (release.length === 0 && sell.length === 0) {
    return '## Squad Cleanup: No Action Needed\nNo confirmed deadweight found (age≥30+TSI<600, age≥33, or rating≤2.0+TSI<600 criteria not met).';
  }

  // Save plan for audit trail
  try {
    mkdirSync(join(config.dataDir, 'state'), { recursive: true });
    writeFileSync(SQUAD_CLEANUP_PLAN_PATH, JSON.stringify({
      plannedAt: Date.now(),
      release,
      sell,
      squadSize: players.length,
    }, null, 2), 'utf8');
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to save squad cleanup plan');
  }

  const totalWageSaving = [...release, ...sell].reduce((s, p) => s + (p.wage || 0), 0);
  const transferIncome  = sell.reduce((s, p) => s + (p.estimatedValue || 0), 0);

  let brief = `## Hattrick Squad Cleanup — Action Required
**Goal:** Squad Rejuvenation (11fecc03 ms_2)

Confirmed deadweight: **${release.length} to release** + **${sell.length} to sell**
Projected weekly wage saving: **${totalWageSaving.toLocaleString()} NIS/week**
Estimated transfer income: **~${Math.round(transferIncome / 1000)}K NIS**

---
`;

  if (release.length > 0) {
    brief += `### 🔴 RELEASE (Fire) — No Market Value\n`;
    brief += `These players have no realistic transfer value. Release them immediately to cut wages.\n\n`;
    for (const p of release) {
      brief += `**${p.name}** (age ${p.age}, TSI ${p.tsi}, ${(p.wage || 0).toLocaleString()} NIS/wk)\n`;
      brief += `  Reason: ${p.reason}\n`;
      brief += `  Player URL: https://www.hattrick.org/en/Club/Players/Player.aspx?playerID=${p.id}&teamID=${teamId}\n`;
      brief += `  → Use hattrick_action: navigate to player profile → click "Release Player"\n\n`;
    }
  }

  if (sell.length > 0) {
    brief += `### 💰 SELL — List on Transfer Market\n`;
    brief += `These players still have market value. List them before they decline further.\n\n`;
    for (const p of sell) {
      const askingPrice = Math.round(p.estimatedValue * 1.1 / 1000) * 1000;
      brief += `**${p.name}** (age ${p.age}, TSI ${p.tsi}, ${(p.wage || 0).toLocaleString()} NIS/wk)\n`;
      brief += `  Reason: ${p.reason}\n`;
      brief += `  Estimated value: ~${Math.round(p.estimatedValue / 1000)}K NIS → Asking price: **${askingPrice.toLocaleString()} NIS**\n`;
      brief += `  Player URL: https://www.hattrick.org/en/Club/Players/Player.aspx?playerID=${p.id}&teamID=${teamId}\n`;
      brief += `  → Use hattrick_action: navigate to player profile → list on transfer market at ${askingPrice.toLocaleString()} NIS\n\n`;
    }
  }

  brief += `---
### ⚠️ Safety Rules
1. Run hattrick_get_players first — confirm players are NOT in the active lineup before acting
2. Do NOT release/list a player scheduled to play in the next match (2026-02-28 vs Macabee Tel Aviv)
3. Verify each action succeeded before moving to the next (do NOT retry on failure — duplicate listing risk)
4. If hattrick_action fails: stop, report which players were processed, notify user
5. After all actions: send a WhatsApp summary with total savings and players removed`;

  return brief;
}

// ─── League Position Tracker (goal dffc3a77, ms_5) ────────────────────────

const LEAGUE_HISTORY_PATH = join(config.dataDir, 'state', 'hattrick-league-history.json');

/**
 * Append current league position snapshot.
 * Call after each post-match review or economy check.
 *
 * @param {{ position: number, totalTeams: number, points: number, round: number }} data
 */
export function appendLeagueSnapshot(data) {
  try {
    mkdirSync(join(config.dataDir, 'state'), { recursive: true });
    let history = [];
    if (existsSync(LEAGUE_HISTORY_PATH)) {
      history = JSON.parse(readFileSync(LEAGUE_HISTORY_PATH, 'utf8'));
    }
    history.push({ ...data, ts: Date.now() });
    if (history.length > 50) history.shift();
    writeFileSync(LEAGUE_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
    return history;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to append league snapshot');
    return [];
  }
}

/**
 * Load league history.
 * @returns {object[]}
 */
export function loadLeagueHistory() {
  try {
    if (!existsSync(LEAGUE_HISTORY_PATH)) return [];
    return JSON.parse(readFileSync(LEAGUE_HISTORY_PATH, 'utf8'));
  } catch { return []; }
}

/**
 * Detect relegation/promotion risk from league history.
 * Returns { trend, risk, positionDelta, message }
 */
export function getLeagueTrend() {
  const history = loadLeagueHistory();
  if (history.length < 2) return { trend: 'unknown', risk: 'none', positionDelta: 0, message: 'Not enough data' };

  const recent = history.slice(-4);
  const oldest = recent[0].position;
  const newest = recent[recent.length - 1].position;
  const positionDelta = newest - oldest; // positive = dropped (worse), negative = improved

  let trend, risk;
  if (positionDelta >= 3) {
    trend = 'falling'; risk = 'relegation';
  } else if (positionDelta >= 1) {
    trend = 'slipping'; risk = 'medium';
  } else if (positionDelta <= -2) {
    trend = 'rising'; risk = 'none';
  } else {
    trend = 'stable'; risk = 'none';
  }

  return {
    trend,
    risk,
    positionDelta,
    currentPosition: newest,
    message: `Position moved from ${oldest} to ${newest} (${positionDelta > 0 ? '+' : ''}${positionDelta}) over last ${recent.length} snapshots`,
  };
}

// ─── Capability Map & Gap Analysis (goal 8fd4e407, ms_1) ──────────────────

const CAPABILITIES_PATH = join(config.dataDir, 'state', 'hattrick-capabilities.json');

/**
 * Registry of all Hattrick MCP tools and their current availability.
 * Produced by ms_1 of goal 8fd4e407 (Hattrick MCP improvements).
 */
export const HATTRICK_MCP_TOOLS = [
  { name: 'hattrick_login',        available: true,  description: 'Authenticate to hattrick.org via browser automation' },
  { name: 'hattrick_scrape',       available: true,  description: 'Scrape a Hattrick page URL and return text content' },
  { name: 'hattrick_inspect',      available: true,  description: 'Inspect DOM elements on a Hattrick page' },
  { name: 'hattrick_action',       available: true,  description: 'Perform click/form actions (e.g. place bids, set lineup)' },
  { name: 'hattrick_get_team',     available: true,  description: 'Team overview: name, league position, form, cash balance' },
  { name: 'hattrick_get_players',  available: true,  description: 'Full squad list with skills, ratings, TSI, wages, ages' },
  { name: 'hattrick_get_matches',  available: true,  description: 'Upcoming fixtures and recent match results' },
  { name: 'hattrick_get_training', available: true,  description: 'Current training type, intensity, stamina share' },
  { name: 'hattrick_get_economy',  available: true,  description: 'Finances: cash, weekly income, expenses, net weekly profit' },
  { name: 'hattrick_get_league',   available: true,  description: 'League table standings — available but not yet auto-called' },
  { name: 'transfer_search',       available: false, paywallBlocked: true, workaround: '/World/Transfers/TransfersSearchResult.aspx?showTransfersFromSimilarTeams=1', description: 'SearchPlayers requires Supporter subscription — workaround URL exists' },
  { name: 'doctor_page',           available: false, paywallBlocked: true, description: 'Player injury/fitness data — Supporter-only, AccessDenied' },
];

/**
 * Identified automation gaps vs. what the team needs.
 * Each gap maps to a future milestone in goal 8fd4e407.
 * Update availability=true when a gap is addressed.
 */
export const HATTRICK_GAPS = [
  {
    id: 'gap_transfer_workaround',
    priority: 'high',
    addressed: true,
    title: 'Transfer search without Supporter paywall',
    description: 'DONE (Cycle 297): getTransferSearchUrls() now uses /World/Transfers/TransfersSearchResult.aspx?showTransfersFromSimilarTeams=1 — no Supporter required.',
    milestoneSuggestion: 'Update getTransferSearchUrls() to use the non-Supporter workaround URL by default',
  },
  {
    id: 'gap_opponent_scout',
    priority: 'high',
    addressed: true,
    title: 'Opponent scouting before each match',
    description: 'DONE (Cycle ~285): buildOpponentScoutPrompt() + saveOpponentScout() added to hattrick.js. ht-opponent-scout cron added.',
    milestoneSuggestion: 'Verify cron is running and wired into hattrick-cycle.js decision engine',
  },
  {
    id: 'gap_formation_scorer',
    priority: 'high',
    addressed: true,
    title: 'Skill-based formation optimizer',
    description: 'DONE (ms_1 dffc3a77): parseFormation(), scorePlayerForRole(), scoreFormation(), rankFormations() added. Greedy assignment of best players per role using ROLE_SKILL_WEIGHTS.',
    milestoneSuggestion: 'Add scoreFormation(players, formation) to hattrick.js using skill weights per position',
  },
  {
    id: 'gap_player_trends',
    priority: 'medium',
    addressed: true,
    title: 'Player TSI trend tracking',
    description: 'DONE (ms_2 dffc3a77): appendTsiSnapshot(), loadTsiHistory(), getTsiTrends() added. Persists up to 20 TSI snapshots per player in hattrick-tsi-history.json.',
    milestoneSuggestion: 'Append { ts, tsi } per player to match history on each snapshot save',
  },
  {
    id: 'gap_training_optimizer',
    priority: 'medium',
    addressed: true,
    title: 'Automated training recommendations',
    description: 'DONE (ms_4): buildTrainingRecommendationPrompt(snapshot, matchHistory) added. scorePlayerPerformance() ranks players by recent match ratings + TSI trend. training_check cron now uses rich prompt.',
    milestoneSuggestion: 'Add recommendTrainingFocus(snapshot, matchHistory) returning training type + rationale',
  },
  {
    id: 'gap_budget_forecast',
    priority: 'medium',
    addressed: true,
    title: '4-week cash flow forecast',
    description: 'DONE (ms_3 dffc3a77): buildBudgetForecast(economy, transferPlans) + formatBudgetForecast() added. Projects 4-week cash with planned buy/sell wage deltas. Flags weeks below 500K NIS.',
    milestoneSuggestion: 'Add buildBudgetForecast(economy, transferPlans) with 4-week cash projection table',
  },
  {
    id: 'gap_league_tracker',
    priority: 'low',
    addressed: true,
    title: 'League season trend tracker',
    description: 'DONE (ms_5 dffc3a77): appendLeagueSnapshot(), loadLeagueHistory(), getLeagueTrend() added. Detects falling/slipping/rising/stable trend, flags relegation risk after 3+ position drop.',
    milestoneSuggestion: 'Persist league position per cycle, flag when trend shows 3+ positions dropped',
  },
  {
    id: 'gap_weekly_dashboard',
    priority: 'low',
    addressed: true,
    title: 'Weekly team status dashboard',
    description: 'DONE (ms_5): buildWeeklyDashboardPrompt() added to hattrick.js. weekly_dashboard action added to hattrick-cycle.js decision engine (runs Mon, triggers on hattrick-weekly cron). Combines get_team + get_players + get_matches + get_economy + get_training into a single WhatsApp-ready summary.',
    milestoneSuggestion: 'Add weekly_dashboard action to hattrick-cycle.js combining all get_* tools',
  },
];

/**
 * Returns the full capability audit: MCP tools + identified gaps + summary stats.
 * Called by getHattrickCycleStatus() to include in status reports.
 *
 * @returns {{ tools: object[], gaps: object[], summary: object, auditedAt: number }}
 */
export function getCapabilityMap() {
  const available   = HATTRICK_MCP_TOOLS.filter(t => t.available);
  const blocked     = HATTRICK_MCP_TOOLS.filter(t => !t.available);
  const highGaps    = HATTRICK_GAPS.filter(g => g.priority === 'high'   && !g.addressed);
  const medGaps     = HATTRICK_GAPS.filter(g => g.priority === 'medium' && !g.addressed);
  const lowGaps     = HATTRICK_GAPS.filter(g => g.priority === 'low'    && !g.addressed);
  const addressedGaps = HATTRICK_GAPS.filter(g => g.addressed);

  return {
    tools: HATTRICK_MCP_TOOLS,
    gaps: HATTRICK_GAPS,
    summary: {
      toolsAvailable: available.length,
      toolsBlocked: blocked.length,
      gapsTotal: HATTRICK_GAPS.length,
      gapsAddressed: addressedGaps.length,
      gapsHigh: highGaps.length,
      gapsMedium: medGaps.length,
      gapsLow: lowGaps.length,
      nextGapToFix: highGaps[0]?.id || null,
    },
    auditedAt: Date.now(),
  };
}

/**
 * Persist the capability audit to data/state/hattrick-capabilities.json.
 * Called on hattrick-cycle startup so the dashboard and future cycles can read it.
 *
 * @returns {object} the saved audit record
 */
export function saveCapabilityAudit() {
  try {
    mkdirSync(join(config.dataDir, 'state'), { recursive: true });
    const audit = getCapabilityMap();
    writeFileSync(CAPABILITIES_PATH, JSON.stringify(audit, null, 2), 'utf8');
    log.info({ path: CAPABILITIES_PATH, tools: audit.summary.toolsAvailable, gaps: audit.summary.gapsTotal }, 'Hattrick capability audit saved');
    return audit;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save hattrick capability audit');
    throw err;
  }
}


// ─── Player Performance Scoring ──────────────────────────────────────────

/**
 * Score each player by recent match performance and TSI trend.
 * Returns players array sorted by composite score desc.
 *
 * @param {object[]} players - from snapshot.players
 * @param {object[]} matchHistory - from loadMatchHistory()
 * @returns {object[]} sorted player records with .perfScore, .avgRating, .tsiTrend
 */
export function scorePlayerPerformance(players = [], matchHistory = []) {
  // Build rating map: { playerName -> [rating, rating, ...] } from recent 5 matches
  const recentMatches = matchHistory.slice(-5);
  const ratingMap = {};
  for (const match of recentMatches) {
    for (const pr of match.playerRatings || []) {
      if (!ratingMap[pr.name]) ratingMap[pr.name] = [];
      ratingMap[pr.name].push(pr.rating || 0);
    }
  }

  return players.map(p => {
    const ratings = ratingMap[p.name] || [];
    const avgRating = ratings.length
      ? ratings.reduce((a, b) => a + b, 0) / ratings.length
      : null;

    // TSI trend: compare current TSI to last snapshot if available
    const tsiTrend = (p.tsiPrev != null && p.tsi != null)
      ? p.tsi - p.tsiPrev
      : null;

    // Composite score: weighted avg rating (0–10 scale) + tsi growth bonus
    const ratingScore  = avgRating != null ? avgRating * 10 : 50; // default mid
    const tsiBonus     = tsiTrend  != null ? Math.min(Math.max(tsiTrend / 100, -10), 10) : 0;
    const perfScore    = ratingScore + tsiBonus;

    return { ...p, avgRating, tsiTrend, perfScore, ratingsCount: ratings.length };
  }).sort((a, b) => b.perfScore - a.perfScore);
}

// ─── Training Recommendation Persistence ─────────────────────────────────

/**
 * Persist a training recommendation to disk.
 * @param {object} rec - { recommendedTraining, rationale, weakPositions, savedAt }
 */
export function saveTrainingRecommendation(rec) {
  try {
    mkdirSync(join(config.dataDir, 'state'), { recursive: true });
    const payload = { ...rec, savedAt: Date.now() };
    writeFileSync(TRAINING_RECOMMENDATION_PATH, JSON.stringify(payload, null, 2), 'utf8');
    log.info({ path: TRAINING_RECOMMENDATION_PATH }, 'Training recommendation saved');
    return payload;
  } catch (err) {
    log.error({ err: err.message }, 'Failed to save training recommendation');
    throw err;
  }
}

/**
 * Load the last persisted training recommendation.
 * @returns {object|null}
 */
export function loadTrainingRecommendation() {
  try {
    if (!existsSync(TRAINING_RECOMMENDATION_PATH)) return null;
    return JSON.parse(readFileSync(TRAINING_RECOMMENDATION_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// ─── Training Recommendation Prompt ──────────────────────────────────────

/**
 * buildTrainingRecommendationPrompt — ms_4: smart training analysis + recommendations.
 *
 * Analyses current training against squad composition, match history, and strategy.
 * Checks: correct training type, stamina share, coach efficiency, which players
 * are benefiting, upcoming match context, and whether to switch focus.
 *
 * @param {object|null} snapshot      - from loadSnapshot()
 * @param {object[]}    matchHistory  - from loadMatchHistory()
 * @returns {string} prompt for ht-training-check cron
 */
export function buildTrainingRecommendationPrompt(snapshot = null, matchHistory = []) {
  // Build player performance summary
  const players = snapshot?.players || [];
  const scored  = scorePlayerPerformance(players, matchHistory);

  const topPerformers  = scored.slice(0, 3).map(p =>
    `${p.name} (${p.position || '?'}, TSI ${p.tsi || '?'}, rating avg ${p.avgRating?.toFixed(1) ?? 'N/A'})`
  ).join('\n  ') || 'No data yet';

  const weakPerformers = scored.slice(-3).reverse().map(p =>
    `${p.name} (${p.position || '?'}, TSI ${p.tsi || '?'}, rating avg ${p.avgRating?.toFixed(1) ?? 'N/A'})`
  ).join('\n  ') || 'No data yet';

  // Recent match summary
  const recentMatches = matchHistory.slice(-3);
  const matchSummary = recentMatches.length
    ? recentMatches.map(m =>
        `  Round ${m.round || '?'}: ${m.homeTeam || '?'} ${m.homeGoals ?? '?'}-${m.awayGoals ?? '?'} ${m.awayTeam || '?'} (${m.result || '?'})`
      ).join('\n')
    : '  No recent match history available';

  // Squad size and age
  const avgAge = players.length
    ? (players.reduce((s, p) => s + (p.age || 22), 0) / players.length).toFixed(1)
    : 'unknown';

  // Previous recommendation context
  const lastRec = loadTrainingRecommendation();
  const lastRecContext = lastRec
    ? `Previous recommendation (${new Date(lastRec.savedAt).toISOString().slice(0, 10)}): ${lastRec.recommendedTraining || 'unknown'} — "${lastRec.rationale || ''}"`
    : 'No previous recommendation on file.';

  return `You are the training coach for the user's Hattrick team "${snapshot?.teamName || 'the team'}" (ID: ${config.hattrickTeamId}).
Your job: analyze current training, squad weaknesses, and recent performance, then give a concrete recommendation.

## Squad Overview
- Players: ${players.length}, avg age: ${avgAge}
- Top performers (recent):
  ${topPerformers}
- Underperformers / low TSI (recent):
  ${weakPerformers}

## Recent Match History
${matchSummary}

## Context
- ${lastRecContext}
- Team cash: ~3.1M NIS | Weekly profit: ~516K NIS (no financial pressure)
- Next match: Round 12, Feb 28 (HOME) vs Macabee Tel Aviv

## Your Task
1. Use hattrick_get_training to fetch current training type, intensity, and stamina share.
2. Use hattrick_get_players to identify which positions have the weakest skill levels.
3. Analyze: does current training target the weakest area? If not, why not?
4. Identify the 2-3 players who would benefit MOST from a training switch.
5. Give ONE concrete recommendation:
   - Keep current training (with reason), OR
   - Switch to [Training Type] targeting [Position] because [specific reason]
6. Flag if stamina share is suboptimal given upcoming match distance/intensity.
7. Save recommendation using save_training_recommendation({ recommendedTraining, rationale, weakPositions }).

Format: 6-8 lines max. Actionable, specific. the user reads on WhatsApp.`;
}

// ─── Decision Outcome Tracking ─────────────────────────────────────────────

function loadDecisions() {
  try {
    if (!existsSync(DECISIONS_PATH)) return [];
    return JSON.parse(readFileSync(DECISIONS_PATH, 'utf8')) || [];
  } catch { return []; }
}

function saveDecisions(decisions) {
  mkdirSync(join(config.dataDir, 'state'), { recursive: true });
  writeFileSync(DECISIONS_PATH, JSON.stringify(decisions, null, 2), 'utf8');
}

export function logDecision(decision) {
  try {
    const decisions = loadDecisions();
    const record = { id: `d_${Date.now()}`, ...decision, decidedAt: Date.now(), outcome: null, linkedAt: null, lesson: null };
    decisions.push(record);
    while (decisions.length > MAX_DECISIONS) decisions.shift();
    saveDecisions(decisions);
    return record;
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to log decision');
    return null;
  }
}

export function linkOutcome(matchIdOrDecisionId, outcome) {
  try {
    const decisions = loadDecisions();
    let target = decisions.find(d => d.matchId === matchIdOrDecisionId)
      || decisions.find(d => d.id === matchIdOrDecisionId)
      || decisions.find(d => d.type === 'lineup' && String(d.round) === String(matchIdOrDecisionId));
    if (!target || target.outcome) return null;
    target.outcome = outcome;
    target.linkedAt = Date.now();
    if (outcome.lesson) target.lesson = outcome.lesson;
    saveDecisions(decisions);
    try {
      addLearningEntry({ action: `hattrick_${target.type}`, context: target.reasoning || '', outcome: JSON.stringify(outcome), lesson: outcome.lesson || '' });
    } catch {}
    return target;
  } catch (err) {
    log.warn({ err: err.message }, 'Failed to link outcome');
    return null;
  }
}

export function getDecisionPatterns(type = 'all') {
  const patterns = [];
  try {
    const decisions = loadDecisions();
    const linked = decisions.filter(d => d.outcome && (type === 'all' || d.type === type));
    if (linked.length < 2) return { patterns, stats: {} };

    // Lineup patterns
    const lineupD = linked.filter(d => d.type === 'lineup');
    if (lineupD.length >= 2) {
      const fStats = {};
      for (const d of lineupD) {
        const f = d.details?.formation || 'unknown';
        if (!fStats[f]) fStats[f] = { w: 0, d: 0, l: 0, n: 0, ratings: [] };
        fStats[f].n++;
        if (d.outcome.result === 'W') fStats[f].w++; else if (d.outcome.result === 'D') fStats[f].d++; else fStats[f].l++;
        if (d.outcome.avgRating) fStats[f].ratings.push(d.outcome.avgRating);
      }
      for (const [f, s] of Object.entries(fStats)) {
        if (s.n >= 2) {
          const avgR = s.ratings.length ? (s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length).toFixed(1) : '?';
          patterns.push(`${f}: ${s.w}W ${s.d}D ${s.l}L (${Math.round(s.w / s.n * 100)}% win, avg rating ${avgR})`);
        }
      }
      const venue = { home: { w: 0, n: 0 }, away: { w: 0, n: 0 } };
      for (const d of lineupD) {
        const v = d.details?.venue || 'unknown';
        if (venue[v]) { venue[v].n++; if (d.outcome.result === 'W') venue[v].w++; }
      }
      if (venue.home.n >= 2) patterns.push(`Home: ${venue.home.w}/${venue.home.n} wins`);
      if (venue.away.n >= 2) patterns.push(`Away: ${venue.away.w}/${venue.away.n} wins`);
    }

    // Bid patterns
    const bidD = linked.filter(d => d.type === 'bid');
    if (bidD.length >= 2) {
      const won = bidD.filter(d => d.outcome?.success);
      const lost = bidD.filter(d => !d.outcome?.success);
      patterns.push(`Bids won: ${won.length}/${bidD.length}`);
      if (won.length) {
        const avg = Math.round(won.reduce((s, d) => s + (d.details?.bidAmount || 0), 0) / won.length);
        patterns.push(`Avg winning bid: ${avg.toLocaleString()} NIS`);
      }
    }

    // Training patterns
    for (const d of linked.filter(d => d.type === 'training' && d.lesson)) {
      patterns.push(`Training: ${d.lesson}`);
    }

    return { patterns, stats: {} };
  } catch { return { patterns, stats: {} }; }
}

// ─── Weekly Planner ─────────────────────────────────────────────────────────

export function buildWeeklyPlan() {
  if (!isConfigured()) return null;
  const snap = loadSnapshot();
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: config.timezone }));
  const today = now.getDay();
  const htState = getState('hattrick-cycle') || {};
  const watchlist = loadTransferWatchlist();

  const match = snap?.upcomingMatch;
  let matchDate = null, matchDay = -1;
  if (match?.date) {
    try { matchDate = new Date(match.date + 'T' + (match.kickoff || '10:30') + ':00'); matchDay = matchDate.getDay(); } catch {}
  }

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const lines = [];
  const ageH = (ts) => ts ? Math.round((Date.now() - ts) / 3_600_000) : Infinity;

  for (let offset = 0; offset < 7; offset++) {
    const day = (today + offset) % 7;
    const isToday = offset === 0;
    const tasks = [];

    if (day === 0) { tasks.push('Training check', 'Economy check'); }
    if (day === 1) { tasks.push('Weekly dashboard', 'Transfer scan #1'); }
    if (day === 2) { tasks.push('Cup lineup (if cup match)'); }
    if (day === 3) { tasks.push('Friendly scheduling', 'Sell/release review');
      if (matchDay === 6) tasks.push(`Scout opponent for ${match?.opponent || 'Saturday match'}`);
    }
    if (day === 4) { tasks.push('Transfer scan #2', 'Bid decisions'); }
    if (day === 5 && matchDay === 6) { tasks.push(`League lineup by 20:00 (vs ${match?.opponent || '?'}, ${match?.isHome ? 'HOME' : 'AWAY'})`); }
    if (day === 6 && matchDay === 6) { tasks.push(`Match at ${match?.kickoff || '10:30'} vs ${match?.opponent || '?'}`, 'Post-match review by 12:00'); }

    // Non-Saturday match handling
    if (matchDate && matchDay >= 0 && matchDay !== 6) {
      if (day === matchDay) tasks.push(`Match at ${match?.kickoff || '?'} vs ${match?.opponent || '?'}`, 'Post-match review');
      if (day === (matchDay + 6) % 7) tasks.push(`Set lineup for tomorrow's match vs ${match?.opponent || '?'}`);
    }

    // Overdue markers for today only
    const overdue = [];
    if (isToday) {
      if (ageH(htState.lastEconomyCheckAt) > 48) overdue.push('economy (overdue)');
      if (ageH(htState.lastTrainingCheckAt) > 48) overdue.push('training (overdue)');
      if (ageH(htState.lastTransferCheckAt) > 120) overdue.push('transfers (overdue)');
      if (ageH(htState.lastAutonomousBidAt) > 72) overdue.push('bid check (overdue)');
    }

    if (!tasks.length && !overdue.length) continue;
    const marker = isToday ? ' ← TODAY' : '';
    lines.push(`${DAY_NAMES[day]}: ${[...tasks, ...overdue].join(', ')}${marker}`);
  }

  if (!lines.length) return null;

  const watchCount = watchlist?.items?.length || 0;
  const matchLine = match
    ? `Next match: ${match.opponent} (${match.isHome ? 'HOME' : 'AWAY'}) — ${match.date} ${match.kickoff}`
    : 'Next match: unknown (snapshot stale)';
  const watchLine = watchCount > 0 ? `Transfer watchlist: ${watchCount} target(s)` : '';

  return ['## Hattrick Weekly Plan', matchLine, watchLine, '', ...lines].filter(Boolean).join('\n');
}

export default {
  isConfigured,
  getTeamId,
  getTeamUrl,
  getMatchesUrl,
  getPlayersUrl,
  getTrainingUrl,
  getTransferUrl,
  buildMatchAnalysisPrompt,
  getPreMatchScrapeUrls,
  saveSnapshot,
  loadSnapshot,
  isSnapshotStale,
  getScrapeRequest,
  saveAnalysis,
  loadLastAnalysis,
  buildHattrickMatchBrief,
  saveMatchResult,
  loadMatchHistory,
  hasUnreviewedMatch,
  buildPostMatchReviewPrompt,
  buildPostMatchBrief,
  saveTransferWatchlist,
  loadTransferWatchlist,
  getTransferSearchUrls,
  buildTransferSearchPrompt,
  buildTransferMarketBrief,
  saveOpponentScout,
  loadOpponentScout,
  buildOpponentScoutPrompt,
  buildBidFinancialCheck,
  formatBidFinancialCheck,
  HATTRICK_MCP_TOOLS,
  HATTRICK_GAPS,
  getCapabilityMap,
  saveCapabilityAudit,
  buildTrainingRecommendationPrompt,
  scorePlayerPerformance,
  saveTrainingRecommendation,
  loadTrainingRecommendation,
  evaluateTrainingSwitchBack,
  saveWeeklyDashboard,
  loadWeeklyDashboard,
  buildWeeklyDashboardPrompt,
  parseFormation,
  scorePlayerForRole,
  scoreFormation,
  rankFormations,
  appendTsiSnapshot,
  loadTsiHistory,
  getTsiTrends,
  appendSkillHistorySnapshot,
  getTrainingProgressReport,
  buildBudgetForecast,
  formatBudgetForecast,
  buildSellReleasePrompt,
  appendLeagueSnapshot,
  loadLeagueHistory,
  getLeagueTrend,
  BASE,
  logDecision,
  linkOutcome,
  getDecisionPatterns,
  buildWeeklyPlan,
  estimatePlayerValue,
  computeBidAmount,
  validateBidDecision,
  trackActiveBid,
  loadActiveBids,
  resolveActiveBid,
  validateBidCycleOutput,
  buildBidResolveBrief,
};
