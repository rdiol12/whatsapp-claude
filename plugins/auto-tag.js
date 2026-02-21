/**
 * Auto-tag plugin — automatically saves conversation topics to vestige memory.
 * Demonstrates: postChat hook, botApi.memory usage, metadata.
 */

export const meta = {
  name: 'auto-tag',
  version: '1.1.0',
  description: 'Auto-saves conversation topics to memory',
  priority: 50,
};

// Named entities: "project foo", "repo bar", "deploy staging", etc.
const TOPIC_RE = /(?:project|repo|app|service|api|database|server|deploy|migration|refactor|bug|feature|task|sprint)\s+(?:[:=]|called|named)?\s*["']?(\S{3,40})["']?/i;

// Keyword topics: broad technical discussion worth remembering
const KEYWORD_RE = /\b(docker|kubernetes|k8s|redis|postgres|mongodb|nginx|tailscale|pm2|vestige|baileys|convex|nextjs|react|node(?:js)?|typescript|python|claude|openai|codex|gemini)\b/i;

const MIN_MSG_LENGTH = 40;
const DEDUP_TTL = 30 * 60_000; // 30 minutes — don't re-ingest same topic

// Recent topics cache: topic → timestamp
const recentTopics = new Map();

function isDuplicate(topic) {
  const key = topic.toLowerCase();
  const lastSeen = recentTopics.get(key);
  if (lastSeen && Date.now() - lastSeen < DEDUP_TTL) return true;
  recentTopics.set(key, Date.now());
  // Prune old entries
  if (recentTopics.size > 50) {
    const cutoff = Date.now() - DEDUP_TTL;
    for (const [k, ts] of recentTopics) {
      if (ts < cutoff) recentTopics.delete(k);
    }
  }
  return false;
}

export async function onStartup(botApi) {
  botApi.log.info('[auto-tag] Plugin started');
}

export function postChat(userText, reply, meta, botApi) {
  if (!botApi?.memory?.ingest) return;
  if (userText.length < MIN_MSG_LENGTH) return;

  // Try named entity first, then keyword fallback
  const namedMatch = userText.match(TOPIC_RE);
  const keywordMatch = !namedMatch && userText.match(KEYWORD_RE);
  const topic = namedMatch?.[1] || keywordMatch?.[1];

  if (!topic || isDuplicate(topic)) return;

  botApi.memory.ingest(
    `[auto-tag] Discussed topic: ${topic} — "${userText.slice(0, 150)}"`,
    ['auto-tag', 'topic', topic.toLowerCase()],
    'fact',
    'plugin:auto-tag',
  ).catch(err => {
    botApi.log.warn({ err: err.message, topic }, '[auto-tag] Failed to ingest topic');
  });
}
