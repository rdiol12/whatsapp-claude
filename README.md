# Sela

A personal AI assistant that lives in your WhatsApp. Built with [Baileys](https://github.com/WhiskeySockets/Baileys) for WhatsApp connectivity and Claude (via the official CLI) for intelligence. Designed as a single-user, always-on companion that handles everything from casual conversation to complex multi-step tasks — all from your phone.

## Features

- **Natural conversation** — Context-aware chat with conversation history, Hebrew + English support, and a customizable personality via `SOUL.md`
- **Persistent mode** — Keeps a single Claude CLI process alive and pipes messages via stdin for sub-second response times (no cold start per message)
- **Local NLU router** — 18-intent pattern matcher (Hebrew + English) handles common commands instantly without calling Claude, keeping costs near zero for routine operations
- **Cron jobs** — Schedule recurring AI tasks (daily briefings, health checks, git sync, memory maintenance) with quiet-hour suppression and error tracking
- **Semantic memory** — Integrates with [Vestige MCP](https://github.com/peterSt/vestige) for persistent memory search, fact ingestion, and intention tracking across conversations
- **Web dashboard** — Real-time 3-panel control center with WebSocket live updates, cost monitoring, cron management, memory browser, and system health at a glance
- **Telegram integration** — Two-way channel: receive alerts and send remote commands (`/status`, `/shutdown`, `/cron`) without opening WhatsApp
- **Cost tracking** — Per-message token cost analytics with daily budget alerts and 7-day trend visualization
- **Plugin system** — Dynamic plugin loading with lifecycle hooks (init, message, shutdown)
- **Skill files** — 18 markdown skill documents that Claude reads on demand for specialized tasks (CRM, code review, health monitoring, content pipeline, etc.)
- **Task planner** — Multi-step autonomous task execution with plan-then-execute workflow
- **Goal tracking** — Long-running objectives with milestones and progress tracking
- **Workflow engine** — Stateful multi-step workflows with pause/resume and user input gates
- **User notes** — Persistent personal notes that get injected into Claude's context for personalized responses
- **Proactive loop** — Periodic check for due reminders and flagged conditions, delivered automatically
- **Agent loop** — Fully autonomous cycle running every 10 minutes. Phase 1 collects 14 signal types (stale/blocked goals, deadlines, failing crons, cost spikes, memory pressure, MCP disconnects, error spikes, conversation gaps, stale memories, low-engagement crons, goal work, compound escalation). Phase 2 spawns Claude to investigate, decide, act, and verify. Always-think mode spawns every 2nd cycle even with zero signals for reflection, goal advancement, and planning. Time-aware prompts (morning planning, evening review). Immediate 2-minute re-cycle after productive cycles. Self-correcting via agent-learning feedback loop
- **Agent learning** — Tracks cycle outcomes, message engagement, and followup effectiveness. After 10+ cycles, injects self-correcting advice into agent prompts (reduce messages if low engagement, fewer followups if ineffective, focus on top signal types)

## Architecture

```
WhatsApp message
    │
    ▼
┌──────────┐     ┌──────────┐     ┌──────────────┐
│ Debounce │────▶│  Router  │────▶│ NLU (local)  │
│  (2s)    │     │ (tier 0-3)│     │ 18 intents   │
└──────────┘     └──────────┘     └──────┬───────┘
                                         │
                              ┌──────────┴──────────┐
                              │                     │
                         Match found           No match
                              │                     │
                              ▼                     ▼
                      ┌──────────────┐    ┌─────────────────┐
                      │Intent handler│    │  Claude CLI      │
                      │ (instant)    │    │  + Vestige MCP   │
                      └──────────────┘    │  + Skills        │
                                          │  + History       │
                                          └─────────────────┘
```

### Message tiers

| Tier | Description | Handler |
|------|-------------|---------|
| 0 | System messages, status updates | Ignored |
| 1 | Simple commands, NLU-matched intents | Local handler (no LLM) |
| 2 | Standard conversation | Claude (spawn or persistent pipe) |
| 3 | Complex tasks (`/task`, workflows) | Claude with extended context + tools |

### Core modules (`lib/`)

| Module | Purpose |
|--------|---------|
| `whatsapp.js` | Baileys socket management, message routing, media handling |
| `claude.js` | Claude CLI orchestration, session management, cost tracking, skill injection |
| `claude-persistent.js` | Persistent CLI process manager (stdin/stdout piping, respawn, context compression) |
| `nlu-router.js` | Local intent classification — no LLM needed for common commands |
| `mcp-gateway.js` | Vestige MCP connection for semantic memory |
| `crons.js` | Cron job scheduling with quiet hours and error tracking |
| `bot-ipc.js` | IPC + WebSocket server for dashboard and external tools |
| `telegram.js` | Two-way Telegram bot (polling for commands, Bot API for alerts) |
| `queue.js` | Concurrency control with per-user fairness |
| `history.js` | Conversation persistence with debounced writes |
| `cost-analytics.js` | Token cost tracking with daily budget alerts |
| `plugins.js` | Dynamic plugin loading with hook system |
| `task-planner.js` | Multi-step task planning and execution |
| `workflow-engine.js` | Stateful workflows with pause/resume |
| `goals.js` | Long-running objective tracking with milestones |
| `proactive.js` | Periodic reminder and condition checking loop |
| `user-notes.js` | Persistent personal notes (CRUD + context injection) |
| `agent-loop.js` | Fully autonomous cycle — 14 signals, always-think, goal progression, re-cycling |
| `agent-learning.js` | Cycle outcome tracking, engagement analytics, self-correcting prompt injection |
| `ws-events.js` | Decoupled WebSocket event emitter for real-time dashboard updates |
| `notify.js` | Telegram alert helper |
| `metrics.js` | Telemetry and health snapshots |
| `bot-mcp-server.js` | MCP server exposing bot control to other Claude instances |

## Prerequisites

- **Node.js** 20+ (ES modules)
- **Claude CLI** — authenticated via OAuth (`~/.claude/.credentials.json`)
- **PM2** (recommended) — for process management and auto-restart
- **Vestige MCP** (optional) — for persistent semantic memory

## Installation

```bash
git clone <repo-url> sela
cd sela
npm install
```

### Configuration

1. Copy the environment template:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your values:
   ```
   ALLOWED_PHONE=<your-phone-without-plus>
   TELEGRAM_BOT_TOKEN=<from-botfather>
   TELEGRAM_CHAT_ID=<your-chat-id>
   DASHBOARD_SECRET=<dashboard-password>
   ```

3. (Optional) Configure MCP servers:
   ```bash
   cp mcp-config.example.json mcp-config.json
   # Edit paths to your vestige-mcp binary and bot-mcp-server.js
   ```

4. (Optional) Customize the bot personality in `SOUL.md`.

### First run

```bash
node index.js
```

On first launch, a QR code will appear in the terminal. Scan it with WhatsApp to link the bot as a paired device.

### Running with PM2

```bash
pm2 start index.js --name sela --max-memory-restart 512M
pm2 save
```

## Dashboard

The bot includes a web dashboard at `http://localhost:4242` with:

- **System status** — uptime, memory, queue depth, connection state
- **Cost analytics** — today's spend, budget progress bar, 7-day trend chart
- **Cron manager** — view, enable/disable, and trigger cron jobs
- **Memory browser** — search and browse Vestige memories, ingest new facts
- **Service health** — MCP connection, Telegram, plugin status
- **Live updates** — WebSocket push every 5 seconds, real-time event toasts
- **Agent loop monitor** (`/agent`) — real-time view of autonomous cycle status, signal collection, Claude spawns, actions taken, goal creation events, learning stats (action ratio, engagement rate, cost per cycle, top signals), and a live event log

Start the dashboard separately:
```bash
node dashboard.js
```

If `DASHBOARD_SECRET` is set in `.env`, the dashboard requires password authentication with rate-limited login (5 attempts, then 5-minute lockout).

## Telegram Commands

When `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are configured, the bot accepts remote commands via Telegram:

| Command | Description |
|---------|-------------|
| `/status` | Bot status, uptime, queue stats |
| `/crons` | List all cron jobs |
| `/run <name>` | Trigger a cron job immediately |
| `/cost [today\|week\|month]` | Cost report for the period |
| `/memory <query>` | Search Vestige memories |
| `/notes` | List saved user notes |
| `/recap` | Daily activity summary |
| `/shutdown` | Graceful shutdown |
| `/help` | List all commands |

## Skills

Skill files in `skills/` are markdown documents that Claude loads on demand when a conversation matches their domain. They provide specialized knowledge without bloating the base system prompt.

| Skill | Domain |
|-------|--------|
| `business-briefing.md` | Daily business/market briefings |
| `code-council.md` | Multi-perspective code review |
| `content-pipeline.md` | Content creation workflows |
| `cost-tracker.md` | Cost optimization guidance |
| `git-sync.md` | Automated git backup |
| `health-monitor.md` | System health checks |
| `personal-crm.md` | Contact tracking from Gmail/Calendar |
| `prompt-engineering.md` | Prompt optimization |
| `social-research.md` | Social media analysis |
| `task-extractor.md` | Extract actionable tasks from text |
| And 8 more... | |

## Project Structure

```
sela/
├── index.js              # Entry point — boots all subsystems
├── dashboard.js          # Web dashboard server (port 4242)
├── SOUL.md               # Bot personality definition
├── .env.example          # Environment variable template
├── mcp-config.example.json  # MCP server configuration template
├── lib/                  # Core modules (36 files)
├── skills/               # Skill documents (18 files)
├── test/                 # Test suite
├── data/                 # Runtime data (gitignored)
│   ├── crons.json        # Cron job definitions
│   ├── history.json      # Conversation history
│   ├── goals.json        # Goal tracking state
│   └── ...
├── auth/                 # WhatsApp auth state (gitignored)
├── logs/                 # Pino log files (gitignored)
└── plugins/              # Dynamic plugins
```

## Tests

```bash
node test/run-all.js
```

Runs the full test suite (200+ tests) covering NLU routing, queue concurrency, cost analytics, history management, formatting, intent matching, and workflow execution.

## License

ISC
