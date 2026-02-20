# Content Idea Pipeline

Research topics, semantic-deduplicate against past ideas, create production-ready briefs.

## Setup
```
cd skills/content-pipeline && npm install && node -e "import('./lib/database.js').then(m => m.initDb())"
```
Requires: `GEMINI_API_KEY`

## Usage

### Pitch a new idea
```
node scripts/pitch.js "AI agents replacing SaaS" --type long --tags ai,saas
```
1. Researches the topic via Gemini
2. Checks semantic similarity against all past pitches (40% threshold = hard reject)
3. Generates title + brief
4. Stores with embedding for future dedup

### List all pitches
```
node scripts/list-pitches.js
```

## Deduplication
- Hybrid: 70% semantic (cosine similarity) + 30% keyword (title/summary/tags)
- **Hard gate at 40%** — if any existing pitch scores above this, the new idea is rejected
- Shows what it matched and the similarity score
