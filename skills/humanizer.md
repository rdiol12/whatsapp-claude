---
name: "AI Content Humanizer"
description: "Detects AI artifacts in text and rewrites content to sound authentically human-written."
keywords: ["humanizer", "content", "rewrite", "ai-detection", "writing", "style", "tone", "authenticity"]
category: "content"
tags: ["writing", "editing", "transformation"]
---

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
