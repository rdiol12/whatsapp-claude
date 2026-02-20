# YouTube Analytics + Competitor Tracking

Daily channel metrics collection and competitor monitoring.

## Setup
```
cd skills/youtube-analytics && npm install
```

### Required
- `YOUTUBE_API_KEY` — YouTube Data API v3 key
- `YOUTUBE_CHANNEL_ID` — Your channel ID (UC...)
- `YOUTUBE_COMPETITORS` — Comma-separated competitor channel IDs (optional)

## Usage

### Collect daily data
```
node scripts/collect.js
node scripts/collect.js --channel UCxxx --competitors UCaaa,UCbbb
```

### View report
```
node scripts/report.js
```

## Metrics Tracked
- Views (total + per-video)
- Watch time minutes
- Subscriber gains
- Impressions & CTR (when Analytics API available)
- Competitor uploads, views, subscriber counts
- Short vs long-form classification

## Schedule
Add a daily cron job for automatic collection.
