/**
 * Auto-tag plugin — automatically saves conversation topics to vestige memory.
 * Demonstrates: postChat hook, botApi.memory usage, metadata.
 */

export const meta = {
  name: 'auto-tag',
  version: '1.0.0',
  description: 'Auto-saves conversation topics to memory',
  priority: 50,
};

const TOPIC_RE = /(?:project|repo|app|service|api|database|server|deploy|migration|refactor|bug|feature|task|sprint)\s*(?:[:=]|called|named)?\s*["']?(\S{3,40})["']?/i;
const MIN_MSG_LENGTH = 40;
let bot = null;

export async function onStartup(botApi) {
  bot = botApi;
  bot.log.info('[auto-tag] Plugin started');
}

export function postChat(userText, reply, meta, botApi) {
  if (!botApi?.memory?.ingest) return;
  if (userText.length < MIN_MSG_LENGTH) return;

  const match = userText.match(TOPIC_RE);
  if (match) {
    const topic = match[1];
    botApi.memory.ingest(
      `[auto-tag] Discussed topic: ${topic} — "${userText.slice(0, 150)}"`,
      ['auto-tag', 'topic', topic.toLowerCase()],
      'fact',
      'plugin:auto-tag',
    ).catch(() => {});
  }
}
