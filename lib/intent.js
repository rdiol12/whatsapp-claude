/**
 * Natural language intent recognition for Hebrew + English.
 * Fast, local, no LLM call — regex/keyword matching.
 *
 * Sits between slash-command parsing and Claude fallthrough.
 * Returns matched intent or null (→ falls through to Claude).
 */

import { createLogger } from './logger.js';

const log = createLogger('intent');

// --- Hebrew date helpers ---

const HEBREW_NUMBERS = {
  'אחד': 1, 'שניים': 2, 'שנים': 2, 'שלושה': 3, 'ארבעה': 4,
  'חמישה': 5, 'שישה': 6, 'שבעה': 7, 'שמונה': 8, 'תשעה': 9, 'עשרה': 10,
  'אחת': 1, 'שתיים': 2, 'שתי': 2, 'שלוש': 3, 'ארבע': 4,
  'חמש': 5, 'שש': 6, 'שבע': 7, 'תשע': 9, 'עשר': 10,
};

const AGO_RE = /לפני\s+(?:(\d+)|([א-ת]+))\s+(ימים|שעות|דקות|שבועות|חודשים)/;

export function parseHebrewDate(text) {
  if (/היום/.test(text)) return new Date();
  if (/אתמול/.test(text)) { const d = new Date(); d.setDate(d.getDate() - 1); return d; }
  if (/שלשום/.test(text)) { const d = new Date(); d.setDate(d.getDate() - 2); return d; }

  const agoMatch = text.match(AGO_RE);
  if (agoMatch) {
    const num = agoMatch[1] ? parseInt(agoMatch[1]) : (HEBREW_NUMBERS[agoMatch[2]] || 0);
    const unit = agoMatch[3];
    const d = new Date();
    if (unit === 'ימים') d.setDate(d.getDate() - num);
    else if (unit === 'שעות') d.setHours(d.getHours() - num);
    else if (unit === 'שבועות') d.setDate(d.getDate() - num * 7);
    else if (unit === 'חודשים') d.setMonth(d.getMonth() - num);
    return d;
  }

  const dayMatch = text.match(/ב?יום\s+(ראשון|שני|שלישי|רביעי|חמישי|שישי)|בשבת/);
  if (dayMatch) {
    const dayMap = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5 };
    const targetDay = dayMatch[1] ? dayMap[dayMatch[1]] : 6;
    const d = new Date();
    let diff = d.getDay() - targetDay;
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() - diff);
    return d;
  }

  // DD/MM or DD.MM (Israeli format)
  const dateMatch = text.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  if (dateMatch) {
    const day = parseInt(dateMatch[1]);
    const month = parseInt(dateMatch[2]) - 1;
    const year = dateMatch[3]
      ? (dateMatch[3].length === 2 ? 2000 + parseInt(dateMatch[3]) : parseInt(dateMatch[3]))
      : new Date().getFullYear();
    return new Date(year, month, day);
  }

  return null;
}

function formatDate(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD
}

// --- Intent definitions ---

const INTENTS = {
  STATUS_CHECK: {
    action: 'status',
    patterns: [
      // Hebrew — short messages only (anchored to avoid false positives)
      /^(?:מה\s*נשמע|מנשמע|מה\s*המצב|מהמצב|מה\s*קורה|מקורה)[\s?!]*$/,
      /^(?:אתה\s*(?:חי|עובד|שם|פה|אונליין)|הכל\s*(?:בסדר|עובד)|חי|עובד)[\s?!]*$/,
      /^(?:סטטוס|מצב\s*(?:ה?בוט)?|בדיקת?\s*בריאות|צ'?ק\s*אין)[\s?!]*$/,
      /^(?:תן|תגיד|עדכון)\s*סטטוס[\s?!]*$/,
      /^(?:יש\s*מישהו|אתה\s*פה)[\s?!]*$/,
      // English — short messages only
      /^(?:status|how\s*are\s*you|how'?s?\s*(?:the\s*bot|it\s*going)|you\s*(?:up|online|there))[\s?!.]*$/i,
      /^(?:are\s*you\s*(?:alive|there|working|online)|everything?\s*ok|health\s*check|check\s*in)[\s?!.]*$/i,
      /^(?:bot\s*status|system\s*status|status\s*(?:update|report|check))[\s?!.]*$/i,
    ],
  },

  CLEAR_HISTORY: {
    action: 'clear',
    patterns: [
      // Hebrew
      /(?:נקה|תנקה|מחק|תמחק)\s*(?:את\s*)?(?:ה?היסטוריה|ה?שיחה|ה?צ'?אט|הכל)/,
      /(?:שיחה|צ'?אט|התחלה|דף)\s*חד?שה?/,
      /(?:נתחיל|תתחיל|בוא)\s*(?:מחדש|מאפס|מההתחלה)/,
      /^(?:איפוס|ריסט|קליר|ריסטרט)[\s?!]*$/,
      /(?:תשכח|שכח)\s*הכל/,
      /יאללה\s*מחדש/,
      // English
      /(?:clear|wipe|erase|delete|reset)\s*(?:the\s*)?(?:chat|history|conversation)/i,
      /(?:start\s*(?:fresh|over)|new\s*(?:chat|conversation)|fresh\s*start|clean\s*slate)/i,
      /(?:forget\s*everything|begin\s*again|blank\s*slate)/i,
    ],
  },

  SHOW_CRONS: {
    action: 'crons',
    patterns: [
      // Hebrew
      /(?:הראה|תראה|הצג|רשימת?)\s*(?:ה?קרונים|ה?קרונז'?ובס)/,
      /^קרונים[\s?!]*$/,
      /(?:מה\s*)?(?:מתוזמנ|מתוכננ|רץ\s*(?:אוטומטי|ברקע))/,
      /משימות\s*(?:מתוזמנות|חוזרות)/,
      /(?:לוח\s*זמנים|אוטומצי|תזמונ)/,
      // English
      /^crons?[\s?!.]*$/i,
      /(?:show|list|what(?:'s)?)\s*(?:the\s*)?(?:schedul|cron|recurring|timed\s*task|automation)/i,
      /what\s*runs\s*(?:automatically|in\s*(?:the\s*)?background)/i,
    ],
  },

  TODAY_NOTES: {
    action: 'today',
    extractDate: true,
    patterns: [
      // Hebrew
      /סיכום\s*(?:של\s*)?(?:היום|יומי|אתמול|שלשום)/,
      /מה\s*(?:היה|קרה|עשינו|עברנו|דיברנו|חדש)\s*היום/,
      /(?:דו"?ח|הערות|לוג|נוטס)\s*(?:של\s*)?(?:היום|יומי)/,
      /תסכם\s*(?:לי\s*)?(?:את\s*)?(?:היום|אתמול)/,
      /^ריקאפ[\s?!]*$/,
      /מה\s*היה\s*(?:אתמול|שלשום|ביום\s+\S+|בשבת|לפני)/,
      // English
      /today'?s?\s*(?:summary|notes|log|activity|report)/i,
      /daily\s*(?:summary|notes|report|log)/i,
      /what\s*(?:happened|went\s*on|did\s*(?:we|you)\s*(?:do|talk\s*about))\s*today/i,
      /(?:recap|show)\s*today/i,
      /yesterday'?s?\s*(?:summary|notes)/i,
    ],
  },

  LIST_FILES: {
    action: 'files',
    patterns: [
      // Hebrew
      /(?:אילו|מה|הראה|הצג|תראה|רשימת?)\s*(?:ה?קבצים|ה?מסמכים|פיילס)/,
      /^(?:קבצים|פיילס)(?:\s*שלי)?[\s?!]*$/,
      /מה\s*(?:שמור|שמרתי|העלתי|יש\s*ב?וורקספייס)/,
      // English
      /(?:list|show|my|workspace)\s*files/i,
      /file\s*list/i,
      /what\s*(?:files|documents)/i,
      /what'?s?\s*(?:in\s*the\s*workspace|saved|uploaded)/i,
      /^(?:ls|dir)$/i,
    ],
  },

  LIST_SKILLS: {
    action: 'skills',
    patterns: [
      // Hebrew
      /מה\s*(?:אתה\s*)?(?:יודע|מסוגל|יכול)\s*(?:לעשות)?/,
      /(?:רשימת?\s*)?(?:כישורים|סקילס|סקילים|יכולות)/,
      /ארגז\s*(?:ה?כלים)/,
      /(?:הראה|הצג|תראה)\s*(?:כישורים|סקילס)/,
      // English
      /(?:what\s*(?:can\s*you\s*do|skills|abilities|features|tools))/i,
      /(?:list|show|available)\s*skills/i,
      /^(?:skills|capabilities|abilities|features)[\s?!.]*$/i,
    ],
  },

  COST_CHECK: {
    action: 'cost',
    patterns: [
      /(?:how much|what'?s?\s*(?:the\s*)?cost|spending|spend|usage)\s*(?:today|this\s*week|this\s*month)?/i,
      /^(?:costs?|spending|budget)[\s?!.]*$/i,
      /(?:כמה\s*(?:עלה|עולה|זה\s*עולה)|עלויות?|תקציב|הוצאות)/,
    ],
  },

  SHOW_GOALS: {
    action: 'goals',
    patterns: [
      // Hebrew
      /^(?:מטרות|יעדים|גולס)[\s?!]*$/,
      /(?:מה\s*)?(?:ה?מטרות|ה?יעדים)\s*(?:שלי)?/,
      /(?:הראה|תראה|הצג)\s*(?:ה?מטרות|ה?יעדים|גולס)/,
      /(?:על\s*)?מה\s*(?:אני\s*)?(?:עובד|עובדת)/,
      // English
      /^goals?[\s?!.]*$/i,
      /(?:show|list|what(?:'s)?|my)\s*goals/i,
      /what\s*am\s*I\s*(?:working\s*on|tracking)/i,
      /(?:active|current)\s*(?:goals|objectives|projects)/i,
    ],
  },

  BRAIN_STATUS: {
    action: 'brain',
    patterns: [
      /^(?:brain|agent brain)[\s?!.]*$/i,
      /(?:what|show)\s*(?:has\s*)?(?:the\s*)?(?:brain|agent)\s*(?:noticed|detected|observed|learned)/i,
      /(?:brain|agent)\s*(?:status|patterns|observations)/i,
      /(?:מה\s*)?(?:ה?מוח|ה?אייג'?נט)\s*(?:זיהה|למד|שם לב)/,
    ],
  },

  SHOW_WORKFLOWS: {
    action: 'workflows',
    patterns: [
      /^(?:workflows?|wf)[\s?!.]*$/i,
      /(?:show|list|what(?:'s)?|my)\s*workflows/i,
      /(?:active|running|current)\s*workflows/i,
      /what\s*(?:workflows?|tasks?)\s*(?:are\s*)?(?:running|active)/i,
      /(?:מה\s*)?(?:ה?וורקפלו[זס]?|ה?תהליכים)\s*(?:רצים|פעילים)?/,
      /(?:הראה|תראה|הצג)\s*(?:ה?וורקפלו[זס]?|ה?תהליכים)/,
    ],
  },

  HELP: {
    action: 'help',
    patterns: [
      // Hebrew
      /^(?:עזרה|הלפ|פקודות|תפריט|מדריך|הוראות|אופציות|הנחיות)[\s?!]*$/,
      /מה\s*(?:ה?פקודות|אפשר\s*לעשות\s*פה)/,
      /איך\s*(?:משתמשים|זה\s*עובד)/,
      /תעזור\s*לי/,
      /רשימת?\s*פקודות/,
      // English
      /^(?:help|commands|menu|options|instructions|guide|usage)[\s?!.]*$/i,
      /(?:what|show|list)\s*commands/i,
      /how\s*(?:to\s*use|does\s*this\s*work)/i,
      /what\s*are\s*(?:the\s*(?:available\s*)?commands|my\s*options)/i,
    ],
  },
};

/**
 * Match user input to an intent.
 * @param {string} text - Raw user message
 * @returns {{ intent: string, action: string, params: object } | null}
 */
// --- Message tier classification ---

/**
 * Classify message into processing tiers.
 * Tier 0: Acknowledgments (thumbs-up, no LLM)
 * Tier 1: Short simple messages (lightweight context)
 * Tier 2: Standard messages (full context)
 * Tier 3: Complex tasks (full context + extras)
 */
export function classifyTier(text) {
  const trimmed = text.trim();
  const len = trimmed.length;
  const words = trimmed.split(/\s+/).length;

  // Tier 0: Pure acknowledgments — no LLM needed
  if (/^(ok|okay|k|sure|thanks|thx|thank you|cool|nice|got it|yep|yea|nah|lol|haha|np|ty|gg|bet|word|aight|אוקיי?|תודה|סבבה|יפה|טוב|בסדר|לול|חחח|נייס|אחלה|מעולה|תותח|קול)[\s!.]*$/i.test(trimmed)) {
    return { tier: 0, reason: 'acknowledgment' };
  }

  // Tier 3: Complex tasks — coding, multi-step, URLs, long messages
  const TIER3_EN = /```|code|build|create|fix|debug|refactor|deploy|analyze|review|audit|migrate|implement|configure|setup|install|write\s+(?:a\s+)?(?:script|function|code|test|module)/i;
  const TIER3_HE = /קוד|תקן|בנה|דיבאג|רפקטור|דיפלוי|תכנת|תיקון|באג|שגיאה|סקריפט|פונקציה|מודול|תבדוק|תנתח|תסביר.*(?:קוד|שגיאה|בעיה)/;
  const TIER3_SIGNALS = /\?\s*\?|!\s*!|help me (?:write|build|create|fix|set ?up|configure)/i;
  if (TIER3_EN.test(trimmed) || TIER3_HE.test(trimmed) || TIER3_SIGNALS.test(trimmed)
      || trimmed.includes('http') || len > 500) {
    return { tier: 3, reason: 'complex_task' };
  }

  // Tier 1: Short simple messages — but only if truly simple
  // Questions with "how", "why", "can you", "explain" are at least Tier 2 even if short
  const COMPLEXITY_SIGNALS = /\bhow\b|why\b|explain|can you|could you|please\b.*\?|set ?up|automated?|איך|למה|תסביר|אפשר ל/i;
  if (words <= 6 && len < 80 && !COMPLEXITY_SIGNALS.test(trimmed)) {
    return { tier: 1, reason: 'short_message' };
  }

  // Tier 2: Standard
  return { tier: 2, reason: 'standard' };
}

export function matchIntent(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return null;

  for (const [intentName, config] of Object.entries(INTENTS)) {
    let matched = false;

    if (config.detect) {
      matched = config.detect(trimmed);
    }

    if (!matched && config.patterns) {
      matched = config.patterns.some(re => re.test(trimmed));
    }

    if (matched) {
      const result = { intent: intentName, action: config.action, params: {} };

      // Extract parameters
      if (config.extractParam && config.paramRegex) {
        for (const re of config.paramRegex) {
          const m = trimmed.match(re);
          if (m && m[1]) {
            result.params.value = m[1].trim();
            break;
          }
        }
      }

      // Extract date for notes intents
      if (config.extractDate) {
        const d = parseHebrewDate(trimmed);
        if (d) result.params.date = formatDate(d);
      }

      log.info({ intent: intentName, action: config.action, params: result.params }, 'Intent matched');
      return result;
    }
  }

  return null;
}
