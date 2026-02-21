/**
 * Tests for user-notes.js — run with: node test/user-notes.test.js
 *
 * Tests CRUD and context formatting.
 * Uses baseline counts to avoid interfering with real notes.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const modPath = pathToFileURL(join(__dirname, '..', 'lib', 'user-notes.js')).href;
const { addNote, deleteNote, listNotes, getNotesContext } = await import(modPath);

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
    toContain(s) { if (!String(actual).includes(s)) throw new Error(`Expected "${actual}" to contain "${s}"`); },
    toBeGreaterThan(n) { if (actual <= n) throw new Error(`Expected ${actual} > ${n}`); },
  };
}

const baseline = listNotes().length;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
console.log('\n=== Note CRUD ===');

test('addNote creates a note', () => {
  const note = addNote('Test note from unit test');
  expect(note.text).toBe('Test note from unit test');
  expect(note.id).toBeTruthy();
  expect(note.createdAt).toBeTruthy();
});

test('addNote trims whitespace', () => {
  const note = addNote('  padded text  ');
  expect(note.text).toBe('padded text');
  deleteNote(note.id);
});

test('listNotes count increases', () => {
  expect(listNotes().length).toBe(baseline + 1);
});

test('newest note is first (prepend)', () => {
  const note2 = addNote('Second test note');
  const notes = listNotes();
  expect(notes[0].text).toBe('Second test note');
  deleteNote(note2.id);
});

test('deleteNote removes a note', () => {
  const note = addNote('Delete me');
  const deleted = deleteNote(note.id);
  expect(deleted).toBeTruthy();
  expect(deleted.text).toBe('Delete me');
});

test('deleteNote returns null for unknown id', () => {
  const result = deleteNote('nonexistent-id');
  expect(result).toBe(null);
});

// ---------------------------------------------------------------------------
// getNotesContext
// ---------------------------------------------------------------------------
console.log('\n=== getNotesContext ===');

test('getNotesContext includes note text', () => {
  const ctx = getNotesContext();
  expect(ctx).toContain('Test note from unit test');
});

test('getNotesContext truncates long notes', () => {
  const longText = 'A'.repeat(300);
  const note = addNote(longText);
  const ctx = getNotesContext();
  expect(ctx).toContain('...');
  expect(ctx.includes('A'.repeat(201))).toBe(false); // truncated at 200
  deleteNote(note.id);
});

test('getNotesContext limits to 10 notes', () => {
  // Add 12 test notes
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const n = addNote(`Bulk note ${i}`);
    ids.push(n.id);
  }
  const ctx = getNotesContext();
  const lines = ctx.split('\n').filter(l => l.trim());
  // Should have at most 10 + any pre-existing notes (capped at 10 total)
  expect(lines.length <= 10).toBe(true);

  // Cleanup
  for (const id of ids) deleteNote(id);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
// Remove the test note we created
const testNote = listNotes().find(n => n.text === 'Test note from unit test');
if (testNote) deleteNote(testNote.id);

console.log(`\n--- ${total} tests: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
