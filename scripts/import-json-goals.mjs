import { readFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../lib/db.js';

const GOALS_FILE = join(process.env.HOME || process.env.USERPROFILE || '', 'sela', 'data', 'goals.json');
const db = getDb();

const data = JSON.parse(readFileSync(GOALS_FILE, 'utf-8'));
const jsonGoals = data.goals || [];
const dbIds = new Set(db.prepare('SELECT id FROM goals').all().map(r => r.id));

let imported = 0;
for (const g of jsonGoals) {
  if (!dbIds.has(g.id)) {
    db.prepare(`
      INSERT INTO goals (id, title, description, status, priority, progress, milestones, log, linked_topics, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      g.id, g.title, g.description || null, g.status, g.priority || 'medium',
      g.progress || 0, JSON.stringify(g.milestones || []), JSON.stringify(g.log || []),
      JSON.stringify(g.linkedTopics || []), g.createdAt || Date.now(), g.updatedAt || Date.now()
    );
    console.log('Imported:', g.id, '-', g.title);
    imported++;
  }
}
console.log('Done. Imported', imported, 'goals.');
console.log('SQLite now has', db.prepare('SELECT COUNT(*) as c FROM goals').get().c, 'goals.');
