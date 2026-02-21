/**
 * Command logger plugin — tracks all slash commands for analytics.
 * Demonstrates: onMessage hook, botApi.state usage, onCommand hook, metadata.
 */

export const meta = {
  name: 'command-logger',
  version: '1.0.0',
  description: 'Logs slash command usage for analytics',
  priority: 90,
};

const STATE_KEY = 'plugin_command-logger';

export async function onStartup(botApi) {
  const stats = botApi.state.get(STATE_KEY);
  const total = stats.totalCommands || 0;
  botApi.log.info({ total }, '[command-logger] Plugin started');
}

export function onMessage({ text }, botApi) {
  if (!text || !text.startsWith('/')) return;

  try {
    const cmd = text.split(/\s/)[0].toLowerCase();
    const stats = botApi.state.get(STATE_KEY) || {};

    // Increment per-command counter
    const counts = stats.commands || {};
    counts[cmd] = (counts[cmd] || 0) + 1;

    botApi.state.set(STATE_KEY, {
      commands: counts,
      totalCommands: (stats.totalCommands || 0) + 1,
      lastCommand: { cmd, ts: Date.now() },
    });
  } catch (err) {
    botApi.log.warn({ err: err.message }, '[command-logger] Failed to log command');
  }
}

export async function onCommand(cmd, text, botApi) {
  // Handle /cmdstats — show command usage stats
  if (cmd === '/cmdstats') {
    const stats = botApi.state.get(STATE_KEY);
    const counts = stats.commands || {};
    const total = stats.totalCommands || 0;

    if (total === 0) {
      await botApi.send('No commands logged yet.');
      return true;
    }

    const sorted = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `  ${c}: ${n}`)
      .join('\n');

    await botApi.send(`*Command usage (${total} total):*\n${sorted}`);
    return true;
  }

  return false;
}
