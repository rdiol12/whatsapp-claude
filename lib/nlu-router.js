/**
 * NLU Router — Natural Language Understanding for WhatsApp Claude Bot
 *
 * Replaces slash commands with intent classification from natural language.
 * No LLM calls — uses weighted keyword/pattern matching with confidence scoring.
 *
 * Architecture:
 *   1. Normalize input (lowercase, strip diacritics, expand Hebrew)
 *   2. Run all intent matchers in parallel (each returns 0..1 confidence)
 *   3. Pick highest confidence above threshold (0.6)
 *   4. Extract parameters from the original text
 *   5. Return { intent, confidence, params } or null (fall through to Claude)
 *
 * Scoring model:
 *   Each pattern has a tier: 'strong' (0.85 base), 'medium' (0.55 base), or 'weak' (0.3 base).
 *   - A single strong-tier match is enough to trigger an intent.
 *   - Multiple medium matches accumulate.
 *   - Weak matches only contribute if combined with other evidence.
 *   Brevity boost rewards short, command-like messages.
 *
 * Adding a new intent:
 *   1. Add an entry to INTENTS with patterns, antiPatterns, and extract function
 *   2. That's it — the router picks it up automatically
 */

import { createLogger } from './logger.js';

const log = createLogger('nlu');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIDENCE_THRESHOLD = 0.6;  // Below this → fall through to Claude
const AMBIGUITY_GAP = 0.15;        // If top two intents are this close → fall through

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

// Hebrew → English concept mapping (common phrases, not translation)
const HEBREW_MAP = [
  // Status / health
  [/מה המצב/g, 'what is the status'],
  [/איך אתה/g, 'how are you'],
  [/מה שלומך/g, 'how are you'],
  [/מה נשמע/g, 'how are you'],
  [/בריאות/g, 'health'],
  // Clear
  [/נקה (את )?ה?(שיחה|היסטוריה|הודעות)/g, 'clear conversation history'],
  [/מחק (את )?ה?(שיחה|היסטוריה|הודעות)/g, 'clear conversation history'],
  [/התחל מחדש/g, 'start fresh clear'],
  // Help
  [/עזרה/g, 'help commands'],
  [/מה אתה יכול/g, 'what can you do help'],
  [/פקודות/g, 'commands help'],
  // Crons
  [/משימות מתוזמנות/g, 'cron jobs scheduled'],
  [/תזמונים/g, 'cron jobs'],
  [/קרונים/g, 'cron jobs'],
  // Today / notes
  [/מה עשינו היום/g, 'what did we do today notes'],
  [/סיכום היום/g, 'today summary notes'],
  [/הערות/g, 'notes'],
  [/היום/g, 'today'],
  // Skills
  [/כישורים/g, 'skills abilities'],
  [/יכולות/g, 'skills abilities capabilities'],
  // Files
  [/קבצים/g, 'files workspace'],
  [/תשלח (לי )?/g, 'send me '],
  [/שמור/g, 'save'],
];

/**
 * Normalize text: lowercase, expand Hebrew phrases, strip excess whitespace.
 * Returns { normalized, lang, original }.
 */
function normalize(text) {
  let t = text.trim();

  // Detect language
  const hebrewChars = (t.match(/[\u0590-\u05FF]/g) || []).length;
  const latinChars = (t.match(/[a-zA-Z]/g) || []).length;
  const lang = hebrewChars > latinChars ? 'he' : latinChars > 0 ? 'en' : 'he';

  // Apply Hebrew expansions
  let expanded = t;
  for (const [re, replacement] of HEBREW_MAP) {
    expanded = expanded.replace(re, replacement);
  }

  // Lowercase + normalize whitespace and quotes
  const normalized = expanded.toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D''`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  return { normalized, lang, original: text };
}

// ---------------------------------------------------------------------------
// Scoring engine
// ---------------------------------------------------------------------------

/**
 * Score how well a text matches a set of tiered patterns.
 *
 * Each pattern is: { re?: RegExp, text?: string, tier: 'strong'|'medium'|'weak' }
 *
 * Scoring:
 *   - strong match: base 0.85
 *   - medium match: base 0.55
 *   - weak match:   base 0.30
 *   - Additional matches add diminishing bonuses (+0.05 each, up to +0.15)
 *   - Two medium matches combine to ~0.60+ (above threshold)
 *   - One strong match alone is enough (~0.85)
 *
 * Returns a raw score in [0, 1].
 */
function scorePatterns(text, patterns) {
  const TIER_BASE = { strong: 0.85, medium: 0.55, weak: 0.30 };
  const BONUS_PER_EXTRA = 0.06;
  const MAX_BONUS = 0.15;

  let bestBase = 0;
  let matchCount = 0;

  for (const p of patterns) {
    let matched = false;
    if (p.re) {
      // Reset lastIndex for regexes with 'g' flag
      if (p.re.global) p.re.lastIndex = 0;
      matched = p.re.test(text);
      if (p.re.global) p.re.lastIndex = 0;
    } else if (p.text) {
      matched = text.includes(p.text);
    }

    if (matched) {
      const base = TIER_BASE[p.tier] || TIER_BASE.medium;
      if (base > bestBase) bestBase = base;
      matchCount++;
    }
  }

  if (matchCount === 0) return 0;

  // Bonus for multiple matches (diminishing returns)
  const extraMatches = matchCount - 1;
  const bonus = Math.min(extraMatches * BONUS_PER_EXTRA, MAX_BONUS);

  return Math.min(bestBase + bonus, 1.0);
}

/**
 * Brevity boost: short messages are more likely to be commands.
 */
function brevityBoost(text) {
  const words = text.split(/\s+/).length;
  if (words <= 3) return 1.10;
  if (words <= 6) return 1.05;
  if (words <= 12) return 1.00;
  if (words <= 25) return 0.90;
  return 0.75; // Long messages → probably conversational
}

// ---------------------------------------------------------------------------
// Intent definitions
// ---------------------------------------------------------------------------

const INTENTS = [

  // ── /status ───────────────────────────────────────────────────────────
  {
    name: 'status',
    patterns: [
      // Strong: phrases that almost certainly mean "bot status"
      { re: /\bhow (are|r) (you|u)( doing| feeling)?\b/, tier: 'strong' },
      { re: /\bare (you|u) (still )?(there|alive|awake|up|running|working|online)\??/, tier: 'strong' },
      { re: /\b(what'?s|what is) (your|the) (status|health|state)\b/, tier: 'strong' },
      { re: /\bbot (status|health|info|stats|diagnostics)\b/, tier: 'strong' },
      { re: /\bsystem (status|health|info|check)\b/, tier: 'strong' },
      { re: /^ping\b/, tier: 'strong' },
      // Medium: partial evidence
      { re: /\b(status|health|uptime|stats)\b/, tier: 'medium' },
      { re: /\b(you|bot) (ok|okay|alright|alive|up|running|working)\b/, tier: 'medium' },
      { re: /\b(memory|ram) (usage|used|consumption)\b/, tier: 'medium' },
      { re: /\b(queue|mcp|vestige) (status|state|connected)\b/, tier: 'medium' },
      // Hebrew expansions
      { text: 'what is the status', tier: 'strong' },
      { text: 'how are you', tier: 'strong' },
    ],
    antiPatterns: [
      /\b(pr|pull request|issue|ticket|deploy|build|pipeline) status\b/,
      /\bstatus (of|for) (the |my )?(project|app|site|server|deploy)/,
    ],
    extract: () => ({}),
  },

  // ── /clear ────────────────────────────────────────────────────────────
  {
    name: 'clear',
    patterns: [
      // Strong: unambiguous clear-conversation phrases
      { re: /\b(clear|reset|wipe|erase|purge|flush) .{0,10}(conversation|chat|history|messages?|context|session)\b/, tier: 'strong' },
      { re: /\b(conversation|chat|history|messages?) .{0,10}(clear|reset|wipe|erase|purge)\b/, tier: 'strong' },
      { re: /\b(start|begin) (over|fresh|anew|from scratch|clean)\b/, tier: 'strong' },
      { re: /\bforget (everything|all|our (chat|conversation|history))\b/, tier: 'strong' },
      { re: /\b(new|fresh) (conversation|chat|session)\b/, tier: 'strong' },
      { re: /\bclean slate\b/, tier: 'strong' },
      { re: /\btabula rasa\b/, tier: 'strong' },
      { re: /\blet'?s? start over\b/, tier: 'strong' },
      // Medium: partial signals that need combination
      { re: /\b(clear|reset|wipe|erase|delete|flush|purge)\b/, tier: 'medium' },
      { re: /\b(conversation|chat|history|messages?|context|session)\b/, tier: 'weak' },
      // Hebrew
      { text: 'clear conversation history', tier: 'strong' },
      { text: 'start fresh clear', tier: 'strong' },
    ],
    extract: () => ({}),
  },

  // ── /help ─────────────────────────────────────────────────────────────
  {
    name: 'help',
    patterns: [
      // Strong
      { re: /\bwhat (can|do) you (do|know|support|handle|offer)\b/, tier: 'strong' },
      { re: /\bwhat (are )?your (commands?|capabilities|features|abilities)\b/, tier: 'strong' },
      { re: /\bshow (me )?(the )?(commands?|help|menu|options)\b/, tier: 'strong' },
      { re: /\blist (of )?(commands?|features|capabilities)\b/, tier: 'strong' },
      { re: /\bhow (do|can|should) i (use|interact|talk to|work with) (you|this|the bot)\b/, tier: 'strong' },
      // Medium
      { re: /^help\s*\??$/i, tier: 'strong' },   // Just "help" or "help?" alone
      { re: /\b(help|commands?|instructions?)\b/, tier: 'medium' },
      // Hebrew
      { text: 'help commands', tier: 'strong' },
      { text: 'what can you do help', tier: 'strong' },
    ],
    antiPatterns: [
      /\bhelp (me )?(with|on|about|understand|fix|debug|write|build|create|make)\b/,
      /\bhelp .{15,}/, // long help requests are about a topic
    ],
    extract: () => ({}),
  },

  // ── /crons ────────────────────────────────────────────────────────────
  {
    name: 'crons',
    patterns: [
      // Strong
      { re: /\b(show|list|what are|display|see) .{0,20}crons?\b/, tier: 'strong' },
      { re: /\bcrons? (list|jobs?|status|summary)\b/, tier: 'strong' },
      { re: /\b(show|list|what are|display) .{0,20}(scheduled|recurring) (job|task|routine)s?\b/, tier: 'strong' },
      { re: /\bwhat('?s| is) (scheduled|running|automated)\b/, tier: 'strong' },
      { re: /\bmy (crons?|scheduled jobs?|automations?|recurring tasks?)\b/, tier: 'strong' },
      // Medium
      { re: /\bcrons?\b/, tier: 'medium' },
      { re: /\b(scheduled|recurring) (job|task|routine)s?\b/, tier: 'medium' },
      { re: /\bautomations?\b/, tier: 'medium' },
      // Hebrew
      { text: 'cron jobs', tier: 'strong' },
      { text: 'cron jobs scheduled', tier: 'strong' },
    ],
    antiPatterns: [
      /\b(create|add|set up|schedule|make|new) .{0,15}(cron|job|task|schedule|timer)\b/,
      /\b(delete|remove|disable|stop|toggle|pause) .{0,15}(cron|job|task)\b/,
      /\b(run|trigger|execute|fire) .{0,15}(cron|job|task)\b/,
    ],
    extract: () => ({}),
  },

  // ── /today ────────────────────────────────────────────────────────────
  {
    name: 'today',
    patterns: [
      // Strong
      { re: /\btoday'?s? (notes?|summary|log|recap|digest|conversations?|activity|briefing)\b/, tier: 'strong' },
      { re: /\bwhat (did we|have we) (talk|chat|discuss|do|cover|work on).{0,10}today\b/, tier: 'strong' },
      { re: /\b(show|give|get) (me )?(today|daily) (notes?|summary|log|recap)\b/, tier: 'strong' },
      { re: /\bdaily (notes?|summary|log|recap|briefing|digest)\b/, tier: 'strong' },
      { re: /\brecap of today\b/, tier: 'strong' },
      { re: /\bsummarize today\b/, tier: 'strong' },
      { re: /\bwhat('?s| is| was) (been )?(happening|going on) today\b/, tier: 'strong' },
      { re: /\btoday('?s)? (conversation|chat) (history|log|recap)\b/, tier: 'strong' },
      // Hebrew
      { text: 'what did we do today', tier: 'strong' },
      { text: 'today summary notes', tier: 'strong' },
    ],
    antiPatterns: [
      /\d{4}-\d{2}-\d{2}/,  // specific date → /notes
      /\b(yesterday|last (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/,
    ],
    extract: () => ({}),
  },

  // ── /notes <date> ─────────────────────────────────────────────────────
  {
    name: 'notes',
    patterns: [
      // Strong: clear request for notes + date signal
      { re: /\bnotes? (for|from|on|of) .{0,20}\d/, tier: 'strong' },
      { re: /\bnotes? (for|from|on|of) .{0,10}(yesterday|last)/, tier: 'strong' },
      { re: /\bwhat (did we|happened).{0,20}(yesterday|last (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/, tier: 'strong' },
      { re: /\b(conversation|chat|discussion|notes?) .{0,15}(yesterday|last (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday))/, tier: 'strong' },
      // Medium
      { re: /\bnotes? (for|from|on|of)\b/, tier: 'medium' },
      { re: /\d{4}-\d{2}-\d{2}/, tier: 'medium' },
      { re: /\byesterday\b/, tier: 'medium' },
      { re: /\blast\s+(week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/, tier: 'medium' },
      { re: /\bhistory (for|from|on|of)\b/, tier: 'medium' },
    ],
    extract: (original, normalized) => {
      // Try ISO date first
      const isoMatch = original.match(/(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) return { date: isoMatch[1] };

      // Natural date references
      const now = new Date();
      const tzOffset = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));

      if (/\byesterday\b/i.test(normalized)) {
        const d = new Date(tzOffset);
        d.setDate(d.getDate() - 1);
        return { date: d.toISOString().split('T')[0] };
      }

      const dayMatch = normalized.match(/last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
      if (dayMatch) {
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const targetDay = dayNames.indexOf(dayMatch[1]);
        const d = new Date(tzOffset);
        const currentDay = d.getDay();
        let diff = currentDay - targetDay;
        if (diff <= 0) diff += 7;
        d.setDate(d.getDate() - diff);
        return { date: d.toISOString().split('T')[0] };
      }

      if (/last week/i.test(normalized)) {
        const d = new Date(tzOffset);
        d.setDate(d.getDate() - 7);
        return { date: d.toISOString().split('T')[0] };
      }

      const slashDate = original.match(/(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?/);
      if (slashDate) {
        const a = parseInt(slashDate[1]);
        const b = parseInt(slashDate[2]);
        let year = slashDate[3] ? parseInt(slashDate[3]) : tzOffset.getFullYear();
        if (year < 100) year += 2000;
        const day = a > 12 ? a : (b > 12 ? b : a);
        const month = a > 12 ? b : (b > 12 ? a : b);
        return { date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
      }

      return null;
    },
  },

  // ── /skills ───────────────────────────────────────────────────────────
  {
    name: 'skills',
    patterns: [
      // Strong
      { re: /\b(list|show|what are|display|all) .{0,15}skills?\b/, tier: 'strong' },
      { re: /\bskills? (list|available|loaded|installed)\b/, tier: 'strong' },
      { re: /\bwhat skills?\b/, tier: 'strong' },
      { re: /\bavailable skills?\b/, tier: 'strong' },
      { re: /\byour (skills?|abilities|capabilities)\b/, tier: 'strong' },
      // Hebrew
      { text: 'skills abilities', tier: 'strong' },
      { text: 'skills abilities capabilities', tier: 'strong' },
    ],
    antiPatterns: [
      /\b(show|tell|describe|explain|get|read|open) .{0,10}skill\s+[a-z0-9_-]{2,}/i, // specific skill
    ],
    extract: () => ({}),
  },

  // ── /skill <name> ─────────────────────────────────────────────────────
  {
    name: 'skill',
    patterns: [
      // Strong
      { re: /\b(show|display|open|read|get|describe|explain) .{0,15}skill\s+[a-z0-9_-]{2,}/i, tier: 'strong' },
      { re: /\bskill\s+[a-z0-9_-]{2,}/i, tier: 'strong' },
      { re: /\b(tell me about|details? (of|on|about)) .{0,10}skill\b/, tier: 'strong' },
      // Medium
      { re: /\b(content|body|text) (of|for) .{0,10}skill\b/, tier: 'medium' },
    ],
    extract: (original, normalized) => {
      const patterns = [
        /\bskill\s+(?:called\s+|named\s+)?["'\u201C\u201D]?([a-z0-9_-]+)["'\u201C\u201D]?/i,
        /\b(?:show|open|read|get|display|describe|explain)\s+(?:the\s+)?(?:skill\s+)?["'\u201C\u201D]?([a-z0-9_-]+)["'\u201C\u201D]?\s+skill/i,
        /\b(?:about|details?\s+(?:of|on|about))\s+(?:the\s+)?["'\u201C\u201D]?([a-z0-9_-]+)["'\u201C\u201D]?/i,
      ];
      for (const re of patterns) {
        const m = original.match(re);
        if (m && m[1] && !['the', 'a', 'my', 'your', 'this', 'that', 'list', 'all', 'me'].includes(m[1].toLowerCase())) {
          return { name: m[1].toLowerCase() };
        }
      }
      // Hyphenated word as skill name
      const hyphenated = original.match(/\b([a-z]+-[a-z]+(?:-[a-z]+)*)\b/i);
      if (hyphenated) return { name: hyphenated[1].toLowerCase() };
      return null;
    },
  },

  // ── /addskill ─────────────────────────────────────────────────────────
  {
    name: 'addskill',
    patterns: [
      { re: /\b(add|create|new|register|save|upload|install) .{0,15}skill\b/, tier: 'strong' },
      { re: /\bskill .{0,10}(add|create|register|install)\b/, tier: 'strong' },
      { re: /\b(update|modify|edit|change) .{0,10}skill\b/, tier: 'medium' },
    ],
    extract: (original) => {
      const lines = original.split('\n');
      const firstLine = lines[0];
      const nameMatch = firstLine.match(/\bskill\s+(?:called\s+|named\s+)?["']?([a-z0-9_-]+)["']?/i)
        || firstLine.match(/\b(?:add|create|save|update)\s+["']?([a-z0-9_-]+)["']?/i);
      const name = nameMatch ? nameMatch[1].toLowerCase() : null;
      const content = lines.length > 1 ? lines.slice(1).join('\n').trim() : null;
      return { name, content };
    },
  },

  // ── /delskill ─────────────────────────────────────────────────────────
  {
    name: 'delskill',
    patterns: [
      { re: /\b(delete|remove|drop|uninstall|destroy) .{0,15}skill\b/, tier: 'strong' },
      { re: /\bskill .{0,10}(delete|remove|drop|uninstall)\b/, tier: 'strong' },
    ],
    extract: (original) => {
      const m = original.match(/\b(?:delete|remove|drop|uninstall)\s+(?:the\s+)?(?:skill\s+)?["']?([a-z0-9_-]+)["']?/i)
        || original.match(/\bskill\s+["']?([a-z0-9_-]+)["']?\s+(?:delete|remove)/i);
      return m ? { name: m[1].toLowerCase() } : null;
    },
  },

  // ── /files ────────────────────────────────────────────────────────────
  {
    name: 'files',
    patterns: [
      // Strong
      { re: /\b(list|show|what|display|all) .{0,15}(files?|documents?)\b/, tier: 'strong' },
      { re: /\bworkspace (files?|contents?|listing)\b/, tier: 'strong' },
      { re: /\bwhat('?s| is) in (the |my )?(workspace|folder|storage)\b/, tier: 'strong' },
      { re: /\bfiles? (in |at )?(the )?(workspace|folder|directory|storage)\b/, tier: 'strong' },
      // Medium
      { re: /\bmy files?\b/, tier: 'medium' },
      { re: /\b(ls|dir)\b/, tier: 'medium' },
      // Hebrew
      { text: 'files workspace', tier: 'strong' },
    ],
    antiPatterns: [
      /\b(send|share|give|email|forward|attach) .{0,15}(file|document|report|pdf|image|photo)\b/,
      /\bsave .{0,10}(file|url|link|article)\b/,
    ],
    extract: () => ({}),
  },

  // ── /send <path> ──────────────────────────────────────────────────────
  {
    name: 'send',
    patterns: [
      // Strong: send + file extension
      { re: /\b(send|share|give|get|pass) .{0,30}\.[a-z]{2,5}\b/, tier: 'strong' },
      { re: /\bcan (i|you) (get|have|send) .{0,15}\.[a-z]{2,5}\b/, tier: 'strong' },
      { re: /\b(send|share|give|get) .{0,20}(file|document)\b/, tier: 'strong' },
      // Medium
      { re: /\b(send|share|give|deliver|forward|attach|transfer|get|pass) (me )?(the |a |my )?/, tier: 'medium' },
      { re: /\.[a-z]{2,5}\b/, tier: 'weak' },
      { re: /\b(file|document|report|pdf|image|photo|spreadsheet|csv)\b/, tier: 'weak' },
      // Hebrew
      { text: 'send me ', tier: 'medium' },
    ],
    antiPatterns: [
      /\b(send|share) .{0,10}(message|text|notification|alert|email|whatsapp)\b/,
      /\bsend (to|it to|this to)\b/,
    ],
    extract: (original) => {
      // Priority 1: quoted path
      const quoted = original.match(/["'`]([^"'`]+\.[a-z0-9]{1,5})["'`]/i);
      if (quoted) return { path: quoted[1] };
      // Priority 2: word with file extension
      const fileExt = original.match(/\b([\w/\\.-]+\.[a-z0-9]{1,5})\b/i);
      if (fileExt && !['i.e', 'e.g', 'etc.'].includes(fileExt[1].toLowerCase())) {
        return { path: fileExt[1] };
      }
      // Priority 3: word after "send me" / "share" / "give me"
      const afterVerb = original.match(/\b(?:send|share|give|get|pass)\s+(?:me\s+)?(?:the\s+)?(\S+)/i);
      if (afterVerb && afterVerb[1].length > 2 && !['a', 'an', 'the', 'my', 'that', 'this', 'file'].includes(afterVerb[1].toLowerCase())) {
        return { path: afterVerb[1] };
      }
      return null;
    },
  },

  // ── /save <url> ───────────────────────────────────────────────────────
  {
    name: 'save',
    patterns: [
      // Strong: save/ingest + URL present
      { re: /\b(save|ingest|store|bookmark|archive|index) .{0,15}https?:\/\//, tier: 'strong' },
      { re: /\bsave\s+https?:\/\//, tier: 'strong' },
      { re: /\b(save|keep|store|remember|bookmark) (this|that|the) .{0,15}(article|link|url|page|post)\b/, tier: 'strong' },
      { re: /\b(save|ingest|store|add|remember|bookmark|archive|index) .{0,20}(url|link|article|page|site|website|post|content)\b/, tier: 'strong' },
      // Medium: URL alone + save-like word
      { re: /\bhttps?:\/\/\S+/, tier: 'medium' },
      { re: /\b(save|ingest|store|remember|bookmark|archive)\b/, tier: 'medium' },
      // Weak
      { re: /\b(knowledge base|vestige|memory|rag)\b/, tier: 'weak' },
    ],
    antiPatterns: [
      /\b(check|look at|read|open|visit|browse|see|review|analyze|what is|what's|summarize|explain|tell me about) .{0,10}https?:\/\//,
    ],
    extract: (original) => {
      const urlMatch = original.match(/(https?:\/\/\S+)/i);
      return urlMatch ? { url: urlMatch[1].replace(/[.,;:!?)\]]+$/, '') } : null;
    },
  },

];

// ---------------------------------------------------------------------------
// Core router
// ---------------------------------------------------------------------------

/**
 * Route a natural language message to an intent.
 *
 * @param {string} text - Raw user message
 * @returns {{ intent: string, confidence: number, params: object } | null}
 *          null means "no confident match — fall through to Claude"
 */
export function route(text) {
  if (!text || text.trim().length === 0) return null;

  const { normalized, lang, original } = normalize(text);
  const bBoost = brevityBoost(normalized);

  const scores = [];

  for (const intent of INTENTS) {
    // Check anti-patterns first — if any match, skip this intent
    if (intent.antiPatterns) {
      const blocked = intent.antiPatterns.some(re => re.test(normalized));
      if (blocked) {
        scores.push({ name: intent.name, confidence: 0, params: null });
        continue;
      }
    }

    // Score patterns
    let raw = scorePatterns(normalized, intent.patterns);

    // Apply brevity boost
    raw = Math.min(raw * bBoost, 1.0);

    // Extract parameters (only if there's a reasonable chance)
    let params = null;
    if (raw >= 0.4 && intent.extract) {
      params = intent.extract(original, normalized);

      // For intents that REQUIRE parameters, penalize if none found
      if (['notes', 'skill', 'send', 'save', 'delskill'].includes(intent.name) && !params) {
        raw *= 0.5;
      }
    }

    const confidence = Math.min(raw, 1.0);
    scores.push({ name: intent.name, confidence, params });
  }

  // Sort by confidence descending
  scores.sort((a, b) => b.confidence - a.confidence);

  const top = scores[0];
  const second = scores[1];

  // Debug logging
  const topThree = scores.slice(0, 3).map(s => `${s.name}:${s.confidence.toFixed(2)}`).join(', ');
  log.debug({ input: text.slice(0, 80), scores: topThree, brevity: bBoost.toFixed(2) }, 'NLU scores');

  // Check threshold
  if (top.confidence < CONFIDENCE_THRESHOLD) {
    log.debug({ top: top.name, confidence: top.confidence.toFixed(2) }, 'Below threshold, falling through');
    return null;
  }

  // Check ambiguity: if top two are very close and both above threshold
  if (second && (top.confidence - second.confidence) < AMBIGUITY_GAP && second.confidence >= CONFIDENCE_THRESHOLD) {
    log.debug({
      first: `${top.name}:${top.confidence.toFixed(2)}`,
      second: `${second.name}:${second.confidence.toFixed(2)}`,
    }, 'Ambiguous, falling through');
    return null;
  }

  log.info({
    intent: top.name,
    confidence: top.confidence.toFixed(2),
    params: top.params,
    input: text.slice(0, 60),
  }, 'NLU matched');

  return {
    intent: top.name,
    confidence: top.confidence,
    params: top.params || {},
  };
}

/**
 * Parse a slash command into the same { intent, confidence, params } format.
 * This keeps slash commands as exact shortcuts with confidence=1.0.
 */
export function parseSlashCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase().slice(1);
  const rest = trimmed.slice(parts[0].length).trim();

  switch (cmd) {
    case 'clear':    return { intent: 'clear', confidence: 1.0, params: {} };
    case 'help':     return { intent: 'help', confidence: 1.0, params: {} };
    case 'status':   return { intent: 'status', confidence: 1.0, params: {} };
    case 'crons':    return { intent: 'crons', confidence: 1.0, params: {} };
    case 'today':    return { intent: 'today', confidence: 1.0, params: {} };
    case 'skills':   return { intent: 'skills', confidence: 1.0, params: {} };
    case 'files':    return { intent: 'files', confidence: 1.0, params: {} };
    case 'notes':    return rest ? { intent: 'notes', confidence: 1.0, params: { date: rest } } : null;
    case 'skill':    return rest ? { intent: 'skill', confidence: 1.0, params: { name: rest } } : null;
    case 'addskill': {
      const nlIdx = rest.indexOf('\n');
      if (nlIdx === -1) return { intent: 'addskill', confidence: 1.0, params: { name: rest, content: null } };
      return { intent: 'addskill', confidence: 1.0, params: { name: rest.slice(0, nlIdx).trim(), content: rest.slice(nlIdx + 1).trim() } };
    }
    case 'delskill': return rest ? { intent: 'delskill', confidence: 1.0, params: { name: rest } } : null;
    case 'send':     return rest ? { intent: 'send', confidence: 1.0, params: { path: rest } } : null;
    case 'save':     return rest ? { intent: 'save', confidence: 1.0, params: { url: rest } } : null;
    default:         return null;
  }
}

/**
 * Main entry point: try slash command first (exact), then NLU (fuzzy).
 *
 * @param {string} text - Raw user message
 * @returns {{ intent: string, confidence: number, params: object } | null}
 */
export function classify(text) {
  const slash = parseSlashCommand(text);
  if (slash) return slash;
  return route(text);
}

export { INTENTS, CONFIDENCE_THRESHOLD };
