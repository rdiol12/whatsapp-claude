import Database from 'better-sqlite3';
const db = new Database('data/sela.db');

const goals = db.prepare('SELECT id, milestones FROM goals').all();
let fixed = 0;

for (const goal of goals) {
  if (!goal.milestones) continue;
  let ms;
  try { ms = JSON.parse(goal.milestones); } catch { continue; }
  if (!Array.isArray(ms) || ms.length === 0) continue;
  if (typeof ms[0] === 'object') continue; // already correct format

  const converted = ms.map((title, i) => ({
    id: 'ms_' + (i + 1),
    title,
    status: 'pending',
    completedAt: null,
    evidence: null,
    notes: ''
  }));

  db.prepare('UPDATE goals SET milestones = ? WHERE id = ?')
    .run(JSON.stringify(converted), goal.id);
  console.log('Fixed:', goal.id);
  fixed++;
}
console.log('Done. Fixed', fixed, 'goals.');
