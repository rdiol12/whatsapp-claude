/**
 * Feedback Signal Definitions
 *
 * Maps user response types to sentiment weights for response quality learning.
 * Used to classify reactions and build quality patterns over time.
 */

// --- Signal definitions ---

const SIGNALS = [
  // Strong positive (+2)
  { name: 'thanks',           sentiment:  2, type: 'text', patterns: [/תודה|תנקס/i, /\bthank(?:s| you)\b/i] },
  { name: 'praise',           sentiment:  2, type: 'text', patterns: [/\b(?:perfect|excellent|awesome|amazing|great|brilliant|exactly)\b/i, /מעולה|אחלה|קול|סבבה/] },
  { name: 'emoji_positive',   sentiment:  2, type: 'reaction', emojis: ['👍', '❤️', '🔥', '👏', '✅', '🎉', '😂'] },

  // Moderate positive (+1)
  { name: 'engaged_followup', sentiment:  1, type: 'text', patterns: [/\b(?:can you also|how would I|what about|and also)\b/i, /ואיך|ומה עם/] },
  { name: 'confirm',          sentiment:  1, type: 'text', patterns: [/\b(?:yep|yeah|yup|sure|absolutely|definitely|that makes sense)\b/i, /^כן$|נכון|מסכים/] },
  { name: 'emoji_mild_pos',   sentiment:  1, type: 'reaction', emojis: ['👌', '💯', '✨', '🙌', '😊'] },

  // Slight negative (-0.5)
  { name: 'dismissive_ack',   sentiment: -0.5, type: 'text', patterns: [/^(?:ok|k|alright|whatever|got it|fine)\.?\s*$/i, /^(?:אוקי|טוב|יאללה)\.?\s*$/] },
  { name: 'reluctant',        sentiment: -0.5, type: 'text', patterns: [/\b(?:i guess|if you say so|i'll try but)\b/i] },

  // Moderate negative (-1)
  { name: 'silence',          sentiment: -1, type: 'timing', windowMin: 30, description: 'No reply within 30 min' },
  { name: 'emoji_negative',   sentiment: -1, type: 'reaction', emojis: ['😑', '🙃', '😒', '🤨'] },

  // Strong negative (-2)
  { name: 'correction',       sentiment: -2, type: 'text', patterns: [/\b(?:no|wrong|incorrect|nope|that's not)\b/i, /\b(?:you misunderstood|that's not right)\b/i, /לא נכון|טעות/] },
  { name: 'complaint',        sentiment: -2, type: 'text', patterns: [/\b(?:useless|terrible|unhelpful|doesn't help)\b/i] },
  { name: 'emoji_strong_neg', sentiment: -2, type: 'reaction', emojis: ['👎', '😤', '😡', '🤦', '🙅'] },
];

// --- Classification ---

/**
 * Classify a text response against known signals.
 * @param {string} text - User's reply
 * @returns {{ name: string, sentiment: number } | null}
 */
export function classifyText(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // Check exact-match patterns first (dismissive ack), then broader ones
  for (const sig of SIGNALS) {
    if (sig.type !== 'text' || !sig.patterns) continue;
    for (const pat of sig.patterns) {
      if (pat.test(trimmed)) {
        return { name: sig.name, sentiment: sig.sentiment };
      }
    }
  }
  return null;
}

/**
 * Classify an emoji reaction.
 * @param {string} emoji
 * @returns {{ name: string, sentiment: number } | null}
 */
export function classifyReaction(emoji) {
  if (!emoji) return null;
  for (const sig of SIGNALS) {
    if (sig.type !== 'reaction') continue;
    if (sig.emojis.includes(emoji)) {
      return { name: sig.name, sentiment: sig.sentiment };
    }
  }
  return null;
}

/**
 * Get the silence signal definition (for timeout-based detection).
 */
export function getSilenceWindow() {
  const sig = SIGNALS.find(s => s.name === 'silence');
  return sig ? sig.windowMin : 30;
}

export { SIGNALS };
