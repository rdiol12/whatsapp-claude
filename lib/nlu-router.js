/**
 * NLU Router — Natural Language Understanding for Sela
 *
 * Single source of truth for intent classification from natural language.
 * No LLM calls — uses weighted keyword/pattern matching with confidence scoring.
 *
 * Architecture:
 *   1. Normalize input (typo fix, Hebrew expansion, lowercase)
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
import { getPendingClarification } from './clarification.js';
import config from './config.js';

const log = createLogger('nlu');

// ---------------------------------------------------------------------------
// Configuration (from config.js)
// ---------------------------------------------------------------------------

const CONFIDENCE_THRESHOLD = config.nluConfidenceThreshold;  // Below this → fall through to Claude
const AMBIGUITY_GAP = config.nluAmbiguityGap;                // If top two intents are this close → fall through

// ---------------------------------------------------------------------------
// Hebrew typo normalization
// ---------------------------------------------------------------------------

/** Common Hebrew phone typos — autocorrect and fat fingers. */
const HEBREW_TYPOS = new Map([
  ['נשמא', 'נשמע'],
  ['בסדד', 'בסדר'],
  ['תודא', 'תודה'],
  ['מחאר', 'מחר'],
  ['אמתול', 'אתמול'],
  ['שלשם', 'שלשום'],
  ['סטאטוס', 'סטטוס'],
]);

function normalizeHebrew(text) {
  let result = text;
  for (const [typo, correct] of HEBREW_TYPOS) {
    result = result.replace(new RegExp(typo, 'gu'), correct);
  }
  return result;
}

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

  // --- Hebraized English (how Israelis actually type) ---
  [/סטטוס/g, 'status'],
  [/קרון(?![א-ת])/g, 'cron'],
  [/סקיל(?![א-ת])/g, 'skill'],
  [/סקילס/g, 'skills'],
  [/סקילים/g, 'skills'],
  [/טסק/g, 'task'],
  [/וורקפלואו/g, 'workflow'],
  [/וורקפלו/g, 'workflow'],
  [/בוט/g, 'bot'],
  [/לוגים/g, 'logs'],
  [/לוג(?![א-ת])/g, 'log'],
  [/באג/g, 'bug'],
  [/דיבאג/g, 'debug'],
  [/קומיט/g, 'commit'],
  [/ריסט/g, 'reset'],
  [/קליר/g, 'clear'],
  [/ריקאפ/g, 'recap'],
  [/בריין/g, 'brain'],
  [/גולס/g, 'goals'],
  [/גול(?![א-ת])/g, 'goal'],
  [/נוטס/g, 'notes'],
  [/פיילס/g, 'files'],
  [/קוסט/g, 'cost'],
];

/**
 * Normalize text: fix typos, lowercase, expand Hebrew phrases, strip excess whitespace.
 * Returns { normalized, lang, original }.
 */
function normalize(text) {
  let t = text.trim();

  // Detect language
  const hebrewChars = (t.match(/[\u0590-\u05FF]/g) || []).length;
  const latinChars = (t.match(/[a-zA-Z]/g) || []).length;
  const lang = hebrewChars > latinChars ? 'he' : latinChars > 0 ? 'en' : 'he';

  // Fix common Hebrew typos first
  if (lang === 'he') {
    t = normalizeHebrew(t);
  }

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
  const BONUS_PER_EXTRA = config.nluBonusPerExtra;
  const MAX_BONUS = config.nluMaxBonus;

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
      // Hebrew expansions (hit after HEBREW_MAP)
      { text: 'what is the status', tier: 'strong' },
      { text: 'how are you', tier: 'strong' },
      // Hebrew direct patterns
      { re: /^(?:מה\s*נשמע|מנשמע|מה\s*המצב|מהמצב|מה\s*קורה|מקורה)[\s?!]*$/, tier: 'strong' },
      { re: /^(?:אתה\s*(?:חי|עובד|שם|פה|אונליין)|הכל\s*(?:בסדר|עובד))[\s?!]*$/, tier: 'strong' },
      { re: /^(?:תן|תגיד|עדכון)\s*סטטוס[\s?!]*$/, tier: 'strong' },
      { re: /^(?:יש\s*מישהו|אתה\s*פה)[\s?!]*$/, tier: 'strong' },
      { re: /תגיד\s*לי\s*מה\s*הסטטוס/, tier: 'medium' },
      { re: /מה\s*הסטטוס\s*שלך/, tier: 'medium' },
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
      // Hebrew expansions
      { text: 'clear conversation history', tier: 'strong' },
      { text: 'start fresh clear', tier: 'strong' },
      // Hebrew direct patterns
      { re: /(?:נקה|תנקה|מחק|תמחק)\s*(?:את\s*)?(?:ה?היסטוריה|ה?שיחה|ה?צ'?אט|הכל)/, tier: 'strong' },
      { re: /(?:שיחה|צ'?אט|התחלה|דף)\s*חד?שה?/, tier: 'strong' },
      { re: /(?:נתחיל|תתחיל|בוא)\s*(?:מחדש|מאפס|מההתחלה)/, tier: 'strong' },
      { re: /^(?:איפוס|ריסט|קליר|ריסטרט)[\s?!]*$/, tier: 'strong' },
      { re: /(?:תשכח|שכח)\s*הכל/, tier: 'strong' },
      { re: /יאללה\s*מחדש/, tier: 'medium' },
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
      { re: /\bwhat (features|capabilities|abilities) (do|can|does) you have\b/, tier: 'strong' },
      { re: /\bshow (me )?(the )?(commands?|help|menu|options)\b/, tier: 'strong' },
      { re: /\blist (of )?(commands?|features|capabilities)\b/, tier: 'strong' },
      { re: /\bhow (do|can|should) i (use|interact|talk to|work with) (you|this|the bot)\b/, tier: 'strong' },
      // Medium
      { re: /^help\s*\??$/i, tier: 'strong' },
      { re: /\b(help|commands?|instructions?)\b/, tier: 'medium' },
      // Hebrew expansions
      { text: 'help commands', tier: 'strong' },
      { text: 'what can you do help', tier: 'strong' },
      // Hebrew direct patterns
      { re: /^(?:עזרה|הלפ|פקודות|תפריט|מדריך|הוראות|אופציות|הנחיות)[\s?!]*$/, tier: 'strong' },
      { re: /מה\s*(?:ה?פקודות|אפשר\s*לעשות\s*פה)/, tier: 'strong' },
      { re: /איך\s*(?:משתמשים|זה\s*עובד)/, tier: 'medium' },
      { re: /תעזור\s*לי/, tier: 'weak' },
      { re: /רשימת?\s*פקודות/, tier: 'strong' },
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
      { re: /^crons?[\s?!.]*$/i, tier: 'strong' },
      { re: /\b(show|list|what are|display|see) .{0,20}crons?\b/, tier: 'strong' },
      { re: /\bcrons? (list|jobs?|status|summary)\b/, tier: 'strong' },
      { re: /\b(show|list|what are|display) .{0,20}(scheduled|recurring) (job|task|routine)s?\b/, tier: 'strong' },
      { re: /\bwhat('?s| is) (scheduled|running|automated)\b/, tier: 'strong' },
      { re: /\bwhat crons? (are )?(running|active|scheduled|set up)\b/, tier: 'strong' },
      { re: /\bmy (crons?|scheduled jobs?|automations?|recurring tasks?)\b/, tier: 'strong' },
      // Medium
      { re: /\bcrons?\b/, tier: 'medium' },
      { re: /\b(scheduled|recurring) (job|task|routine)s?\b/, tier: 'medium' },
      { re: /\bautomations?\b/, tier: 'medium' },
      // Hebrew expansions
      { text: 'cron jobs', tier: 'strong' },
      { text: 'cron jobs scheduled', tier: 'strong' },
      // Hebrew direct patterns
      { re: /(?:הראה|תראה|הצג|רשימת?)\s*(?:ה?קרונים|ה?קרונז'?ובס)/, tier: 'strong' },
      { re: /^קרונים[\s?!]*$/, tier: 'strong' },
      { re: /(?:מה\s*)?(?:מתוזמנ|מתוכננ|רץ\s*(?:אוטומטי|ברקע))/, tier: 'medium' },
      { re: /משימות\s*(?:מתוזמנות|חוזרות)/, tier: 'medium' },
      { re: /(?:לוח\s*זמנים|אוטומצי|תזמונ)/, tier: 'weak' },
      { re: /מה\s*עם\s*ה?קרונים/, tier: 'medium' },
    ],
    antiPatterns: [
      /\b(create|add|set up|schedule|make|new) .{0,15}(cron|job|task|schedule|timer)\b/,
      /\b(delete|remove|disable|stop|toggle|pause) .{0,15}(cron|job|task)\b/,
      /\b(run|trigger|execute|fire) .{0,15}(cron|job|task)\b/,
    ],
    extract: () => ({}),
  },

  // ── /recap ────────────────────────────────────────────────────────────
  // Must come BEFORE /today to avoid recap being swallowed by today
  {
    name: 'recap',
    patterns: [
      // Strong
      { re: /^recap[\s?!.]*$/i, tier: 'strong' },
      { re: /\b(daily|end of day) recap\b/i, tier: 'strong' },
      { re: /\b(summarize|sum up) (the )?day\b/i, tier: 'strong' },
      { text: 'recap', tier: 'strong' },
      // Hebrew
      { re: /^ריקאפ[\s?!]*$/, tier: 'strong' },
      { re: /סיכום\s*(?:יום|יומי)/, tier: 'strong' },
      { re: /(?:תסכם|סכם)\s*(?:לי\s*)?(?:את\s*)?(?:העבודה)/, tier: 'strong' },
      { re: /מה\s*(?:עשית|הספקנו)\s*היום/, tier: 'medium' },
    ],
    antiPatterns: [
      /\brecap of (?!today|the day|yesterday).{5,}/, // recap of a specific topic → Claude
    ],
    extract: () => ({}),
  },

  // ── /today ────────────────────────────────────────────────────────────
  {
    name: 'today',
    patterns: [
      // Strong
      { re: /\btoday'?s? (notes?|summary|log|digest|conversations?|activity|briefing)\b/, tier: 'strong' },
      { re: /\bwhat (did we|have we) (talk|chat|discuss|do|cover|work on).{0,10}today\b/, tier: 'strong' },
      { re: /\b(show|give|get) (me )?(today|daily) (notes?|summary|log)\b/, tier: 'strong' },
      { re: /\bdaily (notes?|summary|log|briefing|digest)\b/, tier: 'strong' },
      { re: /\bsummarize today\b/, tier: 'strong' },
      { re: /\bwhat('?s| is| was) (been )?(happening|going on) today\b/, tier: 'strong' },
      { re: /\bwhat happened today\b/, tier: 'strong' },
      { re: /\btoday('?s)? (conversation|chat) (history|log)\b/, tier: 'strong' },
      // Hebrew expansions
      { text: 'what did we do today', tier: 'strong' },
      { text: 'today summary notes', tier: 'strong' },
      // Hebrew direct patterns
      { re: /סיכום\s*(?:של\s*)?היום/, tier: 'strong' },
      { re: /מה\s*(?:היה|קרה|עשינו|עברנו|דיברנו|חדש)\s*היום/, tier: 'strong' },
      { re: /(?:דו"?ח|הערות|לוג|נוטס)\s*(?:של\s*)?היום/, tier: 'medium' },
      { re: /תסכם\s*(?:לי\s*)?(?:את\s*)?היום/, tier: 'strong' },
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
      // Hebrew
      { re: /מה\s*היה\s*(?:אתמול|שלשום|ביום\s+\S+|בשבת|לפני)/, tier: 'strong' },
    ],
    extract: (original, normalized) => {
      // Try ISO date first
      const isoMatch = original.match(/(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) return { date: isoMatch[1] };

      // Natural date references
      const now = new Date();
      const tzOffset = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));

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
      { re: /^skills?[\s?!.]*$/i, tier: 'strong' },
      { re: /\b(list|show|what are|display|all) .{0,15}skills?\b/, tier: 'strong' },
      { re: /\bskills? (list|available|loaded|installed)\b/, tier: 'strong' },
      { re: /\bwhat skills?\b/, tier: 'strong' },
      { re: /\bavailable skills?\b/, tier: 'strong' },
      { re: /\byour (skills?|abilities|capabilities)\b/, tier: 'strong' },
      // Hebrew expansions
      { text: 'skills abilities', tier: 'strong' },
      { text: 'skills abilities capabilities', tier: 'strong' },
      // Hebrew direct patterns
      { re: /מה\s*(?:אתה\s*)?(?:יודע|מסוגל|יכול)\s*(?:לעשות)?/, tier: 'medium' },
      { re: /(?:רשימת?\s*)?(?:כישורים|סקילס|סקילים|יכולות)/, tier: 'strong' },
      { re: /ארגז\s*(?:ה?כלים)/, tier: 'strong' },
      { re: /(?:הראה|הצג|תראה)\s*(?:כישורים|סקילס)/, tier: 'strong' },
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
      { re: /\blist\s+workspace\b/, tier: 'strong' },
      { re: /\bwhat('?s| is) in (the |my )?(workspace|folder|storage)\b/, tier: 'strong' },
      { re: /\bfiles? (in |at )?(the )?(workspace|folder|directory|storage)\b/, tier: 'strong' },
      // Medium
      { re: /\bmy files?\b/, tier: 'medium' },
      { re: /\b(ls|dir)\b/, tier: 'medium' },
      // Hebrew expansions
      { text: 'files workspace', tier: 'strong' },
      // Hebrew direct patterns
      { re: /(?:אילו|מה|הראה|הצג|תראה|רשימת?)\s*(?:ה?קבצים|ה?מסמכים|פיילס)/, tier: 'strong' },
      { re: /^(?:קבצים|פיילס)(?:\s*שלי)?[\s?!]*$/, tier: 'strong' },
      { re: /מה\s*(?:שמור|שמרתי|העלתי|יש\s*ב?וורקספייס)/, tier: 'medium' },
      { re: /תביא\s*לי\s*(?:את\s*)?ה?קבצים/, tier: 'medium' },
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

  // ── /goals ────────────────────────────────────────────────────────────
  {
    name: 'goals',
    patterns: [
      // Strong
      { re: /^goals?[\s?!.]*$/i, tier: 'strong' },
      { re: /\b(show|list|what(?:'s)?|my|display) .{0,10}goals?\b/i, tier: 'strong' },
      { re: /\bwhat am i (working on|tracking)\b/i, tier: 'medium' },
      { re: /\b(active|current) (goals|objectives)\b/i, tier: 'medium' },
      // Hebrew
      { re: /^(?:מטרות|יעדים|גולס)[\s?!]*$/, tier: 'strong' },
      { re: /(?:מה\s*)?(?:ה?מטרות|ה?יעדים)\s*(?:שלי)?/, tier: 'strong' },
      { re: /(?:הראה|תראה|הצג)\s*(?:ה?מטרות|ה?יעדים|גולס)/, tier: 'strong' },
      { re: /(?:על\s*)?מה\s*(?:אני\s*)?(?:עובד|עובדת)/, tier: 'medium' },
    ],
    antiPatterns: [
      /\bgoal\s*(?:setting|oriented|driven)\b/i,
      /\b(add|create|new|set) .{0,10}goal\b/i, // goal creation → goal-manage
    ],
    extract: () => ({}),
  },

  // ── /brain ────────────────────────────────────────────────────────────
  {
    name: 'brain',
    patterns: [
      // Strong
      { re: /^(?:brain|agent\s*brain)[\s?!.]*$/i, tier: 'strong' },
      { re: /\b(what|show)\s*(has\s*)?(the\s*)?(brain|agent)\s*(noticed|detected|learned|observed)\b/i, tier: 'strong' },
      { re: /\b(brain|agent)\s*(status|patterns|observations)\b/i, tier: 'strong' },
      // Hebrew
      { re: /^(?:מוח|בריין)[\s?!]*$/, tier: 'strong' },
      { re: /(?:מה\s*)?(?:ה?מוח|ה?אייג'?נט)\s*(?:זיהה|למד|שם\s*לב)/, tier: 'strong' },
      { re: /מה\s*ה?בוט\s*(?:זיהה|שם\s*לב|למד)/, tier: 'medium' },
    ],
    extract: () => ({}),
  },

  // ── /trust ──────────────────────────────────────────────────────────
  {
    name: 'trust',
    patterns: [
      // Strong
      { re: /^trust[\s?!.]*$/i, tier: 'strong' },
      { re: /\btrust (report|scores?|levels?|status|summary)\b/i, tier: 'strong' },
      { re: /\b(show|get|display|what(?:'s)?|my) .{0,10}trust\b/i, tier: 'strong' },
      { re: /\bautonomy (report|levels?|scores?|status)\b/i, tier: 'strong' },
      { re: /\bhow much (do you|does the bot) trust\b/i, tier: 'medium' },
      // Hebrew
      { re: /^(?:אמון|טראסט)[\s?!]*$/, tier: 'strong' },
      { re: /(?:דוח|רמת?|סטטוס)\s*(?:אמון|טראסט)/, tier: 'strong' },
      { re: /(?:הראה|תראה|הצג)\s*(?:ה?אמון|ה?טראסט)/, tier: 'strong' },
      { re: /כמה\s*(?:אוטונומי|עצמא)/, tier: 'medium' },
    ],
    extract: () => ({}),
  },

  // ── /workflows ────────────────────────────────────────────────────────
  {
    name: 'workflows',
    patterns: [
      // Strong
      { re: /^(?:workflows?|wf)[\s?!.]*$/i, tier: 'strong' },
      { re: /\b(show|list|what(?:'s)?|my|display) .{0,10}workflows?\b/i, tier: 'strong' },
      { re: /\b(active|running|current) workflows?\b/i, tier: 'strong' },
      { re: /\bwhat (workflows?|tasks?) (are\s*)?(running|active)\b/i, tier: 'medium' },
      // Hebrew
      { re: /^(?:וורקפלו[זס]?|תהליכים)[\s?!]*$/, tier: 'strong' },
      { re: /(?:מה\s*)?(?:ה?וורקפלו[זס]?|ה?תהליכים)\s*(?:רצים|פעילים)?/, tier: 'strong' },
      { re: /(?:הראה|תראה|הצג)\s*(?:ה?וורקפלו[זס]?|ה?תהליכים)/, tier: 'strong' },
    ],
    extract: () => ({}),
  },

  // ── /cost ─────────────────────────────────────────────────────────────
  {
    name: 'cost',
    patterns: [
      // Strong
      { re: /^(?:costs?|spending|budget)[\s?!.]*$/i, tier: 'strong' },
      { re: /\b(how much|what'?s?\s*(the\s*)?cost|spending|spend|usage)\s*(today|this week|this month)?\b/i, tier: 'strong' },
      // Hebrew
      { re: /(?:כמה\s*(?:עלה|עולה|זה\s*עולה)|עלויות?|תקציב|הוצאות)/, tier: 'strong' },
      { re: /^(?:קוסט|עלות)[\s?!]*$/, tier: 'strong' },
      { re: /כמה\s*(?:הוצאתי|עלה\s*לי)\s*(?:היום|השבוע)?/, tier: 'medium' },
    ],
    extract: () => ({}),
  },

  // ── addcron ─────────────────────────────────────────────────────────
  {
    name: 'addcron',
    patterns: [
      // Strong: explicit "add/create cron"
      { re: /\b(add|create|set up|schedule|make|new) .{0,15}(cron|job|timer|automation|recurring)\b/i, tier: 'strong' },
      { re: /\b(cron|job|task) .{0,10}(add|create|schedule|set up)\b/i, tier: 'strong' },
      { re: /\bschedule .{0,10}(daily|weekly|hourly|every)\b/i, tier: 'strong' },
      { re: /\b(every|each) (day|morning|evening|hour|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday) .{0,20}(send|check|remind|report|run)\b/i, tier: 'strong' },
      { re: /\bremind me (every|daily|weekly)\b/i, tier: 'strong' },
      // Hebrew
      { re: /(?:הוסף|צור|תוסיף|תצור)\s*(?:קרון|משימה\s*מתוזמנת|תזמון)/, tier: 'strong' },
      { re: /(?:תזמן|תתזמן)\s*(?:לי\s*)?/, tier: 'medium' },
      { re: /(?:כל\s*(?:יום|בוקר|ערב|שעה))\s*.{5,}/, tier: 'medium' },
    ],
    extract: (original) => {
      // Try to extract name, schedule, and prompt from the message
      // Pattern: "add cron <name> every/at <schedule> <prompt>"
      // Or: "every day at 9am send me ..."
      return { raw: original };
    },
  },

  // ── user-notes ────────────────────────────────────────────────────────
  {
    name: 'user-notes',
    patterns: [
      // Strong
      { re: /^(?:my\s*notes?|personal\s*notes?)[\s?!.]*$/i, tier: 'strong' },
      { re: /\b(show|list|what(?:'s\s*in)?)\s*my\s*notes?\b/i, tier: 'strong' },
      // Hebrew
      { re: /^(?:הערות|נוטס)\s*(?:שלי)?[\s?!]*$/, tier: 'strong' },
      { re: /מה\s*ה?הערות\s*שלי/, tier: 'strong' },
      { re: /(?:הראה|תראה)\s*(?:את\s*)?ה?הערות\s*(?:שלי)?/, tier: 'strong' },
    ],
    extract: () => ({}),
  },

  // ── learning ────────────────────────────────────────────────────────
  {
    name: 'learning',
    patterns: [
      { re: /^learning[\s?!.]*$/i, tier: 'strong' },
      { re: /^lessons?[\s?!.]*$/i, tier: 'strong' },
      { re: /^rules?[\s?!.]*$/i, tier: 'strong' },
      { re: /\b(show|list|get|what)\s*.{0,10}(learning|lessons?|rules?)\b/i, tier: 'strong' },
      { re: /\bwhat have you learned\b/i, tier: 'strong' },
      { re: /\blearning (journal|rules?|log|entries|stats)\b/i, tier: 'strong' },
      // Hebrew
      { re: /^(?:לקחים|לימודים|כללים)[\s?!]*$/, tier: 'strong' },
      { re: /(?:מה\s*)?(?:למדת|למדנו)/, tier: 'strong' },
      { re: /(?:הראה|תראה|הצג)\s*(?:ה?לקחים|ה?כללים|ה?לימודים)/, tier: 'strong' },
    ],
    extract: () => ({}),
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
    // Check both normalized and original to match dual scoring paths
    if (intent.antiPatterns) {
      const originalLower = original.toLowerCase();
      const blocked = intent.antiPatterns.some(re => re.test(normalized) || re.test(originalLower));
      if (blocked) {
        scores.push({ name: intent.name, confidence: 0, params: null });
        continue;
      }
    }

    // Score patterns
    let raw = scorePatterns(normalized, intent.patterns);

    // Also score against original text (catches Hebrew patterns before expansion)
    const rawOriginal = scorePatterns(original.toLowerCase(), intent.patterns);
    if (rawOriginal > raw) raw = rawOriginal;

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
    case 'goals':    return { intent: 'goals', confidence: 1.0, params: {} };
    case 'brain':    return { intent: 'brain', confidence: 1.0, params: {} };
    case 'trust':    return { intent: 'trust', confidence: 1.0, params: {} };
    case 'learning':
    case 'lessons':
    case 'rules':  return { intent: 'learning', confidence: 1.0, params: {} };
    case 'wf':
    case 'workflows': {
      if (!rest) return { intent: 'workflows', confidence: 1.0, params: {} };
      const wfParts = rest.split(/\s+/);
      return { intent: 'workflow-manage', confidence: 1.0, params: { subCmd: wfParts[0], arg: wfParts.slice(1).join(' ') || null } };
    }
    case 'recap':    return { intent: 'recap', confidence: 1.0, params: {} };
    case 'digest':   return { intent: 'digest', confidence: 1.0, params: { subCmd: rest || null } };
    case 'cost':
    case 'costs':    return { intent: 'cost', confidence: 1.0, params: {} };
    case 'addcron':  return rest ? { intent: 'addcron', confidence: 1.0, params: { raw: rest } } : null;
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
    case 'reasoning':       return { intent: 'reasoning', confidence: 1.0, params: {} };
    case 'confidence':      return { intent: 'confidence', confidence: 1.0, params: {} };
    case 'usermodel':       return { intent: 'usermodel', confidence: 1.0, params: {} };
    case 'gaps':            return { intent: 'gaps', confidence: 1.0, params: {} };
    case 'experiments':     return { intent: 'experiments', confidence: 1.0, params: {} };
    case 'proposed-goals':  return { intent: 'proposed-goals', confidence: 1.0, params: {} };
    case 'approve-goal':    return rest ? { intent: 'approve-goal', confidence: 1.0, params: { arg: rest } } : null;
    case 'reject-goal':     return rest ? { intent: 'reject-goal', confidence: 1.0, params: { arg: rest } } : null;
    default:         return null;
  }
}

/**
 * Main entry point: try slash command first (exact), then NLU (fuzzy).
 *
 * @param {string} text - Raw user message
 * @returns {{ intent: string, confidence: number, params: object } | null}
 */
export function classify(text, jid) {
  // If this JID has a pending clarification, skip NLU — it's an answer, not a command
  if (jid && getPendingClarification(jid)) return null;

  const slash = parseSlashCommand(text);
  if (slash) return slash;

  // Skip fuzzy NLU for longer messages — slash commands still work at any length
  if (text.trim().length > 10) {
    log.debug({ len: text.trim().length }, 'Skipping NLU, message too long');
    return null;
  }

  return route(text);
}

export { INTENTS, CONFIDENCE_THRESHOLD };
