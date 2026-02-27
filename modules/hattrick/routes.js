/**
 * modules/hattrick/routes.js — API route handlers for Hattrick IPC endpoints.
 *
 * Extracted from lib/bot-ipc.js. Each handler receives { getState, setState, triggerCycleNow, jsonResponse, res }.
 */

import { loadSnapshot, loadLastAnalysis, loadMatchHistory, loadTransferWatchlist } from './hattrick.js';

export function handleGetHattrick(req, res, { getState, jsonResponse }) {
  const htState = getState('hattrick-cycle') || {};
  return jsonResponse(res, {
    snapshot: loadSnapshot(),
    analysis: loadLastAnalysis(),
    matchHistory: loadMatchHistory(),
    watchlist: loadTransferWatchlist(),
    cycleState: {
      mergedIntoAgentLoop: true,
      lastCycleAt: htState.lastCycleAt || null,
      lastMatchPrepAt: htState.lastMatchPrepAt || null,
      lastPostMatchReviewAt: htState.lastPostMatchReviewAt || null,
      lastEconomyCheckAt: htState.lastEconomyCheckAt || null,
      lastTrainingCheckAt: htState.lastTrainingCheckAt || null,
      lastTransferCheckAt: htState.lastTransferCheckAt || null,
      lastFullRefreshAt: htState.lastFullRefreshAt || null,
      lastWeeklyDashboardAt: htState.lastWeeklyDashboardAt || null,
      lastAutonomousBidAt: htState.lastAutonomousBidAt || null,
      lastSellReviewAt: htState.lastSellReviewAt || null,
    },
  });
}

export function handleCycle(req, res, { triggerCycleNow, jsonResponse }) {
  const result = triggerCycleNow();
  return jsonResponse(res, { ...result, note: 'Hattrick signals merged into agent-loop' });
}

export function handleRefresh(req, res, { setState, triggerCycleNow, jsonResponse }) {
  setState('hattrick-cycle', {
    lastMatchPrepAt: 0, lastPostMatchReviewAt: 0,
    lastEconomyCheckAt: 0, lastTrainingCheckAt: 0,
    lastTransferCheckAt: 0, lastFullRefreshAt: 0,
    lastWeeklyDashboardAt: 0, lastAutonomousBidAt: 0, lastSellReviewAt: 0,
  });
  const result = triggerCycleNow();
  return jsonResponse(res, { refreshed: true, ...result });
}
