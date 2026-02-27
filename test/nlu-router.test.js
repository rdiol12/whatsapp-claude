/**
 * Tests for NLU Router — run with: node test/nlu-router.test.js
 *
 * No test framework needed. Outputs pass/fail for each test case.
 * Exit code 0 = all pass, 1 = failures.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import using file:// URL (required on Windows for ESM)
const routerPath = pathToFileURL(join(__dirname, '..', 'lib', 'nlu-router.js')).href;
const { classify, route, parseSlashCommand, INTENTS, CONFIDENCE_THRESHOLD } = await import(routerPath);

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
    },
    toBeAbove(n) {
      if (!(actual > n)) throw new Error(`Expected ${actual} > ${n}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Slash command tests
// ---------------------------------------------------------------------------

console.log('\n=== Slash Commands ===');

test('/clear', () => {
  const r = classify('/clear');
  expect(r.intent).toBe('clear');
  expect(r.confidence).toBe(1.0);
});

test('/help', () => {
  const r = classify('/help');
  expect(r.intent).toBe('help');
});

test('/status', () => {
  const r = classify('/status');
  expect(r.intent).toBe('status');
});

test('/crons', () => {
  const r = classify('/crons');
  expect(r.intent).toBe('crons');
});

test('/today', () => {
  const r = classify('/today');
  expect(r.intent).toBe('today');
});

test('/notes 2025-01-15', () => {
  const r = classify('/notes 2025-01-15');
  expect(r.intent).toBe('notes');
  expect(r.params.date).toBe('2025-01-15');
});

test('/skills', () => {
  const r = classify('/skills');
  expect(r.intent).toBe('skills');
});

test('/skill humanizer', () => {
  const r = classify('/skill humanizer');
  expect(r.intent).toBe('skill');
  expect(r.params.name).toBe('humanizer');
});

test('/send report.pdf', () => {
  const r = classify('/send report.pdf');
  expect(r.intent).toBe('send');
  expect(r.params.path).toBe('report.pdf');
});

test('/save https://example.com', () => {
  const r = classify('/save https://example.com');
  expect(r.intent).toBe('save');
  expect(r.params.url).toBe('https://example.com');
});

test('/files', () => {
  const r = classify('/files');
  expect(r.intent).toBe('files');
});

test('/delskill humanizer', () => {
  const r = classify('/delskill humanizer');
  expect(r.intent).toBe('delskill');
  expect(r.params.name).toBe('humanizer');
});

test('/unknown should return null', () => {
  const r = parseSlashCommand('/unknown-command');
  expect(r).toBeNull();
});

// ---------------------------------------------------------------------------
// Natural language → /status
// ---------------------------------------------------------------------------

console.log('\n=== Status (NLU) ===');

const statusPhrases = [
  'how are you doing?',
  'how are you?',
  'are you alive?',
  'are you there?',
  'bot status',
  'what is your status?',
  'system health',
  'are you up?',
  'ping',
  'you ok?',
  'are you working?',
  'are you still running?',
];

for (const phrase of statusPhrases) {
  test(`"${phrase}" → status`, () => {
    const r = route(phrase);
    expect(r).toBeTruthy();
    expect(r.intent).toBe('status');
    expect(r.confidence).toBeAbove(CONFIDENCE_THRESHOLD);
  });
}

// ---------------------------------------------------------------------------
// Natural language → /clear
// ---------------------------------------------------------------------------

console.log('\n=== Clear (NLU) ===');

const clearPhrases = [
  'clear the conversation',
  'reset our chat',
  'wipe the history',
  'start over',
  'start fresh',
  'forget everything',
  'new conversation',
  'clean slate',
  'erase our messages',
  'clear chat history',
  "let's start over",
];

for (const phrase of clearPhrases) {
  test(`"${phrase}" → clear`, () => {
    const r = route(phrase);
    expect(r).toBeTruthy();
    expect(r.intent).toBe('clear');
    expect(r.confidence).toBeAbove(CONFIDENCE_THRESHOLD);
  });
}

// ---------------------------------------------------------------------------
// Natural language → /help
// ---------------------------------------------------------------------------

console.log('\n=== Help (NLU) ===');

const helpPhrases = [
  'help',
  'show me the commands',
  'what can you do?',
  'what are your commands?',
  'list commands',
  'what features do you have?',
];

for (const phrase of helpPhrases) {
  test(`"${phrase}" → help`, () => {
    const r = route(phrase);
    expect(r).toBeTruthy();
    expect(r.intent).toBe('help');
    expect(r.confidence).toBeAbove(CONFIDENCE_THRESHOLD);
  });
}

// ---------------------------------------------------------------------------
// Natural language → /crons
// ---------------------------------------------------------------------------

console.log('\n=== Crons (NLU) ===');

const cronPhrases = [
  'show me my cron jobs',
  'list crons',
  'what crons are running?',
  'scheduled jobs',
  'what is scheduled?',
  'my automations',
  'show cron jobs',
  'list scheduled tasks',
  'recurring jobs',
];

for (const phrase of cronPhrases) {
  test(`"${phrase}" → crons`, () => {
    const r = route(phrase);
    expect(r).toBeTruthy();
    expect(r.intent).toBe('crons');
    expect(r.confidence).toBeAbove(CONFIDENCE_THRESHOLD);
  });
}

// ---------------------------------------------------------------------------
// Natural language → /today
// ---------------------------------------------------------------------------

console.log('\n=== Today (NLU) ===');

const todayPhrases = [
  "what did we talk about today?",
  "today's notes",
  "show me today's summary",
  "daily notes",
  "today's conversation log",
  "what happened today?",
  "summarize today",
];

for (const phrase of todayPhrases) {
  test(`"${phrase}" → today`, () => {
    const r = route(phrase);
    expect(r).toBeTruthy();
    expect(r.intent).toBe('today');
    expect(r.confidence).toBeAbove(CONFIDENCE_THRESHOLD);
  });
}

// "daily recap" and "recap of today" should route to recap, not today
test('"daily recap" → recap', () => {
  const r = route('daily recap');
  expect(r).toBeTruthy();
  expect(r.intent).toBe('recap');
});

test('"recap of today" → recap', () => {
  const r = route('recap of today');
  expect(r).toBeTruthy();
  expect(r.intent).toBe('recap');
});

// ---------------------------------------------------------------------------
// Natural language → /notes <date>
// ---------------------------------------------------------------------------

console.log('\n=== Notes with date (NLU) ===');

test('"notes for 2025-01-15" → notes', () => {
  const r = route('notes for 2025-01-15');
  expect(r).toBeTruthy();
  expect(r.intent).toBe('notes');
  expect(r.params.date).toBe('2025-01-15');
});

test('"what did we discuss yesterday?" → notes', () => {
  const r = route('what did we discuss yesterday?');
  expect(r).toBeTruthy();
  expect(r.intent).toBe('notes');
  expect(r.params.date).toBeTruthy();
});

test('"notes from last monday" → notes', () => {
  const r = route('notes from last monday');
  expect(r).toBeTruthy();
  expect(r.intent).toBe('notes');
  expect(r.params.date).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Natural language → /files
// ---------------------------------------------------------------------------

console.log('\n=== Files (NLU) ===');

const filePhrases = [
  'show my files',
  'list files',
  'what files are in workspace?',
  'workspace files',
  "what's in the workspace?",
  'my files',
  'list workspace',
  'show all files',
];

for (const phrase of filePhrases) {
  test(`"${phrase}" → files`, () => {
    const r = route(phrase);
    expect(r).toBeTruthy();
    expect(r.intent).toBe('files');
    expect(r.confidence).toBeAbove(CONFIDENCE_THRESHOLD);
  });
}

// ---------------------------------------------------------------------------
// Natural language → /send <file>
// ---------------------------------------------------------------------------

console.log('\n=== Send file (NLU) ===');

test('"send me report.pdf" → send + path', () => {
  const r = route('send me report.pdf');
  expect(r).toBeTruthy();
  expect(r.intent).toBe('send');
  expect(r.params.path).toBe('report.pdf');
});

test('"share the data.csv file" → send + path', () => {
  const r = route('share the data.csv file');
  expect(r).toBeTruthy();
  expect(r.intent).toBe('send');
  expect(r.params.path).toBe('data.csv');
});

test('"can I get the results.xlsx?" → send + path', () => {
  const r = route('can I get the results.xlsx?');
  expect(r).toBeTruthy();
  expect(r.intent).toBe('send');
  expect(r.params.path).toBe('results.xlsx');
});

// ---------------------------------------------------------------------------
// Natural language → /save <url>
// ---------------------------------------------------------------------------

console.log('\n=== Save URL (NLU) ===');

test('"save this article https://example.com/post" → save + url', () => {
  const r = route('save this article https://example.com/post');
  expect(r).toBeTruthy();
  expect(r.intent).toBe('save');
  expect(r.params.url).toBe('https://example.com/post');
});

test('"add https://blog.com/ai to knowledge base" → save + url', () => {
  const r = route('add https://blog.com/ai to knowledge base');
  expect(r).toBeTruthy();
  expect(r.intent).toBe('save');
  expect(r.params.url).toBe('https://blog.com/ai');
});

test('"remember this link https://docs.rs/tokio" → save + url', () => {
  const r = route('remember this link https://docs.rs/tokio');
  expect(r).toBeTruthy();
  expect(r.intent).toBe('save');
  expect(r.params.url).toBe('https://docs.rs/tokio');
});

// ---------------------------------------------------------------------------
// Natural language → /skills
// ---------------------------------------------------------------------------

console.log('\n=== Skills (NLU) ===');

const skillsPhrases = [
  'what skills do you have?',
  'list skills',
  'show all skills',
  'available skills',
  'your abilities',
];

for (const phrase of skillsPhrases) {
  test(`"${phrase}" → skills`, () => {
    const r = route(phrase);
    expect(r).toBeTruthy();
    expect(r.intent).toBe('skills');
    expect(r.confidence).toBeAbove(CONFIDENCE_THRESHOLD);
  });
}

// ---------------------------------------------------------------------------
// Negative tests: things that should NOT match
// ---------------------------------------------------------------------------

console.log('\n=== Negative / Fall-through ===');

const fallThroughPhrases = [
  'Tell me a joke',
  'Write a Python function to sort a list',
  'What is the capital of France?',
  'Explain quantum computing in simple terms',
  'How do I fix this error in my code?',
  'Help me write a cover letter for a job application',  // "help me with X" is not /help
  'Check the deploy status of my app',  // anti-pattern: status of something else
  'Can you review this pull request?',
  'I need to schedule a meeting for tomorrow',
  // 'Create a cron job that runs every hour' → now correctly routes to addcron intent
];

for (const phrase of fallThroughPhrases) {
  test(`"${phrase}" → null (fall through)`, () => {
    const r = route(phrase);
    if (r !== null) {
      throw new Error(`Expected null but got intent="${r.intent}" (confidence=${r.confidence.toFixed(2)})`);
    }
  });
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

console.log('\n=== Edge Cases ===');

test('empty string → null', () => {
  const r = classify('');
  expect(r).toBeNull();
});

test('whitespace only → null', () => {
  const r = classify('   ');
  expect(r).toBeNull();
});

test('very long message mentioning "status" → null or low confidence', () => {
  const long = 'I have been working on this project all day and I want to update the status page on our website. The design should have a green indicator when services are up and red when they are down. Can you help me build this? I need it to check the API endpoint every 30 seconds and update the DOM accordingly. Here is my current code...';
  const r = route(long);
  // Should either be null or have low confidence (brevity penalty)
  if (r !== null && r.intent === 'status') {
    throw new Error(`Long message falsely matched status (confidence=${r.confidence.toFixed(2)})`);
  }
});

test('slash command takes priority over NLU', () => {
  const r = classify('/clear');
  expect(r.intent).toBe('clear');
  expect(r.confidence).toBe(1.0);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(50)}`);
console.log(`Total: ${total}  Passed: ${passed}  Failed: ${failed}`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed.');
}
