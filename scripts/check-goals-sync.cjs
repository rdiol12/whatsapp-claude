const fs = require('fs');
const db = require('better-sqlite3')('data/sela.db');

const json = JSON.parse(fs.readFileSync('data/goals.json', 'utf8'));
const goals = json.goals || [];
const dbIds = new Set(db.prepare('SELECT id FROM goals').all().map(r => r.id));

const missing = [];
for (const g of goals) {
  if (!dbIds.has(g.id)) missing.push(g);
}

console.log('JSON goals:', goals.length);
console.log('DB goals:', dbIds.size);
console.log('In JSON but NOT in DB:', missing.length);
for (const g of missing) {
  console.log(' -', g.id, ':', g.title, '|', g.status, '|', (g.progress || 0) + '%');
}

// Also check for milestone differences on shared goals
let diffs = 0;
for (const g of goals) {
  if (!dbIds.has(g.id)) continue;
  const dbRow = db.prepare('SELECT milestones FROM goals WHERE id = ?').get(g.id);
  const dbMs = JSON.parse(dbRow.milestones || '[]');
  const jsonMs = g.milestones || [];
  if (jsonMs.length !== dbMs.length) {
    console.log('  MS count diff:', g.id, '- JSON:', jsonMs.length, 'DB:', dbMs.length);
    diffs++;
  }
}
if (diffs === 0) console.log('Milestone counts match for all shared goals');

db.close();
