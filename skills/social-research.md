# Social Media Research

Cost-optimized X/Twitter research: "What are people saying about [topic]?"

## Setup
```
cd skills/social-research && npm install
```

### API Keys (tiered, cheapest first)
- `TWITTER_API_IO_KEY` — Tier 2, ~$0.15/1K tweets (recommended)
- `SOCIAL_DATA_KEY` — Tier 2 alternative
- `X_BEARER_TOKEN` — Tier 3, official X API (expensive, last resort)
- `GEMINI_API_KEY` — For query decomposition + synthesis (free tier)

At minimum you need one Tier 2 or Tier 3 key. Gemini is optional but highly recommended.

## Usage
```
node scripts/research.js "AI agents" --days 7 --count 20
```

## How It Works
1. Decomposes your question into 2-4 search queries
2. Cascading search: Tier 2 → Tier 3 (cheapest first)
3. Filters retweets, deduplicates, ranks by engagement
4. Synthesizes briefing: key narratives, notable posts, sentiment, contrarian takes

## Tier Details
| Tier | Provider | Cost | Operations |
|------|----------|------|------------|
| 1 | FxTwitter | Free | Single tweet lookup |
| 2 | TwitterAPI.io / SocialData | ~$0.15/1K | Search, profiles, threads |
| 3 | Official X API v2 | ~$0.005/tweet | Everything (rate limited) |

API usage logged to `data/logs/tierN.log`
