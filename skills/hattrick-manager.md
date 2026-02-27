---
name: "Hattrick Manager"
description: "Full automation of the user's Hattrick team using hattrick MCP browser tools."
keywords: ["hattrick", "האטריק", "כדורגל", "ניהול קבוצה", "מנג'ר", "שוק העברות", "אימונים", "טקטיקה", "lineup", "match", "training", "economy"]
category: "automation"
tags: ["hattrick", "football-manager", "strategy", "automation"]
---

# Hattrick Team Manager — Full Automation

Team: configured via HATTRICK_TEAM_ID env var

## MCP Tools (hattrick server)

### Read tools (get current state)
| Tool | Returns |
|------|---------|
| `hattrick_get_team` | Team overview, league position, rating |
| `hattrick_get_players` | Full roster — name, age, TSI, wage, form, stamina, specialty |
| `hattrick_get_matches` | Upcoming and recent fixtures |
| `hattrick_get_training` | Current training type and player training status |
| `hattrick_get_economy` | Finances — cash, income, expenses |
| `hattrick_get_league` | League table standings |
| `hattrick_scrape` | Read ANY hattrick page by URL |

### Interact tools (discover + act)
| Tool | Purpose |
|------|---------|
| `hattrick_inspect` | **KEY TOOL** — discovers all buttons, dropdowns, inputs, checkboxes on a page with their CSS selectors |
| `hattrick_action` | Perform browser actions: click, fill, select, check, hover, press, drag, goto, eval |

## Automation Workflow

CRITICAL: Always follow this pattern to automate anything:

```
1. hattrick_scrape(url)     → read the page content, understand what's there
2. hattrick_inspect(url)    → discover interactive elements (buttons, dropdowns, etc.)
3. hattrick_action(url, actions) → perform the actions using discovered selectors
4. hattrick_scrape(url)     → verify the change was applied
```

### Example: Change training type to Scoring
```json
// Step 1: inspect the training page
hattrick_inspect("/en/Club/Training/")
// → finds dropdown selector and Save button selector

// Step 2: change training and save
hattrick_action("/en/Club/Training/", [
  {"type": "select", "selector": "<dropdown-selector>", "value": "4"},
  {"type": "click", "selector": "<save-button-selector>"}
])
```

### Example: Set match lineup
```json
// Step 1: find the match orders page
hattrick_get_matches()
// → find upcoming match link

// Step 2: inspect match orders page
hattrick_inspect("/en/Club/Matches/MatchOrder/?matchID=<id>")
// → discover player slots, position dropdowns, tactic options

// Step 3: set lineup
hattrick_action("/en/Club/Matches/MatchOrder/?matchID=<id>", [
  // actions based on discovered selectors
])
```

## Action types for hattrick_action
- `click` — click a button/link: `{"type": "click", "selector": "#saveBtn"}`
- `fill` — type text: `{"type": "fill", "selector": "#amount", "value": "50000"}`
- `select` — dropdown: `{"type": "select", "selector": "#training", "value": "4"}`
- `check`/`uncheck` — checkbox: `{"type": "check", "selector": "#option1"}`
- `wait` — pause: `{"type": "wait", "ms": 2000}`
- `goto` — navigate: `{"type": "goto", "url": "/en/Club/Training/"}`
- `press` — keyboard: `{"type": "press", "selector": "#input", "key": "Enter"}`
- `hover` — mouse over: `{"type": "hover", "selector": "#menu"}`
- `drag` — drag & drop: `{"type": "drag", "source": "#player", "target": "#position"}`
- `eval` — run JS: `{"type": "eval", "js": "document.title"}`

Selectors support:
- CSS: `#id`, `.class`, `button.primary`
- Text: `text=Save`, `text=שמירה`

## Strategy Config

Full strategy rules are in `data/hattrick-strategy.json`. Read it before making any strategic decision.

### Training types (dropdown values)
| Value | Type | Hebrew |
|-------|------|--------|
| 9 | Goalkeeping | שוערות |
| 3 | Defense | הגנה |
| 8 | Playmaking | עשיית משחק |
| 5 | Wings | אגפים |
| 7 | Passing | מסירה |
| 4 | Scoring | הבקעה |
| 2 | Set Pieces | מצבים נייחים |

### Core Strategy Rules
- Pick ONE training type, stick with it for 35+ weeks
- Only players in trained position actually train (100% slot vs 50% slot)
- Buy players: age ≤17y 35d, must have specialty, main+secondary skill ≤ inadequate, low TSI
- Golden years: 17-21. Sell trained at week 35+ (season weeks 1-3, European evening)
- Profitable skill range: brilliant (11) to supernatural (14)
- Keep 300K+ NIS cash reserve
- Don't hoard players (salary drain)

### Staffing Timeline
| Week | Action |
|------|--------|
| 1 | 2x L4 coaches + 1x L4 doctor (16-week contracts) |
| 7 | Recruit future coach (solid leadership, passable exp, age <37) |
| 16 | Upgrade to 2x L5 coaches + optional L5 doctor |

### Economy Rules
- Stadium upgrade 1 at week 4 (max affordable, don't demolish)
- Stadium upgrade 2 at week 20 (only if league matches sell out)
- Schedule international home friendlies every week (cash + training slots)
- Fan baseline ~1400 before economy calculators are accurate

### Formations
| Formation | When |
|-----------|------|
| 4-4-2 | Default balanced |
| 4-5-1 | Protect lead, away |
| 3-5-2 | Attacking, home |
| 5-3-2 | Tough away match |

### Player Buying — Spec Rules (per training type)
Read `data/hattrick-strategy.json` → `training.types.<type>.buy_criteria.spec_rules` for exact per-specialty purchase filters.

### Coach Development
- Week 7: buy player with solid leadership + passable experience (age <37)
- Field in cup+league 16+ weeks → solid experience → convert to coach
- Replace starting coach by season 2-3

## Key Rules
- ALWAYS scrape current data first. Never guess from memory.
- ALWAYS read `data/hattrick-strategy.json` before strategic decisions.
- Each MCP call takes ~10-15 seconds (browser launch + login + scrape).
