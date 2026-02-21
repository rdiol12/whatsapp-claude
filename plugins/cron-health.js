/**
 * Cron health plugin — tracks run/error rates and auto-disables flaky crons.
 *
 * Hooks: onStartup, onCronRun, onCronError, onCommand (/cronhealth)
 *
 * Tracks per-cron: total runs, errors, error rate, avg duration.
 * Auto-disables crons after 5 consecutive failures.
 */

export const meta = {
  name: 'cron-health',
  version: '1.0.0',
  description: 'Tracks cron health metrics and auto-disables flaky crons',
  priority: 80,
};

const STATE_KEY = 'plugin_cron-health';
const AUTO_DISABLE_THRESHOLD = 5; // consecutive failures before auto-disable

let api = null;

export async function onStartup(botApi) {
  api = botApi;
  const stats = botApi.state.get(STATE_KEY);
  const cronCount = Object.keys(stats.crons || {}).length;
  botApi.log.info({ cronCount }, '[cron-health] Plugin started');
}

export function onCronRun(job) {
  if (!api) return;
  const stats = api.state.get(STATE_KEY);
  const crons = stats.crons || {};

  if (!crons[job.id]) {
    crons[job.id] = { name: job.name, runs: 0, errors: 0, totalMs: 0, lastRun: null };
  }

  crons[job.id].runs++;
  crons[job.id].lastRun = Date.now();
  crons[job.id].name = job.name; // keep name in sync

  api.state.set(STATE_KEY, { ...stats, crons });
}

export function onCronError(job, err) {
  if (!api) return;
  const stats = api.state.get(STATE_KEY);
  const crons = stats.crons || {};

  if (!crons[job.id]) {
    crons[job.id] = { name: job.name, runs: 0, errors: 0, totalMs: 0, lastRun: null };
  }

  crons[job.id].errors++;
  crons[job.id].lastError = { message: err.message, ts: Date.now() };

  // Auto-disable after threshold consecutive failures
  const consecutive = job.state?.consecutiveErrors || 0;
  if (consecutive >= AUTO_DISABLE_THRESHOLD && job.enabled) {
    try {
      api.crons.toggle(job.id);
      crons[job.id].autoDisabled = true;
      crons[job.id].autoDisabledAt = Date.now();
      api.log.warn({ cronId: job.id, name: job.name, consecutive }, '[cron-health] Auto-disabled flaky cron');
      api.notify(`*[Cron Health]* Auto-disabled _${job.name}_ after ${consecutive} consecutive failures.\nLast error: ${err.message}`);
    } catch (e) {
      api.log.error({ err: e.message }, '[cron-health] Failed to auto-disable cron');
    }
  }

  api.state.set(STATE_KEY, { ...stats, crons });
}

export async function onCommand(cmd, text, botApi) {
  if (cmd !== '/cronhealth') return false;

  const stats = botApi.state.get(STATE_KEY);
  const crons = stats.crons || {};
  const entries = Object.values(crons);

  if (entries.length === 0) {
    await botApi.send('No cron health data yet.');
    return true;
  }

  const lines = entries
    .sort((a, b) => (b.errors / (b.runs || 1)) - (a.errors / (a.runs || 1)))
    .map(c => {
      const rate = c.runs > 0 ? Math.round((c.errors / c.runs) * 100) : 0;
      const disabled = c.autoDisabled ? ' *[auto-disabled]*' : '';
      return `- _${c.name}_: ${c.runs} runs, ${c.errors} errors (${rate}%)${disabled}`;
    });

  await botApi.send(`*Cron Health:*\n${lines.join('\n')}`);
  return true;
}
