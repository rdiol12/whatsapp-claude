import { appendFileSync, readFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import config from './config.js';
import { createLogger } from './logger.js';
import { smartIngest } from './mcp-gateway.js';

const log = createLogger('daily-notes');
const NOTES_DIR = join(config.dataDir, 'notes');
const TZ = config.timezone;

// Ensure notes dir exists
mkdirSync(NOTES_DIR, { recursive: true });

function todayFile() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  return join(NOTES_DIR, `${dateStr}.md`);
}

function timestamp() {
  return new Date().toLocaleTimeString('en-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

/**
 * Summarize a conversation exchange into a concise 1-line description.
 * Uses heuristics — no LLM call needed.
 */
function summarizeExchange(userMsg, assistantReply) {
  const user = userMsg.trim();
  const reply = assistantReply.trim();

  // Extract the action/topic from user message
  const userShort = user.length <= 60 ? user : user.slice(0, 57) + '...';

  // Extract the outcome from assistant reply (first sentence or short summary)
  let replyShort;
  const firstSentence = reply.match(/^[^.!?\n]+[.!?]?/);
  if (firstSentence && firstSentence[0].length <= 80) {
    replyShort = firstSentence[0];
  } else if (reply.length <= 60) {
    replyShort = reply;
  } else {
    replyShort = reply.slice(0, 57) + '...';
  }

  return `${userShort} → ${replyShort}`;
}

/**
 * Append a conversation summary to today's daily notes file.
 */
export function appendConversation(userMsg, assistantReply, meta = {}) {
  const file = todayFile();
  const time = timestamp();
  const costStr = meta.costUsd ? ` $${meta.costUsd.toFixed(4)}` : '';
  const tokensStr = meta.inputTokens ? ` [${meta.inputTokens}→${meta.outputTokens}]` : '';

  const summary = summarizeExchange(userMsg, assistantReply);
  const entry = `\n- **${time}**${costStr}${tokensStr} ${summary}\n`;

  try {
    // Create header if file doesn't exist
    try {
      readFileSync(file);
    } catch {
      const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      appendFileSync(file, `# Daily Notes — ${dateStr}\n`);
    }
    appendFileSync(file, entry);
    log.debug({ file, entryLen: entry.length }, 'Appended to daily notes');

    // Index conversation summary into Vestige (fire-and-forget, dedup-protected)
    if (summary.length >= 20) {
      const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      smartIngest(
        `[daily-note:${dateStr}] ${summary}`,
        ['daily-note', dateStr],
        'fact',
        'daily-notes'
      ).catch(err => log.debug({ err: err.message }, 'Daily note Vestige ingest failed'));
    }
  } catch (err) {
    log.error({ err: err.message }, 'Failed to append daily notes');
  }
}

/**
 * Append a system event (cron run, error, etc.) to today's notes.
 */
export function appendEvent(event, detail = '') {
  const file = todayFile();
  const time = timestamp();
  const entry = `\n- **${time}** [${event}] ${detail}\n`;

  try {
    try { readFileSync(file); } catch {
      const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      appendFileSync(file, `# Daily Notes — ${dateStr}\n`);
    }
    appendFileSync(file, entry);
  } catch (err) {
    log.error({ err: err.message }, 'Failed to append event to daily notes');
  }
}

/**
 * Read today's notes (for injecting into context).
 */
export function getTodayNotes() {
  try {
    return readFileSync(todayFile(), 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Read a specific day's notes.
 */
export function getNotesForDate(dateStr) {
  try {
    return readFileSync(join(NOTES_DIR, `${dateStr}.md`), 'utf-8');
  } catch {
    return '';
  }
}

/**
 * List all available note dates, sorted descending (most recent first).
 */
export function listAvailableDates() {
  try {
    return readdirSync(NOTES_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''))
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}
