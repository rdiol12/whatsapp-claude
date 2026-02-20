# AI Content Humanizer

Detects AI artifacts and rewrites text to sound human.

## Setup
```
cd skills/humanizer && npm install
```
Requires: `GEMINI_API_KEY`

## Usage
```
node scripts/humanize.js "Your AI-generated draft text here"
node scripts/humanize.js --file draft.txt --channel twitter
```

### Channels
- `twitter` — Under 280 chars, punchy, direct
- `linkedin` — Professional but conversational
- `blog` — Longer form, personal voice
- `email` — Brief, action-oriented

## Detection
Scans for: AI buzzwords (delve, leverage, landscape...), repetitive sentence structures, uniform paragraph lengths, excessive hedging.
