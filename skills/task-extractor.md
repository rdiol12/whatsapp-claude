# Task Extractor

Extract action items from meetings/transcripts, get approval, create tasks.

## Setup
```
cd skills/task-extractor && npm install
```
Requires: `GEMINI_API_KEY`. Optional: `TODOIST_API_KEY`, `TODOIST_PROJECT`

## Extract from transcript
```
node scripts/extract.js --file meeting-notes.txt
```

## Extract direct task
```
node scripts/extract.js "Follow up with Dave about the API by Friday"
```

## Approve/reject
```
node scripts/approve.js all      # approve all pending
node scripts/approve.js 1,3      # approve items 1 and 3
node scripts/approve.js none     # reject all
```

If `TODOIST_API_KEY` is set, approved tasks auto-create in Todoist.
