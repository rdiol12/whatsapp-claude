# Sela Codebase Report — 2026-02-23

Generated after full analysis: codebase structure, git state, test coverage.

---

## 1. Codebase Health

### Size Overview

| Category | Files | Lines |
|---|---|---|
| lib/ (core modules) | 61 | 23,481 |
| test/ | 26 | 6,919 |
| skills/ | 19 | 1,749 |
| root .js (index, dashboard, setup) | 3 | 3,276 |
| **Total** | | **~35,425** |

Test-to-code ratio: **29%** (6,919 / 23,481). Healthy target is ~50-70%.

### Largest Files

| File | Lines | Has Test? |
|---|---|---|
| dashboard.js (root) | 2,548 | ❌ |
| lib/claude.js | 1,357 | ❌ |
| lib/agent-loop.js | 1,349 | ✅ |
| lib/whatsapp.js | 1,074 | ❌ |
| lib/agent-brain.js | 1,039 | ✅ |
| lib/bot-ipc.js | 943 | ❌ |
| lib/nlu-router.js | 935 | ✅ |
| lib/workflow-engine.js | 746 | ✅ |
| lib/goals.js | 617 | ✅ |
| lib/outcome-tracker.js | 553 | ✅ |

### Syntax Errors
**Zero.** All 61 lib/*.js files pass `node --check`.

### Code Quality Signals
- **TODO/FIXME/HACK comments:** Zero found in lib/
- **Inappropriate console.log:** Zero in server-side code. Only `lib/dashboard-html/agent.js` uses console — correct, it's browser JS.
- **No dead branches or stuck migrations** observed.

---

## 2. Git & PR State

### Branch Strategy
- Single branch: `master`
- No PRs open
- No feature branches
- **Risk:** Everything merges directly to master with no review gate. One bad commit can break production.

### Uncommitted Changes (3 files)
```
lib/command-dispatcher.js  +7 lines
lib/intent.js              +4 lines, -2 lines
lib/nlu-router.js          +22 lines
```
These changes are from today's session and have not been staged or committed. They should be reviewed and committed.

### Spurious Untracked File
`nul` appears as an untracked file — this is a Windows NUL device artifact. Add to `.gitignore`:
```
nul
```

### Recent Commit Pattern
The last commit `18b04b8` touched **40+ files** in a single shot. Commits like this make it hard to bisect bugs. Prefer smaller, atomic commits per feature/fix.

---

## 3. Test Coverage

### Summary
- **26 test suites**, 6,919 lines
- **20 of 63 lib modules covered (32%)**
- **43 modules have zero tests**
- **1 failing suite** (see below)

### ✅ Covered Modules
agent-brain, agent-loop, cost-analytics, crons, db, formatter, goals, history, intent, memory-tiers, nlu-router, outcome-tracker, plugins, queue, resilience, router, skill-registry, state, user-notes, workflow-engine

### ❌ Critical Gaps (untested, by size)

| Module | Lines | Why it matters |
|---|---|---|
| claude.js | 1,357 | Core AI client — all API calls, token counting, model selection |
| whatsapp.js | 1,074 | Core message I/O — send, receive, chunking, reactions |
| bot-ipc.js | 943 | IPC layer between processes — all dashboard/agent comms |
| command-dispatcher.js | 499 | All slash commands and NLU-triggered actions |
| context-gate.js | 465 | Token budget gating — critical for cost control |
| daily-digest.js | 454 | Daily summary generation |
| mcp-gateway.js | 447 | Vestige MCP bridge — memory reads/writes |
| claude-persistent.js | 428 | Persistent session management |
| proactive.js | 320 | Proactive agent trigger logic |
| trust-engine.js | ~250 | Autonomy scoring |
| tool-bridge.js | 352 | External tool execution |
| skill-generator.js | ~250 | Dynamic skill creation |
| channel-telegram.js | ~200 | Telegram channel adapter |
| ws-gateway.js | ~200 | WebSocket gateway |
| mood-engine.js | ~150 | Mood/context detection |

### 🔴 Failing Suite: memory-tiers.test.js
**15 out of 38 tests failing** — all tier classification mismatches.

Failing cases:
```
"hi" → expected tier 1
"status" → expected tier 1
"what time" → expected tier 1
"why did the build fail?" → expected tier 3
"fix the bug in login" → expected tier 3
"write a script to..." → expected tier 3
"debug the cron job" → expected tier 3
"```code block```" → expected tier 3
"deploy the app" → expected tier 3
"http://example.com" → expected tier 3
"500+ chars" → expected tier 3
"תקן את הבאג" → expected tier 3
"help me fix the server" → expected tier 3
"" → expected tier 1 (empty → short)
"  " → expected tier 0 (whitespace → ack-like)
```

**Root cause:** `lib/intent.js` and `lib/nlu-router.js` were modified today (+26 lines unstaged). The tier routing logic changed but `memory-tiers.test.js` wasn't updated to match. Either the tests need updating to reflect the new logic, or the logic has a regression.

**Action required before next commit.**

---

## 4. Skills Analysis

| Skill | Lines | Status |
|---|---|---|
| smoke-test-auto-ping.md | 17 | ⚠️ STUB — no implementation |
| image-gen.md | 30 | Minimal |
| humanizer.md | 32 | Minimal |
| task-extractor.md | 36 | Minimal |
| content-pipeline.md | 38 | Minimal |
| business-briefing.md | 41 | OK |
| regex-patterns.md | 474 | Rich |
| prompt-engineering.md | 254 | Rich |
| context-manager.md | 228 | Rich |

**smoke-test-auto-ping.md** is a stub — it exists in the registry but has no actual logic. If invoked, the agent will get no actionable instructions.

Several "minimal" skills (image-gen, humanizer, task-extractor, content-pipeline) have less than 40 lines — likely need more usage examples and edge case guidance.

---

## 5. Architecture Observations

### What's Working Well
- Clean ESM module structure throughout
- Pino logging is consistent — no console.log leakage in server code
- SQLite WAL mode for concurrent access
- Good separation of concerns: channel adapters, IPC, brain, loop
- Signal-based agent loop (collectSignals → score → act) is solid

### Concerns

**1. dashboard.js (2,548 lines) still large**
The HTML template extraction reduced it from 5,069 to 2,548, but it's still the largest file. The main HTML block (~2,200 lines) is still embedded inline.

**2. claude.js (1,357 lines) is untested and high-risk**
This is the core AI client. It handles model selection, token counting, context injection, cost tracking, and persistent session management. Zero test coverage here means any regression goes undetected until it hits production.

**3. No branch protection**
All code goes directly to master. A PR-based workflow (even self-reviewed) would catch regressions earlier.

**4. Test isolation**
Only 3 unique lib imports across all test files — most tests use inline mocks. This is pragmatic but means tests don't catch real integration failures between modules. The `whatsapp-claude-roundtrip.test.js` is a good counterexample — keep adding integration tests.

**5. Costs.jsonl rotation cron not yet scheduled**
`rollupOldCosts()` is implemented but there's no Sunday cron wired up (M3 pending).

**6. Skills M4 not done**
`agent-brain.js` doesn't yet emit `skill_invoke` signals based on intent detection. Skills are detected by the registry but not automatically routed.

---

## 6. Prioritized Recommendations

### 🔴 Immediate (this cycle)
1. **Fix memory-tiers.test.js** — 15 failures. Either update tests to match new tier logic in intent.js/nlu-router.js, or revert the logic change.
2. **Commit the 3 unstaged files** — command-dispatcher.js, intent.js, nlu-router.js.
3. **Add `nul` to .gitignore** — Windows artifact.

### 🟡 High Priority (next 1-2 cycles)
4. **Test claude.js** — Even 10-15 tests covering: model selection, token counting, cost tracking, error handling. This is the highest-risk untested file.
5. **Test command-dispatcher.js** — All slash commands. Straightforward to test with mock socket.
6. **Test context-gate.js** — Token budget logic affects cost directly.
7. **Wire Skills M4** — Intent detection → skill_invoke signals in agent-brain.js.
8. **Schedule costs rotation cron** — Sunday midnight, rollupOldCosts(7).

### 🟢 Medium Priority (next few cycles)
9. **Implement smoke-test-auto-ping** — It's listed as a skill but does nothing.
10. **Expand minimal skills** — image-gen, humanizer, task-extractor need more content.
11. **Consider branch protection** — Even a lightweight rule: "run tests before merge."
12. **Reduce dashboard.js further** — Extract the main HTML template (~2,200 lines) into dashboard-html/.
13. **Test proactive.js and trust-engine.js** — These drive autonomous behavior; bugs here cause subtle issues.
14. **Response quality M4** — Pattern aggregation by topic/sentiment (currently 60%).

---

## Summary Stats

| Metric | Value |
|---|---|
| Total lib files | 61 |
| Syntax errors | 0 |
| Test suites | 26 |
| Passing suites | 25 |
| **Failing suites** | **1 (memory-tiers)** |
| Test coverage (by module) | 32% (20/63) |
| Open PRs | 0 |
| Unstaged changes | 3 files |
| Skill stubs | 1 (smoke-test-auto-ping) |
| TODO/FIXMEs | 0 |
