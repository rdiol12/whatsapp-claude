# Personal CRM Intelligence

Auto-tracks contacts from Gmail and Google Calendar with AI-powered filtering.

## Setup

1. **Google Cloud credentials:**
   - Go to https://console.cloud.google.com/apis/credentials
   - Create OAuth 2.0 Client ID (Desktop app)
   - Enable Gmail API and Calendar API
   - Download JSON → save as `config/credentials.json`

2. **Environment variables:**
   ```
   GEMINI_API_KEY=your-key       # For AI classification + embeddings
   CRM_MY_EMAILS=rdiol12@gmail.com  # Comma-separated list of your emails
   CRM_DAYS=60                   # How far back to scan
   ```

3. **Install & setup:**
   ```
   cd skills/personal-crm
   npm install
   npm run setup
   ```

## Usage

### Ingest contacts (daily cron)
```
node scripts/ingest.js
```
Fetches Gmail + Calendar, filters, classifies with AI, scores, and stores.

### Search contacts
```
node scripts/search.js "who did I meet from Google"
node scripts/search.js "engineers" --limit 5
node scripts/search.js "contacts not spoken to in 30 days"
```

### View stats
```
node scripts/stats.js
```

## How Filtering Works

**Stage 1 — Hard filters:** Rejects bots, newsletters, role inboxes (info@, noreply@), marketing senders, and known skip domains.

**Stage 2 — AI classification:** Uses Gemini Flash to analyze each candidate's name, email, exchange count, and sample subjects/snippets. Approves only real people with genuine interactions.

## Scoring

Base 50 + email exchanges (+5 each, max 20) + meetings (+3 each, max 15) + title match (+15) + small meetings (+10) + recency (+5-10) + cross-source bonus (+25) + role/company (+5-10).

## Learning

The system learns from rejections. Edit `config/learning.json` to:
- Add domains to always skip
- Set preferred titles for scoring boosts
- Adjust thresholds (min_exchanges, max_days_between, etc.)

## Data

- Database: `data/crm.db` (SQLite WAL)
- Config: `config/learning.json`, `config/credentials.json`, `config/token.json`
