# Sela Refactoring Plan
_Last updated: 2026-02-23_

## Overview

| File | Current lines | Target lines | Est. reduction |
|---|---|---|---|
| `dashboard.js` | 5,069 | ~350 | -94% |
| `lib/whatsapp.js` | 1,536 | ~650 | -58% |
| `lib/agent-loop.js` | 1,429 | ~720 | -50% |
| `lib/claude.js` | 1,274 | ~750 | -41% |
| **Total** | **9,308** | **~2,470** | **-73%** |

Extracted files add ~6,840 lines spread across ~18 new focused modules,
each with a single clear responsibility and a short import list.

---

## 1. dashboard.js (5,069 lines -> ~350 lines)

### Current structure (confirmed by grep)

```
Lines 1-73       Node.js server bootstrap: imports, login-rate-limiter,
                 cookie helpers, isAuthenticated(), proxyToIpc()
Lines 74-107     LOGIN_HTML template (inline string literal)
Lines 108-159    getIpcConfig() + proxyToIpc() helpers
Lines 160-2408   HTML -- main dashboard page (6 tabs)
Lines 2409-3301  AGENT_HTML -- agent monitor page
Lines 3302-3553  REVIEW_HTML -- code-review page
Lines 3554-3676  COST_ANALYTICS_HTML -- cost analytics page
Lines 3677-3988  BOARD_HTML -- goals board page
Lines 3989-4214  HISTORY_HTML -- conversation history page
Lines 4215-4375  ERRORS_HTML -- error log page
Lines 4376-4536  APPROVALS_HTML -- brain proposals page
Lines 4537-4861  IDEAS_HTML -- ideas tracker page
Lines 4862-5069  HTTP createServer() + WebSocket proxy + server.listen()
```

Each `*_HTML` template is a self-contained HTML page with embedded `<style>`
and `<script>` blocks. The embedded JS only calls the `/api/*` proxy and
the `/ws` WebSocket -- no server-side interpolation, no template variables.

### Strategy: serve pages as static .html files

No build step needed. The Node server gains a `serveStatic()` helper that
reads the file from `static/dashboard/` and streams it. All links, `/api/`,
and `/ws` paths stay identical.

#### New file layout

```
static/
  dashboard/
    login.html          <- LOGIN_HTML (lines 74-106)
    index.html          <- HTML (lines 160-2408)
    agent.html          <- AGENT_HTML (lines 2409-3301)
    review.html         <- REVIEW_HTML (lines 3302-3553)
    analytics.html      <- COST_ANALYTICS_HTML (lines 3554-3676)
    board.html          <- BOARD_HTML (lines 3677-3988)
    history.html        <- HISTORY_HTML (lines 3989-4214)
    errors.html         <- ERRORS_HTML (lines 4215-4375)
    approvals.html      <- APPROVALS_HTML (lines 4376-4536)
    ideas.html          <- IDEAS_HTML (lines 4537-4861)
```

#### dashboard.js after refactor (~350 lines)

The server becomes pure infrastructure: auth, static file serving, API
proxy, WebSocket proxy.  No HTML strings anywhere in the JS.

```js
// dashboard.js -- HTTP server only, no HTML strings
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';

// login rate-limiter, cookie helpers, isAuthenticated()  (~70 lines, unchanged)
// getIpcConfig(), proxyToIpc()                           (~50 lines, unchanged)

function serveStatic(res, name) {
  const file = join(import.meta.dirname, '../static/dashboard', name);
  if (!existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
}

// HTTP createServer() -- all HTML routes become one-liners  (~80 lines)
//   if (url.pathname === '/agent') { serveStatic(res, 'agent.html'); return; }

// WebSocket proxy (unchanged)                               (~60 lines)
// server.listen()                                           (~5 lines)
```

#### Migration steps

1. `mkdir -p ~/sela/static/dashboard`
2. For each `*_HTML` const: extract the template literal body to the
   corresponding `.html` file.  Strip the `const FOO_HTML = \`` wrapper
   and the trailing backtick -- just the raw HTML goes in the file.
3. Replace each `res.end(FOO_HTML)` call with `serveStatic(res, 'foo.html')`.
4. Delete all `const FOO_HTML = ...` declarations from dashboard.js.
5. Smoke-test every route in the browser:
   `/`, `/agent`, `/review`, `/analytics`, `/board`, `/history`,
   `/errors`, `/approvals`, `/ideas`

#### Note on shared helpers in embedded pages

Three pages each define their own `escHtml()` / `esc()` and `api()` helpers
(agent.html at original line 3008, review.html at line 3408, etc.). They
are tiny (5-10 lines each) and already duplicated, so leave them inline.
**Future optional step:** extract to `static/dashboard/shared.js` and add
`<script src="/static/dashboard/shared.js"></script>` to each page.

---

## 2. lib/whatsapp.js (1,536 lines -> ~650 lines)

### Current structure

```
Lines 1-61       Imports
Lines 62-214     trackSent(), sendWhatsAppMessage(), resolveFilePath(),
                 sendFileToWhatsApp(), chunkMessage(), sendReply()
Lines 215-222    executeAction() header / switch open
Lines 223-665    executeAction() body -- 30 switch cases (~443 lines)
Lines 666-737    createProgressTracker(), startComposingWatchdog()
Lines 738-917    startWhatsApp() -- client init, QR, connection events
Lines 918-1400   handleMessage() -- message routing, tier1, tier2 Claude flow
Lines 1401-1536  handleMediaMessage() -- audio/image/doc handling
```

### Extracted files

#### lib/wa-actions.js (~460 lines, new)

Extract the entire body of `executeAction()` (lines 223-665).

The 30 action cases: clear, help, status, cost, export, plugins, plugin-manage,
tasks, crons, addcron, today, files, skills, search, skill, addskill, delskill,
notes, save, send, goals, goal-manage, brain, recap, workflows, workflow-manage,
user-notes, review, rollback, default.

```js
// lib/wa-actions.js
// All /command action handlers dispatched from whatsapp.js handleMessage().
export async function executeAction(sock, sender, action, params = {}, botApi) {
  switch (action) {
    case 'clear': ...
    case 'help': ...
    // ... all 30 cases
  }
}
```

`whatsapp.js` imports it:

```js
import { executeAction } from './wa-actions.js';
```

The local call site in `handleMessage()` stays identical; only the function
body moves out.

#### lib/wa-media.js (~140 lines, new)

Extract `handleMediaMessage()` (lines 1401-1536).

```js
// lib/wa-media.js
// Handles incoming audio (Whisper transcription), image, and document messages.
export async function handleMediaMessage(sock, msg, sender, contentType) { ... }
```

Imports needed: transcribe (if OPENAI_API_KEY present), sendReply,
sendFileToWhatsApp -- a small, clear dependency list.

#### lib/wa-router.js (~90 lines, new)

The tier decision block inside `handleMessage()` (lines 991-1219) is
self-contained: it calls `routeMessage()`, resolves the model tier, handles
the `/task` planner, then delegates to tier-1 one-shot or tier-2 Claude flow.

```js
// lib/wa-router.js
// Resolves message tier (Haiku vs Sonnet) and routes to the Claude handler.
export async function routeAndRespond(sock, msg, sender, text, botApi, overrideTier) {
  ...
}
```

`handleMessage()` shrinks to:

```js
async function handleMessage(sock, msg, botApi) {
  // media check      (~30 lines, unchanged)
  // clarification    (~20 lines, unchanged)
  await routeAndRespond(sock, msg, sender, text, botApi, overrideTier);
}
```

#### Migration steps

1. Create `lib/wa-actions.js`: paste lines 223-665; resolve imports (each
   case uses a subset of whatsapp.js's import list -- scan each case).
2. Create `lib/wa-media.js`: paste lines 1401-1536 plus its imports
   (transcribe, sendReply, sendFileToWhatsApp).
3. Create `lib/wa-router.js`: paste the tier block from handleMessage() lines
   ~991-1400 plus its imports (chat, chatOneShot, routeMessage, etc.).
4. In `whatsapp.js`: replace each extracted body with import + call.
5. `node --check lib/whatsapp.js lib/wa-actions.js lib/wa-media.js lib/wa-router.js`

---
