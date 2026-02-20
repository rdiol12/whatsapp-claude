# AI Usage & Cost Tracking

Automatically tracks every AI API call across all providers (Anthropic, OpenAI, Google, xAI).

## Architecture

- **Auto-extraction** (`extract-sessions.js`): Parses OpenClaw session JSONL files to extract model, tokens, cost per call. Deduplicates via state file. Runs nightly at 2am via cron.
- **JSONL log** (`data/usage.jsonl`): Append-only, one entry per API call.
- **Reports** (`full-report.js`): Daily, weekly, monthly views with model/task breakdowns, projections, optimization hints.
- **Manual logging** (`log.js`): For non-OpenClaw API calls.

## What's tracked per call

- Timestamp
- Model name
- Input/output/cache tokens
- Task type (session kind, cron job name)
- Estimated cost (from provider cost data or pricing table)
- Session ID

## Quick commands

```bash
# Extract latest usage from sessions
node scripts/extract-sessions.js

# Reports
node scripts/full-report.js --period daily
node scripts/full-report.js --period weekly
node scripts/full-report.js --period monthly
node scripts/full-report.js --days 7 --model opus
node scripts/full-report.js --days 30 --format json

# Manual log
node scripts/log.js --model gpt-4o --input 1000 --output 500 --task research
```

## Cron jobs

| Name | Schedule | What |
|------|----------|------|
| cost-tracker-extract | Daily 2:00 AM | Extract session data → JSONL |
| weekly-cost-report | Sunday 9:00 AM | Weekly + monthly report → Telegram |

## Ask Jarvis

- "How much did I spend today/this week/this month?"
- "Which model costs the most?"
- "Show me cost breakdown by task type"
- "What's my projected monthly cost?"
