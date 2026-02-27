/**
 * modules/hattrick/signals.js — Hattrick signal detectors for agent-loop.
 *
 * Extracted from lib/agent-signals.js. Runs zero-cost (no LLM) every cycle.
 */

import { isConfigured as hattrickConfigured, getTeamId as hattrickTeamId, isSnapshotStale, getScrapeRequest, hasUnreviewedMatch, loadSnapshot as loadHattrickSnapshot, loadTransferWatchlist, loadActiveBids, identifySquadDeadweight } from './hattrick.js';
import { getState } from '../../lib/state.js';
import config from '../../lib/config.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('hattrick-signals');

/**
 * detectHattrickSignals — 10 signal types covering match management, training,
 * transfer market, economy, and administrative tasks.
 *
 * @param {object} state - agent-loop state
 */
export function detectHattrickSignals(state) {
  const signals = [];
  try {
    const now = Date.now();
    const oneDayMs = 24 * 3600_000;

    if (!hattrickConfigured()) {
      // Only emit setup signal once per day to avoid spam
      const lastSetupSignal = state.lastHattrickSetupSignalAt || 0;
      if (now - lastSetupSignal > oneDayMs) {
        signals.push({
          type: 'hattrick_setup_needed',
          urgency: 'low',
          summary: 'Hattrick goal active but HATTRICK_TEAM_ID not configured — need the user\'s team ID to proceed',
          data: { hint: 'Ask the user for their hattrick.org team URL or team ID' },
        });
        state.lastHattrickSetupSignalAt = now;
      }
    } else {
      const teamId = hattrickTeamId();
      const scrapeUrls = [
        `https://www.hattrick.org/en/Club/?TeamID=${teamId}`,
        `https://www.hattrick.org/en/Club/Matches/?TeamID=${teamId}`,
        `https://www.hattrick.org/en/Club/Players/?TeamID=${teamId}`,
      ];

      // Read hattrick-cycle state for timestamps (authoritative source)
      const htState = getState('hattrick-cycle') || {};

      // Check if weekly cron has scheduled a scrape (high urgency)
      const cronRequest = getScrapeRequest();
      if (cronRequest && cronRequest > (htState.lastMatchPrepAt || 0)) {
        signals.push({
          type: 'hattrick_match_prep',
          urgency: 'high',
          summary: `Hattrick scrape requested by weekly cron — scrape team data for TeamID ${teamId}`,
          data: { teamId, scrapeUrls, cronScheduledAt: cronRequest },
        });
      } else if (isSnapshotStale()) {
        // Snapshot missing or >7 days old (medium urgency — no explicit cron request)
        signals.push({
          type: 'hattrick_match_prep',
          urgency: 'medium',
          summary: `Hattrick snapshot is stale — scrape team data and recommend lineup for TeamID ${teamId}`,
          data: { teamId, scrapeUrls },
        });
      }

      // Post-match review: fire when snapshot has a match date newer than last review
      const lastReviewedAt = htState.lastPostMatchReviewAt || 0;
      if (hasUnreviewedMatch(lastReviewedAt)) {
        const snap = loadHattrickSnapshot();
        signals.push({
          type: 'hattrick_post_match_review',
          urgency: 'medium',
          summary: `Hattrick post-match review pending — Round ${snap?.lastMatchRound || '?'} result not yet reviewed`,
          data: {
            teamId,
            lastMatchDate: snap?.lastMatchDate,
            round: snap?.lastMatchRound,
          },
        });
      }

      // Transfer market watch: fire every 3 days when watchlist is non-empty (or never checked)
      const threeDaysMs = 3 * 24 * 3600_000;
      const lastTransferCheck = htState.lastTransferCheckAt || 0;
      if (now - lastTransferCheck > threeDaysMs) {
        const watchlistData = loadTransferWatchlist();
        // Always fire if never checked; only fire if watchlist has items on subsequent checks
        if (!lastTransferCheck || watchlistData.items?.length > 0) {
          signals.push({
            type: 'hattrick_transfer_watch',
            urgency: 'low',
            summary: `Hattrick transfer market check due — ${watchlistData.items?.length || 0} target(s) on watchlist for TeamID ${teamId}`,
            data: {
              teamId,
              watchlistCount: watchlistData.items?.length || 0,
            },
          });
        }
      }

      // ── Signals migrated from hattrick-cycle.js decideAction() ──

      // Economy check: >24h since last
      const lastEconomy = htState.lastEconomyCheckAt || 0;
      if (now - lastEconomy > oneDayMs) {
        signals.push({
          type: 'hattrick_economy_check',
          urgency: 'low',
          summary: `Hattrick economy not checked in ${Math.round((now - lastEconomy) / 3600_000)}h`,
          data: { teamId, lastCheckAt: lastEconomy },
        });
      }

      // Training check: >24h since last
      const lastTraining = htState.lastTrainingCheckAt || 0;
      if (now - lastTraining > oneDayMs) {
        signals.push({
          type: 'hattrick_training_check',
          urgency: 'low',
          summary: `Hattrick training not checked in ${Math.round((now - lastTraining) / 3600_000)}h`,
          data: { teamId, lastCheckAt: lastTraining },
        });
      }

      // Weekly training progress evaluation: >7 days since last progress check
      // Distinct from daily training_check — this evaluates skill improvement over time
      const lastTrainingProgress = htState.lastTrainingProgressAt || 0;
      if (now - lastTrainingProgress > 7 * oneDayMs) {
        const weeksSinceCheck = Math.round((now - lastTrainingProgress) / (7 * 24 * 3600_000));
        signals.push({
          type: 'hattrick_training_progress',
          urgency: 'medium',
          summary: `Weekly training progress check due (${weeksSinceCheck}w since last evaluation)`,
          data: { teamId, lastCheckAt: lastTrainingProgress },
        });
      }

      // Full refresh: snapshot >7 days old (distinct from match_prep — lower urgency routine refresh)
      const lastRefresh = htState.lastFullRefreshAt || 0;
      if (now - lastRefresh > 7 * oneDayMs) {
        signals.push({
          type: 'hattrick_full_refresh',
          urgency: 'low',
          summary: 'Hattrick full snapshot older than 7 days — routine data refresh due',
          data: { teamId, lastRefreshAt: lastRefresh },
        });
      }

      // Weekly dashboard: Monday + >6 days since last
      const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: config.timezone });
      const lastDashboard = htState.lastWeeklyDashboardAt || 0;
      if (dayOfWeek === 'Mon' && now - lastDashboard > 6 * oneDayMs) {
        signals.push({
          type: 'hattrick_weekly_dashboard',
          urgency: 'low',
          summary: 'Monday weekly dashboard due',
          data: { teamId, lastDashboardAt: lastDashboard },
        });
      }

      // Autonomous bid: adaptive frequency based on active auction state
      const lastBid = htState.lastAutonomousBidAt || 0;
      const activeBids = loadActiveBids();
      const hoursSinceBid = (now - lastBid) / 3_600_000;

      let bidCheckIntervalH = 48;
      if (activeBids.length > 0) {
        const soonest = Math.min(...activeBids.map(b => b.deadlineMs || Infinity));
        const hoursToDeadline = (soonest - now) / 3_600_000;
        if (hoursToDeadline <= 2) bidCheckIntervalH = 1;
        else if (hoursToDeadline <= 12) bidCheckIntervalH = 4;
        else bidCheckIntervalH = 8;
      }

      if (hoursSinceBid > bidCheckIntervalH) {
        signals.push({
          type: 'hattrick_autonomous_bid',
          urgency: activeBids.length > 0 ? 'high' : 'medium',
          summary: `Bid check (${activeBids.length} active bids, ${Math.round(hoursSinceBid)}h since last)`,
          data: { teamId, lastBidAt: lastBid, activeBids: activeBids.length },
        });
      }

      // Bid resolution: fire when active bids have expired past their deadline
      const expiredBids = activeBids.filter(b => b.deadlineMs && b.deadlineMs < now);
      if (expiredBids.length > 0) {
        signals.push({
          type: 'hattrick_bid_resolve',
          urgency: 'high',
          summary: `${expiredBids.length} expired bid(s) need resolution`,
          data: { teamId, expiredCount: expiredBids.length, playerNames: expiredBids.map(b => b.playerName || '?') },
        });
      }

      // Sell review: Wednesday + >6 days since last
      const lastSell = htState.lastSellReviewAt || 0;
      if (dayOfWeek === 'Wed' && now - lastSell > 6 * oneDayMs) {
        signals.push({
          type: 'hattrick_sell_review',
          urgency: 'low',
          summary: 'Wednesday sell/release review due',
          data: { teamId, lastSellAt: lastSell },
        });
      }

      // Squad cleanup: fire when confirmed deadweight exists + not done in 7 days
      const lastCleanup = htState.lastSquadCleanupAt || 0;
      if (now - lastCleanup > 7 * oneDayMs) {
        const snap = loadHattrickSnapshot();
        if (snap?.players?.length > 0) {
          try {
            const { release, sell } = identifySquadDeadweight(snap.players);
            if (release.length + sell.length > 0) {
              signals.push({
                type: 'hattrick_squad_cleanup',
                urgency: 'medium',
                summary: `Squad cleanup due: ${release.length} release + ${sell.length} sell candidates (age/TSI criteria)`,
                data: { teamId, releaseCount: release.length, sellCount: sell.length },
              });
            }
          } catch (err) {
            log.warn({ err: err.message }, 'identifySquadDeadweight failed in signal detection');
          }
        }
      }
    }
  } catch (err) {
    log.warn({ err: err.message }, 'detectHattrickSignals failed');
  }
  return signals;
}
