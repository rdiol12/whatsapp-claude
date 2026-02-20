/**
 * Activity Summary Plugin — tracks daily message stats.
 * Proves the plugin system works and provides useful metrics.
 *
 * Hooks used:
 *   postChat — count messages and accumulate cost
 *
 * State: plugin:activity-summary (daily reset)
 */

const STATE_KEY = 'plugin_activity-summary';

function getToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function getState(botApi) {
  const state = botApi.state.get(STATE_KEY) || {};
  // Reset if it's a new day
  if (state.date !== getToday()) {
    return { date: getToday(), messages: 0, totalCost: 0, models: {} };
  }
  return state;
}

function saveState(botApi, state) {
  botApi.state.set(STATE_KEY, state);
}

export async function onStartup(botApi) {
  botApi.log.info('Activity summary plugin loaded');
}

export function postChat(userMsg, reply, meta, botApi) {
  try {
    const state = getState(botApi);
    state.messages++;
    state.totalCost += meta.costUsd || 0;
    saveState(botApi, state);
  } catch {
    // Non-critical — don't crash the bot
  }
}

/**
 * Get today's activity summary (can be called from other modules).
 */
export function getSummary(botApi) {
  const state = getState(botApi);
  return `Messages: ${state.messages} | Cost: $${state.totalCost.toFixed(4)}`;
}
