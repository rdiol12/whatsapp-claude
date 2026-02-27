import { readFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../lib/db.js';

const GOALS_FILE = join(process.env.HOME || process.env.USERPROFILE || '', 'sela', 'data', 'goals.json');
const db = getDb();
const data = JSON.parse(readFileSync(GOALS_FILE, 'utf-8'));
const jsonGoals = data.goals || [];
let updated = 0;

for (const g of jsonGoals) {
  const row = db.prepare('SELECT milestones, status, progress FROM goals WHERE id = ?').get(g.id);
  if (!row) continue;

  const dbMs = JSON.parse(row.milestones || '[]');
  const jsonMs = g.milestones || [];
  let msChanged = false;

  for (const jm of jsonMs) {
    const dm = dbMs.find(m => m.id === jm.id);
    if (dm && jm.status === 'completed' && dm.status !== 'completed') {
      dm.status = 'completed';
      dm.completedAt = jm.completedAt || Date.now();
      if (jm.evidence) dm.evidence = jm.evidence;
      msChanged = true;
    }
  }

  const statusChanged = g.status !== row.status;
  if (msChanged || statusChanged) {
    db.prepare('UPDATE goals SET milestones = ?, status = ?, progress = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(msChanged ? dbMs : JSON.parse(row.milestones)),
      statusChanged ? g.status : row.status,
      g.progress || row.progress,
      Date.now(),
      g.id
    );
    updated++;
    console.log('Synced:', g.id, '-', g.title, msChanged ? '(milestones)' : '', statusChanged ? `(status: ${row.status} → ${g.status})` : '');
  }
}
console.log('Done. Updated', updated, 'goals.');
