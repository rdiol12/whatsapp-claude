/**
 * modules/hattrick/index.js — Module manifest for Hattrick team management.
 *
 * Exports a standard interface that lib/module-loader.js discovers and registers.
 */

import { detectHattrickSignals } from './signals.js';
import {
  buildHattrickMatchBrief, buildPostMatchBrief, buildTransferMarketBrief,
  buildEconomyCheckBrief, buildFullRefreshBrief, buildTrainingCheckBrief,
  buildTrainingProgressBrief,
  buildWeeklyDashboardBrief, buildAutonomousBidBrief, buildSellReviewBrief,
  buildSquadCleanupBrief, buildBidResolveBrief,
  buildWeeklyPlan, loadSnapshot,
} from './hattrick.js';
import { handleGetHattrick, handleCycle, handleRefresh } from './routes.js';
import { HATTRICK_HTML } from './dashboard.js';

function hasUrgentWork() {
  try {
    const snap = loadSnapshot();
    return snap?.nextMatchAt && (snap.nextMatchAt - Date.now()) < 3 * 3600_000;
  } catch { return false; }
}

export default {
  name: 'hattrick',
  signalPrefix: 'hattrick_',
  messageCategory: 'hattrick',

  detectSignals: detectHattrickSignals,

  briefBuilders: {
    hattrick_match_prep: buildHattrickMatchBrief,
    hattrick_post_match_review: buildPostMatchBrief,
    hattrick_transfer_watch: buildTransferMarketBrief,
    hattrick_economy_check: buildEconomyCheckBrief,
    hattrick_training_check: buildTrainingCheckBrief,
    hattrick_training_progress: buildTrainingProgressBrief,
    hattrick_full_refresh: buildFullRefreshBrief,
    hattrick_weekly_dashboard: buildWeeklyDashboardBrief,
    hattrick_autonomous_bid: buildAutonomousBidBrief,
    hattrick_bid_resolve: buildBidResolveBrief,
    hattrick_sell_review: buildSellReviewBrief,
    hattrick_squad_cleanup: buildSquadCleanupBrief,
  },

  contextProviders: [buildWeeklyPlan],

  sonnetSignalTypes: [
    'hattrick_match_prep',
    'hattrick_post_match_review',
    'hattrick_autonomous_bid',
  ],

  stateKey: 'hattrick-cycle',
  stateKeyMap: {
    hattrick_match_prep: 'lastMatchPrepAt',
    hattrick_post_match_review: 'lastPostMatchReviewAt',
    hattrick_economy_check: 'lastEconomyCheckAt',
    hattrick_training_check: 'lastTrainingCheckAt',
    hattrick_training_progress: 'lastTrainingProgressAt',
    hattrick_transfer_watch: 'lastTransferCheckAt',
    hattrick_full_refresh: 'lastFullRefreshAt',
    hattrick_weekly_dashboard: 'lastWeeklyDashboardAt',
    hattrick_autonomous_bid: 'lastAutonomousBidAt',
    hattrick_bid_resolve: 'lastBidResolveAt',
    hattrick_sell_review: 'lastSellReviewAt',
    hattrick_squad_cleanup: 'lastSquadCleanupAt',
  },

  hasUrgentWork,

  apiRoutes: [
    { method: 'GET', path: '/hattrick', handler: handleGetHattrick },
    { method: 'POST', path: '/hattrick/cycle', handler: handleCycle },
    { method: 'POST', path: '/hattrick/refresh', handler: handleRefresh },
  ],

  dashboard: {
    path: '/hattrick',
    title: 'Hattrick',
    icon: '&#9917;',
    html: HATTRICK_HTML,
  },
};
