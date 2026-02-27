# Sela

A fully autonomous AI agent that lives in your WhatsApp. Built with [Baileys](https://github.com/WhiskeySockets/Baileys) for WhatsApp connectivity and Claude (via the official CLI) for intelligence. Sela doesn't just respond to messages — it proactively manages goals, monitors its own health, learns from outcomes, and adapts its behavior based on context and trust.

Single-user, always-on. Designed to run your life from your phone.

---

## Architecture Overview

Sela is built as a **signal-driven autonomous agent** with two independent processing paths:

```
                         ┌──────────────────────────────┐
                         │       WhatsApp (Baileys)      │
                         └──────────┬───────────────────┘
                                    │ incoming message
                                    v
                         ┌──────────────────────┐
                         │   Debounce (2s)       │
                         │   + Media handling    │
                         └──────────┬───────────┘
                                    │
                         ┌──────────v───────────┐
                         │   Router (tier 0-3)   │
                         └───┬──────────────┬───┘
                             │              │
                    NLU match│              │ No match
                             v              v
                    ┌────────────┐  ┌───────────────────┐
                    │ 18 intents │  │ Claude CLI         │
                    │ (instant,  │  │ + Vestige memory   │
                    │  zero LLM) │  │ + QMD code search  │
                    └────────────┘  │ + Skills on demand │
                                    │ + Tool Bridge      │
                                    │ + Trust Engine     │
                                    └───────────────────┘

 ┌─────────────────────────────────────────────────────────────────┐
 │                  Agent Loop (every 10 min)                      │
 │                                                                 │
 │  1. Signal Collection ──> core + module detectors, zero LLM     │
 │  2. Cooldown Filter ───> per-signal-type dedup                  │
 │  3. pickSignals() ─────> top 2, max 1 Sonnet, age escalation   │
 │  4. Prompt Assembly ───> briefs + memory + context + modules    │
 │  5. Claude Reasoning ──> Haiku (routine) / Sonnet (code+high)  │
 │  6. Parse & Execute ───> goals, messages, tools, chains         │
 │  7. Writeback ─────────> state timestamps, recent-actions log   │
 │  8. Decision Tracking ─> log decisions, link outcomes, learn    │
 └─────────────────────────────────────────────────────────────────┘
```

### Two Processing Paths

**Reactive path** — A WhatsApp message arrives, gets debounced (2 seconds to handle edits/bursts), routed through the NLU classifier (18 intents, Hebrew + English, zero LLM cost). If matched, handled instantly. Otherwise, forwarded to Claude with conversation history, memory context, and available tools.

**Proactive path** — The agent loop runs independently every 10 minutes. It scans signal detectors (core + any loaded modules), filters through cooldowns, picks the top 2 most urgent signals, builds a context-rich prompt, and lets Claude decide what to do. The agent can send messages, advance goals, trigger tools, create workflows, and learn from outcomes — all without any user input.

---

## The Signal System

The core of Sela's autonomy. Signals are **zero-cost detectors** — pure JavaScript checks against local state. No LLM calls until signals are collected and a cycle is triggered.

### How Signals Flow

```
detectAll() ──> core detectors + module detectors produce raw signals
     │
     v
applyCooldowns() ──> dedup by signal key (type + goal/cron/topic)
     │                 low=3h, medium=1h, high/critical=0
     v
pickSignals() ──> max 2 per cycle, max 1 Sonnet-tier
     │              age-based escalation: 4+ days overdue → low→medium
     v
buildAgentPrompt() ──> assembles context block:
     │   - date/time + quiet hours flag
     │   - signal summaries with urgency tags
     │   - active goals
     │   - module context providers (weekly plans, etc.)
     │   - module brief builders (signal-specific prompts)
     │   - recent actions (cross-cycle dedup)
     │   - learning context + reasoning journal
     │   - error analytics (if error_spike)
     v
Claude (Haiku or Sonnet) ──> reasons, decides, acts
     │
     v
parseAgentResponse() ──> extracts structured tags:
     <wa_message>    → send WhatsApp message to the user
     <action_taken>  → log what was done
     <goal_update>   → advance a milestone
     <goal_create>   → create new goal
     <followup>      → schedule a check-in
     <reflection>    → self-assessment
     <hypothesis>    → reasoning journal entry
```

### Core Signal Types

| Signal | Urgency | Trigger |
|--------|---------|---------|
| `followup` | medium-high | Scheduled follow-up due |
| `goal_work` | medium | Active goal hasn't been worked on |
| `stale_goal` | low | Goal idle >7 days |
| `idle_conversation` | low | No messages in active thread |
| `cron_due` | medium | Cron job ready to fire |
| `error_spike` | high | 3+ errors in short window |
| ...and more | | Goal deadlines, chain steps, anomalies |

Modules can register additional signal types (see [Module System](#module-system)).

---

## The Agent Loop

The main brain. Runs every 10 minutes (configurable), operates completely independently from WhatsApp message handling.

### Cycle Anatomy

1. **Signal collection** — All core detectors + module detectors run. Pure JS, no API calls. Reads goals.json, SQLite state, module snapshots, error logs.

2. **Cooldown filtering** — Each signal gets a unique key (e.g., `goal_work:abc123`). If the same key fired recently (3h for low, 1h for medium, 0 for high/critical), it's suppressed.

3. **Signal picking** — `pickSignals()` selects the top 2 signals by urgency. At most 1 signal can require Sonnet (expensive). Overdue signals get urgency-escalated (>4 days overdue: low→medium).

4. **Prompt assembly** — Builds a rich `<context>` block with:
   - Module context providers (weekly plans, etc.)
   - Recent actions buffer (last 10 actions, prevents duplicates)
   - Module briefs with error handling instructions
   - Learning context from past cycles
   - Reasoning journal (open hypotheses)
   - Historical decision patterns

5. **Claude reasoning** — Configurable per path: WhatsApp uses `CLAUDE_MODEL` (default Sonnet), agent loop uses `AGENT_LOOP_SONNET_MODEL` (can be set to Opus for higher-quality autonomous work). 30-minute timeout for MCP operations.

6. **Response parsing** — Extracts structured XML tags from Claude's response. Each tag triggers specific actions (send message, update goal, record learning, etc).

7. **State writeback** — Updates signal timestamps (core + module state key maps), records actions in cross-cycle memory, links decision outcomes.

### Model Selection

| Condition | Model | Why |
|-----------|-------|-----|
| Any signal is high/critical urgency | Sonnet | Better reasoning for complex decisions |
| Goal work involves code keywords | Sonnet | Code generation quality |
| Followup with code topic | Sonnet | Same |
| Signal type in module's `sonnetSignalTypes` | Sonnet | Module-declared complex work |
| Everything else | Haiku | 10x cheaper, fast enough for routine tasks |

### Quiet Hours (23:00-08:00)

During quiet hours:
- No WhatsApp messages sent
- Agent loop interval extends to 60 minutes (saves cost)
- **Exception**: Module urgent work (via `hasUrgentWork()`) bypasses quiet hours
- **Exception**: Critical signals keep 10-minute interval

---

## Module System

Sela supports **optional modules** that extend the agent's capabilities without modifying core code. Modules are dynamically discovered at startup from `modules/*/index.js`.

### How It Works

```
startup ──> loadModules() scans modules/*/index.js
                │
                v
         dynamic import() each module manifest
                │
                v
         register into module-loader registry:
           - signal detectors
           - brief builders
           - context providers
           - API routes
           - dashboard pages
           - message categories
           - state key maps
           - Sonnet signal types
           - urgent work checkers
```

If the `modules/` directory is empty or missing, Sela runs cleanly with zero errors — all accessor functions return empty collections.

### Module Manifest

Each module exports a default object with a standard interface:

```javascript
// modules/my-module/index.js
export default {
  name: 'my-module',

  // Signal detection — called every agent cycle (must be zero-cost)
  detectSignals: (state) => [{ type: 'my_signal', urgency: 'low', summary: '...' }],

  // Brief builders — generate context prompts for specific signal types
  briefBuilders: {
    my_signal: (signal) => '## My Module Brief\n...',
  },

  // Context providers — functions injected into every agent cycle prompt
  contextProviders: [() => '## My Module Plan\n...'],

  // Signal types that require Sonnet (expensive model)
  sonnetSignalTypes: ['my_complex_signal'],

  // State writeback — maps signal types to state timestamp fields
  stateKey: 'my-module-state',
  stateKeyMap: {
    my_signal: 'lastMySignalAt',
  },

  // Message categorization — prefix → category for routing
  signalPrefix: 'my_',
  messageCategory: 'my-module',

  // Urgent work checker — bypasses quiet hours if true
  hasUrgentWork: () => false,

  // API routes — registered on the dashboard HTTP server
  apiRoutes: [
    { method: 'GET', path: '/my-module', handler: (req, res, ctx) => { ... } },
  ],

  // Dashboard page — adds a nav link + page to the web dashboard
  dashboard: {
    path: '/my-module',
    title: 'My Module',
    icon: '&#128736;',
    html: '<html>...</html>',
  },
};
```

All fields are optional. A module can implement just `detectSignals` and nothing else.

### Module Loader API

Core files never import modules directly. Instead, they use accessor functions from `lib/module-loader.js`:

```javascript
import { loadModules } from './lib/module-loader.js';
import {
  getModuleSignalDetectors,    // → [detectFn, ...]
  getModuleBriefBuilders,      // → { signalType: builderFn, ... }
  getModuleContextProviders,   // → [providerFn, ...]
  getModuleSonnetSignalTypes,  // → Set of signal type strings
  getModuleStateKeyMaps,       // → [{ stateKey, map }, ...]
  getModuleApiRoutes,          // → [{ method, path, handler }, ...]
  getModuleDashboardPages,     // → [{ path, title, icon, html }, ...]
  getModuleMessageCategories,  // → { 'prefix_': 'category', ... }
  checkModuleUrgentWork,       // → boolean
  getLoadedModules,            // → ['module-name', ...]
} from './lib/module-loader.js';

// Called once at startup before the agent loop begins
await loadModules();
```

### Integration Points

Modules plug into the agent loop at 7 points:

| Integration | How | When |
|------------|-----|------|
| **Signal detection** | `getModuleSignalDetectors()` called by `detectModuleSignals()` | Every cycle |
| **Brief injection** | `getModuleBriefBuilders()` matched by signal type | When module signal picked |
| **Context injection** | `getModuleContextProviders()` called during prompt assembly | Every cycle |
| **Model selection** | `getModuleSonnetSignalTypes()` merged into Sonnet-tier set | When picking model |
| **State writeback** | `getModuleStateKeyMaps()` used to write timestamps after actions | After cycle |
| **Quiet hours bypass** | `checkModuleUrgentWork()` checked during quiet hours | Quiet hours only |
| **Message routing** | `getModuleMessageCategories()` used for prefix→category lookup | During message categorization |

### Creating a Module

1. Create `modules/your-module/index.js` with a default export
2. Implement the fields you need (all optional)
3. Restart Sela — the module is auto-discovered

No changes to core files needed. The module system is designed so that adding or removing a module folder is the only step required.

---

## Cross-Cycle Memory

The agent maintains a rolling buffer of recent actions (last 24h, max 50 entries) in `kv_state['recent-actions']`. Every cycle, the 10 most recent actions are injected into the prompt:

```
## Recent actions (avoid duplicating):
- [economy_check] Economy not checked in 24h (2h ago)
- [action] Sent economy report to the user via WhatsApp (2h ago)
- [training_check] Training not checked in 24h (5h ago)
```

This prevents the agent from re-running the same checks and gives it awareness of what it recently did.

---

## Learning System

Three interconnected learning mechanisms:

### Learning Journal (`learning-journal.js`)
- Structured entries: `{ action, context, outcome, lesson }`
- Weekly Haiku synthesis → extracts actionable rules
- Rules ingested into Vestige for long-term memory
- Injected into agent prompt as learning context

### Reasoning Journal (`reasoning-journal.js`)
- Open hypotheses with evidence tracking
- Conclusions with confidence scores
- Auto-pruned after 7 days
- Gives the agent multi-cycle reasoning chains

### Agent Learning (`agent-learning.js`)
- Reflection cycle: analyzes errors, costs, signal resolution
- Goal momentum tracking
- Pattern extraction from past cycles

---

## Communication Channels

### WhatsApp (Primary)
- Context-aware conversation in Hebrew + English
- Personality defined in `SOUL.md` (auto-rewritten weekly based on engagement)
- Per-conversation history with compression at 40 messages
- Media handling (images, voice, documents)
- Semantic memory via Vestige MCP (facts extracted per-conversation)

### Telegram (Alerts + Commands)
- Real-time alerts: errors, agent actions, cost warnings
- Remote commands: `/status`, `/shutdown`, `/cron`, `/cost`, `/memory`, `/recap`, `/notes`, `/help`

### Web Dashboard (Control Center)
- Real-time WebSocket updates at `http://localhost:4242`
- System status, agent loop monitor, cost analytics
- Cron manager (view, toggle, trigger)
- Memory browser
- Module pages (dynamically added by loaded modules)

---

## Core Modules

### Agent Core

| Module | What It Does |
|--------|-------------|
| `agent-loop.js` | Main brain. 10-min cycle: collect signals → pick top 2 → build prompt → Claude reasons → parse response → execute actions → writeback state. Handles model selection (Haiku/Sonnet), quiet hours. |
| `agent-brain.js` | Pattern recognition on top of the loop. Trust-gated proposals, behavior adaptation based on response outcomes. |
| `agent-signals.js` | Core zero-cost signal detectors + `detectModuleSignals()` for module-registered detectors. |
| `agent-learning.js` | Reflection cycle — analyzes errors, costs, signal resolution rates, goal momentum. Produces `<learning>` block for prompt injection. |
| `module-loader.js` | Dynamic module discovery and registry. Scans `modules/*/index.js` at startup. All accessor functions return empty collections when no modules loaded. |

### Communication

| Module | What It Does |
|--------|-------------|
| `whatsapp.js` | Baileys socket management. Message routing, media handling, connection recovery (405 loop protection, auth clear cap). |
| `claude.js` | Claude CLI orchestration. Spawns `claude` processes with MCP tools, manages sessions, tracks costs per call. `chatOneShot()` for single prompts, `spawnClaude()` for interactive sessions. |
| `claude-persistent.js` | Keeps two Claude CLI processes alive (WhatsApp + agent loop). Messages piped via stdin for sub-second responses. Auto-respawn on crash. Separate processes for cache isolation. |
| `telegram.js` | Two-way Telegram bot. Sends alerts, receives commands, parses inline queries. |
| `bot-ipc.js` | HTTP + WebSocket server. Dashboard API endpoints, agent-loop trigger, dynamic module route dispatch. |

### Intelligence

| Module | What It Does |
|--------|-------------|
| `nlu-router.js` | Local intent classifier. 18 intents in Hebrew + English. Pattern matching — zero LLM cost. Handles: status, help, cost, cron, goal, memory, search, remind, and more. |
| `prompt-assembler.js` | Three-tier dynamic prompt (minimal ~2KB / standard ~5KB / full ~12KB). Auto-selects based on message complexity and cost pressure. |
| `tool-bridge.js` | Tool registry. Auto-discovers skill companions from `skills/*.js`. Parses Claude's tool call XML, executes against registered handlers (file I/O, HTTP, shell). Rate-limited. |
| `projects.js` | Project onboarding and management. Decomposes briefs into goals + milestones via Haiku. Auto-registers QMD collections for new projects. Import existing folders as projects. |
| `mcp-gateway.js` | Multi-server MCP gateway. Connects to any server in `mcp-config.json` (Vestige, QMD, etc). Lazy connections, per-server circuit breakers, reconnection with backoff. Vestige: semantic memory search, smart ingestion with dedup. QMD: GPU-accelerated codebase search (BM25 + vector + reranking). |
| `pain-point-analyzer.js` | Detects chronic errors, WhatsApp instability, and transfer deadline urgency. Runs every 6h via agent loop. |
| `skill-generator.js` | Dynamic skill document generation from templates + context. |

### Autonomy

| Module | What It Does |
|--------|-------------|
| `trust-engine.js` | Per-action-type trust scores (success rate × recency × volume). Four levels: always-ask → auto-execute. Destructive actions hard-capped at Level 1. |
| `chain-planner.js` | Multi-step workflow decomposition. 5 built-in templates + LLM fallback. Conditional branching, rollback on failure. |
| `workflow-engine.js` | Stateful DAG execution. Pause/resume, user input gates, trust-gated steps. |
| `confidence-gate.js` | Gates agent actions through confidence thresholds before execution. |
| `behavior-adaptor.js` | Maps context signals to behavior modifiers (suppress/encourage proactive actions). |

### Memory & State

| Module | What It Does |
|--------|-------------|
| `goals.js` | Goal CRUD with milestones, priority sorting, deadline alerts. Goals are the primary driver of the agent's proactive work. |
| `crons.js` | Cron job scheduler. Quiet-hour suppression, error tracking, engagement analytics. |
| `history.js` | Per-conversation history. Auto-compresses at 40 messages. Persistent across restarts. |
| `memory-index.js` | Unified search across Vestige, tiered memory, goals, and user notes. |
| `memory-tiers.js` | T1/T2/T3 weighted memory with decay and spaced repetition. |
| `state.js` | Key-value state in SQLite. Used by agent loop, modules, signals, and cross-cycle memory. |
| `context-gate.js` | Token budget management. Dedup, tier-aware scaling, prevents prompt bloat. |

### Operations

| Module | What It Does |
|--------|-------------|
| `error-recovery.js` | Error classification (transient/persistent/fatal). Contextual retry with exponential backoff. Escalates to Telegram (3+) and WhatsApp (5+) on repeat same-root-cause. |
| `cost-analytics.js` | Per-call token cost tracking. Daily/weekly/monthly rollups. Budget alerts. |
| `learning-journal.js` | Structured outcome entries + weekly Haiku rule synthesis. |
| `reasoning-journal.js` | Multi-cycle hypothesis tracking with evidence and conclusions. |
| `outcome-tracker.js` | Proposal sentiment, cron engagement, goal retrospectives. |
| `self-review.js` | Weekly SOUL.md personality rewrite based on engagement data, with rollback safety. |
| `watchdog.js` | Separate PM2 process. Pings `/healthz` every 5 minutes. Zombie process detection — scans logs every 60s for duplicate PIDs in WhatsApp 440 reconnect loops, auto-kills zombies, sends Telegram alert. |
| `memory-guardian.js` | 5-tier heap monitoring with graduated response (normal → warn → pressure → critical → restart). |

---

## Skills

13 markdown skill documents + executable JS companions (auto-discovered from `skills/*.js`), loaded on demand by keyword matching:

| Skill | Type | Domain |
|-------|------|--------|
| `google-calendar.js` | Companion | Google Calendar API |
| `gmail-reader.js` | Companion | Gmail API |
| `health-monitor.js` | Companion | System health checks |
| `scrapling.js` | Companion | Web scraping via Scrapling |
| `screenshot.js` | Companion | Desktop screenshot capture |
| `web-scraping.md` | Document | Web scraping strategies |
| `prompt-engineering.md` | Document | Prompt optimization |
| And more... | Document | Context management, DB backup, git sync, etc. |

## Plugins

| Plugin | Purpose |
|--------|---------|
| `command-logger` | Tracks slash command usage |
| `activity-summary` | Daily message count + cost metrics |
| `proposal-tracker` | Captures approval/rejection of agent proposals |
| `cron-health` | Monitors cron job health patterns |
| `auto-tag` | Auto-tagging conversations |

---

## Prerequisites

- **Node.js** 20+ (ES modules)
- **Claude CLI** — authenticated via OAuth (`~/.claude/.credentials.json`)
- **PM2** (recommended) — process management and auto-restart
- **Vestige MCP** (optional) — persistent semantic memory
- **QMD** (optional) — local document search with BM25 + vector embeddings + GPU reranking
- **CUDA Toolkit** (optional) — GPU acceleration for QMD embeddings (RTX 4050+ recommended)

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
   CLAUDE_MODEL=sonnet
   ```

   All 145+ tunable parameters have sensible defaults. See `lib/config.js` for the full list.

3. (Optional) Configure MCP servers in `mcp-config.json`:
   ```json
   {
     "mcpServers": {
       "vestige": { "command": "vestige-mcp" },
       "qmd": { "command": "qmd", "args": ["mcp"] }
     }
   }
   ```
   The multi-server gateway connects lazily — servers are only spawned when first used. Add any MCP-compatible server and call it via `callTool('server-name', 'tool', args)`.


4. (Optional) Customize personality in `SOUL.md`.

### First Run

```bash
node index.js
```

Scan the QR code with WhatsApp to link the bot as a paired device.

### Running with PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## Dashboard

Web dashboard at `http://localhost:4242`:

- **System status** — uptime, memory, queue, connections
- **Agent loop monitor** — real-time signals, Claude spawns, actions, goal events
- **Cost analytics** — daily spend, budget progress, 7-day trends
- **Cron manager** — view, toggle, trigger jobs
- **Projects** — create from brief, track goals + milestones, auto-QMD indexing
- **Memory browser** — search Vestige, ingest facts
- **Module pages** — dynamically added by loaded modules
- **Live updates** — WebSocket push, real-time event toasts

Start separately: `node dashboard.js`

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/status` | Bot status, uptime, queue stats |
| `/crons` | List all cron jobs |
| `/run <name>` | Trigger a cron job |
| `/cost [today\|week\|month]` | Cost report |
| `/memory <query>` | Search Vestige memories |
| `/notes` | List user notes |
| `/recap` | Daily activity summary |
| `/shutdown` | Graceful shutdown |
| `/help` | All commands |

## Project Structure

```
sela/
├── index.js                # Entry point — boots all subsystems
├── dashboard.js            # Web dashboard server (port 4242)
├── SOUL.md                 # Bot personality definition (auto-rewritten weekly)
├── .env.example            # Environment variable template
├── ecosystem.config.cjs    # PM2 configuration (sela + watchdog + dashboard)
├── mcp-config.json         # MCP server configuration
├── lib/                    # Core modules
│   ├── module-loader.js    # Dynamic module discovery and registry
│   ├── agent-loop.js       # Main agent brain + QMD auto-sync
│   ├── agent-signals.js    # Core signal detectors
│   ├── mcp-gateway.js      # Multi-server MCP gateway (Vestige, QMD, etc.)
│   ├── projects.js         # Project decomposition + workspace management
│   └── ...                 # 70+ other modules
├── modules/                # Optional modules (auto-discovered at startup)
│   └── my-module/
│       ├── index.js        # Module manifest (default export)
│       ├── signals.js      # Signal detectors
│       └── ...             # Module-specific files
├── skills/                 # Skill documents + companions
├── plugins/                # Dynamic plugins
├── test/                   # Test suite
├── scripts/                # Utility scripts
├── data/                   # Runtime data (gitignored)
│   ├── sela.db             # SQLite database (goals, kv_state, costs, errors)
│   ├── goals.json          # Goal tracking (synced with SQLite)
│   ├── state/              # Module state files, agent state
│   ├── cycle-diffs/        # Agent cycle diffs for review
│   └── workflows/          # Active workflow state
├── auth/                   # WhatsApp auth state (gitignored)
├── logs/                   # Pino log files (gitignored)
└── workspace/              # Project workspaces + sandboxed tool-bridge writes
```

## Tests

```bash
node test/run-all.js
```

49 tests across 27 suites covering NLU routing, queue concurrency, cost analytics, history, formatting, intent matching, workflow execution, goal management, module loading, and more.

## License

ISC
