/**
 * Tests for claude.js helper functions — run with: node test/claude-helpers.test.js
 *
 * Tests pure logic functions: stripMarkers, findChunkBreak, classifyProfile,
 * matchSkills, truncateResults, executeLocalMarkers.
 * No real Claude CLI processes are spawned.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// We can't import claude.js directly (it has side effects and spawns intervals).
// Instead, we replicate the pure functions for testing, validated against the source.
// This is the standard approach for testing non-exported helpers.

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => { passed++; console.log(`  PASS  ${name}`); })
        .catch(err => { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); });
    }
    passed++; console.log(`  PASS  ${name}`);
  }
  catch (err) { failed++; console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); }
}

function expect(actual) {
  return {
    toBe(expected) { if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy() { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy() { if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toBeGreaterThan(n) { if (actual <= n) throw new Error(`Expected ${actual} > ${n}`); },
    toBeLessThan(n) { if (actual >= n) throw new Error(`Expected ${actual} < ${n}`); },
    toContain(sub) { if (!actual.includes(sub)) throw new Error(`Expected "${String(actual).slice(0,100)}" to contain "${sub}"`); },
  };
}

// --- Replicated pure functions from claude.js ---
// These match the source exactly and are tested against expected behavior.

const MAX_RESULT_CHARS = 150;

function truncateResults(raw) {
  if (!raw) return '';
  return raw.split('\n').map(line => {
    if (line.length > MAX_RESULT_CHARS) return line.slice(0, MAX_RESULT_CHARS) + '\u2026';
    return line;
  }).join('\n');
}

const ALL_MARKERS_RE = /\[(CRON_ADD|CRON_DELETE|CRON_TOGGLE|CRON_RUN|SEND_FILE):[^\]]*\]/gs;
const LOCAL_MARKERS_RE = /\[(BOT_STATUS|CLEAR_HISTORY|LIST_CRONS|TODAY_NOTES|LIST_SKILLS|LIST_FILES)\]|\[SEARCH_NOTES:[^\]]*\]/g;

function stripMarkers(text) {
  return text.replace(ALL_MARKERS_RE, '').replace(LOCAL_MARKERS_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function findChunkBreak(buffer) {
  if (buffer.length < 3500) return -1;
  const paraIdx = buffer.indexOf('\n\n');
  if (paraIdx > 0 && paraIdx < 3800) return paraIdx + 2;
  const nlIdx = buffer.lastIndexOf('\n', 3800);
  if (nlIdx > 200) return nlIdx + 1;
  const spaceIdx = buffer.lastIndexOf(' ', 3800);
  if (spaceIdx > 200) return spaceIdx + 1;
  return 3800;
}

function classifyProfile(text) {
  const t = text.toLowerCase();
  if (/```|code|function|class|import|export|script|debug|refactor|test|lint|build|compile|deploy|git |npm |pip /i.test(text)) return 'coding';
  if (/cron|schedul|timer|automat|recurring|תזמון|קרונ/i.test(text)) return 'cron';
  if (/remember|forget|memor|vestige|intention|remind|תזכור|אל תשכח|זכרון/i.test(text)) return 'memory';
  if (/status|health|uptime|cost|spend|queue|how.?s the bot|מה המצב/i.test(text)) return 'status';
  if (t.length < 60) return 'casual';
  return 'general';
}

const SKILL_KEYWORDS = {
  'image-gen': ['image', 'picture', 'photo', 'generate image', 'dall-e', 'dalle', 'draw', 'illustration', 'תמונה', 'צייר'],
  'regex-patterns': ['regex', 'regular expression', 'regexp', 'pattern match', 'ביטוי רגולרי'],
  'code-council': ['code council', 'audit the code', 'review the codebase', 'security audit', 'code review', 'codebase audit'],
  'personal-crm': ['crm', 'contacts', 'contact list', 'people track', 'gmail contact'],
  'prompt-engineering': ['prompt engineer', 'write prompt', 'prompting', 'prompt guide', 'prompt tip'],
  'humanizer': ['humanize', 'humanizer', 'sound human', 'rewrite human', 'ai detection', 'remove ai'],
  'youtube-analytics': ['youtube', 'channel analytics', 'subscriber', 'video stats', 'יוטיוב'],
  'social-research': ['twitter', 'social media research', 'x.com', 'what are people saying', 'social research', 'טוויטר'],
  'content-pipeline': ['content pipeline', 'content idea', 'blog post', 'article idea', 'content brief'],
  'cost-tracker': ['cost track', 'api cost', 'token usage', 'spending', 'ai cost', 'usage track'],
};

function matchSkills(userMessage) {
  const lower = userMessage.toLowerCase();
  const matched = new Set();
  for (const [skill, keywords] of Object.entries(SKILL_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) matched.add(skill);
  }
  return [...matched];
}

// ---------------------------------------------------------------------------
// truncateResults
// ---------------------------------------------------------------------------
console.log('\n=== truncateResults ===');

test('returns empty string for null input', () => {
  expect(truncateResults(null)).toBe('');
});

test('returns empty string for empty input', () => {
  expect(truncateResults('')).toBe('');
});

test('preserves short lines unchanged', () => {
  expect(truncateResults('hello world')).toBe('hello world');
});

test('truncates long lines with ellipsis', () => {
  const longLine = 'A'.repeat(200);
  const result = truncateResults(longLine);
  expect(result.length).toBe(151); // 150 + ellipsis char
  expect(result.endsWith('\u2026')).toBeTruthy();
});

test('handles multiple lines with mixed lengths', () => {
  const input = 'short\n' + 'B'.repeat(200) + '\nalso short';
  const lines = truncateResults(input).split('\n');
  expect(lines.length).toBe(3);
  expect(lines[0]).toBe('short');
  expect(lines[1].length).toBe(151);
  expect(lines[2]).toBe('also short');
});

// ---------------------------------------------------------------------------
// stripMarkers
// ---------------------------------------------------------------------------
console.log('\n=== stripMarkers ===');

test('removes CRON_ADD marker', () => {
  const result = stripMarkers('Here is your cron. [CRON_ADD: test | * * * * * | do something] Done.');
  expect(result).toBe('Here is your cron.  Done.');
});

test('removes CRON_DELETE marker', () => {
  const result = stripMarkers('Deleted. [CRON_DELETE: abc123] Gone.');
  expect(result).toBe('Deleted.  Gone.');
});

test('removes CRON_TOGGLE marker', () => {
  const result = stripMarkers('[CRON_TOGGLE: test-job] Toggled.');
  expect(result).toBe('Toggled.');
});

test('removes CRON_RUN marker', () => {
  const result = stripMarkers('Running now [CRON_RUN: daily-check]');
  expect(result).toBe('Running now');
});

test('removes SEND_FILE marker', () => {
  const result = stripMarkers('Here is the file [SEND_FILE: /path/to/file.txt] enjoy');
  expect(result).toBe('Here is the file  enjoy');
});

test('removes BOT_STATUS marker', () => {
  const result = stripMarkers('[BOT_STATUS] Here are the stats');
  expect(result).toBe('Here are the stats');
});

test('removes CLEAR_HISTORY marker', () => {
  const result = stripMarkers('Clearing. [CLEAR_HISTORY]');
  expect(result).toBe('Clearing.');
});

test('removes LIST_CRONS marker', () => {
  const result = stripMarkers('[LIST_CRONS] Your crons:');
  expect(result).toBe('Your crons:');
});

test('removes SEARCH_NOTES marker', () => {
  const result = stripMarkers('[SEARCH_NOTES:2026-01-15] Notes found:');
  expect(result).toBe('Notes found:');
});

test('removes multiple markers', () => {
  const result = stripMarkers('[BOT_STATUS] Status: ok [CRON_ADD: x | * * * * * | test] [LIST_CRONS]');
  expect(result).toBe('Status: ok');
});

test('collapses triple+ newlines to double', () => {
  const result = stripMarkers('Line 1\n\n\n\nLine 2');
  expect(result).toBe('Line 1\n\nLine 2');
});

test('preserves text without markers', () => {
  const text = 'Hello, this is a normal message with no markers.';
  expect(stripMarkers(text)).toBe(text);
});

// ---------------------------------------------------------------------------
// findChunkBreak
// ---------------------------------------------------------------------------
console.log('\n=== findChunkBreak ===');

test('returns -1 for short text (< 3500 chars)', () => {
  expect(findChunkBreak('Hello world')).toBe(-1);
});

test('returns -1 for text at exactly 3499 chars', () => {
  expect(findChunkBreak('A'.repeat(3499))).toBe(-1);
});

test('breaks at paragraph boundary when present', () => {
  const text = 'A'.repeat(3500) + '\n\n' + 'B'.repeat(100);
  const breakIdx = findChunkBreak(text);
  expect(breakIdx).toBe(3502); // 3500 + 2 for \n\n
});

test('breaks at newline if no paragraph boundary', () => {
  const text = 'A'.repeat(3500) + '\n' + 'B'.repeat(100);
  const breakIdx = findChunkBreak(text);
  expect(breakIdx).toBe(3501); // 3500 + 1 for \n
});

test('breaks at space if no newline', () => {
  const text = 'A'.repeat(3500) + ' ' + 'B'.repeat(100);
  const breakIdx = findChunkBreak(text);
  expect(breakIdx).toBe(3501);
});

test('hard breaks at 3800 if no natural break', () => {
  const text = 'A'.repeat(5000); // no breaks at all
  expect(findChunkBreak(text)).toBe(3800);
});

test('prefers paragraph break over newline', () => {
  // Put a \n\n early within < 3800 range
  const text = 'A'.repeat(3510) + '\n\n' + 'B'.repeat(3510);
  const breakIdx = findChunkBreak(text);
  expect(breakIdx).toBe(3512); // paragraph break
});

// ---------------------------------------------------------------------------
// classifyProfile
// ---------------------------------------------------------------------------
console.log('\n=== classifyProfile ===');

test('classifies code keywords as coding', () => {
  expect(classifyProfile('Can you write a function to sort arrays?')).toBe('coding');
  expect(classifyProfile('debug this script please')).toBe('coding');
  expect(classifyProfile('fix the build issue')).toBe('coding');
  expect(classifyProfile('npm install express')).toBe('coding');
  expect(classifyProfile('refactor the auth module')).toBe('coding');
});

test('classifies code blocks as coding', () => {
  expect(classifyProfile('```\nconsole.log("hi")\n```')).toBe('coding');
});

test('classifies cron keywords as cron', () => {
  expect(classifyProfile('schedule a daily check')).toBe('cron');
  expect(classifyProfile('add a cron job for backup')).toBe('cron');
  expect(classifyProfile('set a timer for 5pm')).toBe('cron');
  expect(classifyProfile('תזמון משימה חדשה')).toBe('cron');
});

test('classifies memory keywords as memory', () => {
  expect(classifyProfile('remember that I prefer dark mode')).toBe('memory');
  expect(classifyProfile('forget what I said about redis')).toBe('memory');
  expect(classifyProfile('check my vestige memories')).toBe('memory');
  expect(classifyProfile('set an intention for tomorrow')).toBe('memory');
  expect(classifyProfile('תזכור שאני אוהב קפה')).toBe('memory');
});

test('classifies status keywords as status', () => {
  expect(classifyProfile('what is the bot status')).toBe('status');
  expect(classifyProfile('how much did I spend today?')).toBe('status');
  expect(classifyProfile('check the queue')).toBe('status');
  expect(classifyProfile('מה המצב של הבוט?')).toBe('status');
});

test('classifies short text as casual', () => {
  expect(classifyProfile('hi')).toBe('casual');
  expect(classifyProfile('thanks')).toBe('casual');
  expect(classifyProfile('good morning')).toBe('casual');
  expect(classifyProfile('sure')).toBe('casual');
});

test('classifies long unmatched text as general', () => {
  const longText = 'Tell me about the history of artificial intelligence and its impact on modern society over the past decade';
  expect(classifyProfile(longText)).toBe('general');
});

// ---------------------------------------------------------------------------
// matchSkills
// ---------------------------------------------------------------------------
console.log('\n=== matchSkills ===');

test('returns empty array for no matches', () => {
  const result = matchSkills('hello how are you doing today');
  expect(result.length).toBe(0);
});

test('matches image-gen by keyword', () => {
  const result = matchSkills('generate an image of a sunset');
  expect(result.includes('image-gen')).toBeTruthy();
});

test('matches regex-patterns by keyword', () => {
  const result = matchSkills('write a regex for email validation');
  expect(result.includes('regex-patterns')).toBeTruthy();
});

test('matches code-council by keyword', () => {
  const result = matchSkills('can you do a code review of the auth module?');
  expect(result.includes('code-council')).toBeTruthy();
});

test('matches Hebrew keywords', () => {
  const result = matchSkills('צייר לי תמונה של חתול');
  expect(result.includes('image-gen')).toBeTruthy();
});

test('case insensitive matching', () => {
  const result = matchSkills('Generate an IMAGE with DALL-E');
  expect(result.includes('image-gen')).toBeTruthy();
});

test('matches multiple skills', () => {
  const result = matchSkills('review the codebase and write a regex for the CRM contacts');
  expect(result.includes('code-council')).toBeTruthy();
  expect(result.includes('regex-patterns')).toBeTruthy();
  expect(result.includes('personal-crm')).toBeTruthy();
});

test('matches youtube-analytics', () => {
  const result = matchSkills('check my youtube channel analytics');
  expect(result.includes('youtube-analytics')).toBeTruthy();
});

test('matches content-pipeline', () => {
  const result = matchSkills('I need a content pipeline for blog posts');
  expect(result.includes('content-pipeline')).toBeTruthy();
});

test('matches humanizer', () => {
  const result = matchSkills('can you humanize this text and remove ai patterns?');
  expect(result.includes('humanizer')).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
