/**
 * Activity Summary Plugin — tracks daily message stats.
 *
 * Hooks used:
 *   postChat — count messages and accumulate cost
 *   onCommand — /activity shows today's stats
 *
 * State: plugin_activity-summary (daily reset)
 */

import config from '../lib/config.js';

export const meta = {
  name: 'activity-summary',
  version: '1.1.0',
  description: 'Tracks daily message stats and cost',
  priority: 50,
};

const STATE_KEY = 'plugin_activity-summary';

function getToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
}

function getState(botApi) {
  const state = botApi.state.get(STATE_KEY) || {};
  // Reset if it's a new day
  if (state.date !== getToday()) {
    return { date: getToday(), messages: 0, totalCost: 0 };
  }
  return state;
}

function saveState(botApi, state) {
  botApi.state.set(STATE_KEY, state);
}

export async function onStartup(botApi) {
  botApi.log.info('[activity-summary] Plugin started');
}

export function postChat(userMsg, reply, meta, botApi) {
  try {
    const state = getState(botApi);
    state.messages++;
    state.totalCost += meta.costUsd || 0;
    saveState(botApi, state);
  } catch (err) {
    botApi.log.warn({ err: err.message }, '[activity-summary] Failed to track activity');
  }
}

export async function onCommand(cmd, text, botApi) {
  if (cmd !== '/activity') return false;

  const state = getState(botApi);
  await botApi.send(
    `*Today's Activity (${state.date}):*\n` +
    `Messages: ${state.messages}\n` +
    `Cost: $${state.totalCost.toFixed(4)}`
  );
  return true;
}

/**
 * Get today's activity summary (can be called from other modules).
 */
export function getSummary(botApi) {
  const state = getState(botApi);
  return `Messages: ${state.messages} | Cost: $${state.totalCost.toFixed(4)}`;
}
