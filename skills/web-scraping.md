---
name: "Web Scraping"
description: "Scrape web pages using Scrapling — fast HTTP, browser rendering, or stealth mode for anti-bot bypass."
keywords: ["scrape", "web", "crawl", "extract", "html", "page", "content", "fetch", "browser"]
category: "tools"
tags: ["scraping", "web", "automation"]
---

# Web Scraping (Scrapling)

6 tools for scraping web content. Choose the right one based on the target site.

## Tool Selection Guide

| Tool | When to Use | Speed |
|------|-------------|-------|
| `web_scrape` | Static pages, articles, docs, APIs | Fastest |
| `web_scrape_dynamic` | SPAs, JS-rendered content, React/Vue sites | Medium |
| `web_scrape_stealth` | Cloudflare-protected, anti-bot sites | Slowest |
| `*_bulk` variants | Same as above but for multiple URLs at once | Varies |

### Decision Flow
1. Try `web_scrape` first — it's the fastest and works for most sites
2. If content is missing or page requires JavaScript → use `web_scrape_dynamic`
3. If you get blocked (403, captcha, empty response) → use `web_scrape_stealth`

## Usage Examples

### Scrape a single page
```
web_scrape { "url": "https://example.com/article" }
```

### Scrape with JS rendering (SPA)
```
web_scrape_dynamic { "url": "https://app.example.com/dashboard", "wait_selector": ".content-loaded" }
```

### Scrape a protected site
```
web_scrape_stealth { "url": "https://protected-site.com/data" }
```

### Bulk scrape multiple pages
```
web_scrape_bulk { "urls": ["https://example.com/page1", "https://example.com/page2"] }
```

## Parameters

All tools accept:
- `url` / `urls` — Target URL(s) (required)
- `headless` — Run browser headless (default: true)
- `disable_resources` — Skip images/CSS/fonts for speed (default: false)

Dynamic and stealth tools also accept:
- `wait_selector` — CSS selector to wait for before extracting content
- `timeout` — Page load timeout in ms

## Tips
- Content is returned as text/markdown — no raw HTML parsing needed
- Results are truncated to 50KB (single) or 100KB (bulk) to stay within token limits
- Rate limited: 2s between single requests, 5s between bulk requests
- For repeated scraping of the same site, prefer bulk variants to reduce overhead
