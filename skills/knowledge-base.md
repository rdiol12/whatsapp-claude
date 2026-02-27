---
name: "Knowledge Base"
description: "Semantic search and retrieval system (RAG) that saves content and generates AI-powered answers from your personal knowledge."
keywords: ["knowledge-base", "search", "rag", "retrieval", "memory", "ai", "answers", "semantic"]
category: "utility"
tags: ["memory", "search", "ai-powered"]
---

# Knowledge Base (RAG)

Save anything, recall it later with semantic search and AI-generated answers.

## Setup
```
cd skills/knowledge-base
npm install
npm run setup
```
Requires: `GEMINI_API_KEY` env var.

## Usage

### Save content
```
node scripts/save.js "https://example.com/article" --tags ai,research
node scripts/save.js "https://youtube.com/watch?v=..." --tags tutorial
node scripts/save.js "https://x.com/user/status/123" --tags opinion
node scripts/save.js "Plain text notes to save" --title "My Notes"
node scripts/save.js path/to/file.txt --tags reference
```

### Ask questions (RAG)
```
node scripts/ask.js "What are the best practices for RAG systems?"
node scripts/ask.js "Summarize what I saved about AI agents"
```

### List saved content
```
node scripts/list.js
node scripts/list.js --type video --limit 10
```

## Supported Sources
- **Articles** — web pages, blog posts (HTML extraction with fallback)
- **YouTube** — auto-transcripts
- **Tweets/X** — via FxTwitter API (free)
- **PDF** — text extraction
- **Plain text** — direct input or files

## How It Works
1. Detects source type from URL/input
2. Extracts content with fallback chain (multiple methods)
3. Validates quality (rejects error pages, too-short content)
4. Deduplicates by URL normalization + SHA-256 content hash
5. Chunks into ~800 char segments with 200 char overlap
6. Generates embeddings (Gemini text-embedding-004, free)
7. Stores in SQLite with WAL mode

Queries embed your question, cosine-similarity search all chunks, deduplicate by source, and pass top results to Gemini Flash for a synthesized answer with citations.
