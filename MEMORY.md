# Bot Memory

Self-updating notes about the user's preferences, patterns, and learnings.
This file is injected into the system prompt. Update it when you discover
something worth remembering across conversations.

## User Preferences
- Prefers short, direct answers on WhatsApp
- Writes in both Hebrew and English (match his language)
- Timezone: Asia/Jerusalem (GMT+2)
- Quiet hours: 23:00–08:00 (don't send non-urgent messages)

## Communication Patterns
- "סבבה" / "אחלה" = acknowledgment, no response needed
- Frustration → skip pleasantries, go straight to fixing
- Technical questions → be precise, include file paths and line numbers

## Common Tasks
- Bot maintenance (crons, skills, plugins)
- Code fixes and feature development
- Checking system status and logs
- Hattrick team management (transfers, lineups, training)
- Project bug scanning (ProjGmar, SalaryApp)

## Active Projects (as of 2026-02-27)
- **SalaryApp** (HIGH): React Native/Expo shift management & salary calculator for Israeli market. Located at workspace/SalaryApp/. Bug scan done — 10 bugs found (3 critical calculation issues, 4 high, 3 medium). Report at workspace/SalaryApp/BUGS-REPORT.txt.
- **ProjGmar/SmartCart** (CRITICAL but goals removed by user): React+Vite frontend, Express+PostgreSQL backend. Bug scan done — 18 bugs found. Report at workspace/ProjGmar/BUGS-REPORT.txt.

## Hattrick Team State (as of 2026-02-27)
- Squad: ~20 players, avg TSI 1242. Recent form: W.
- GK: Zlatko Finka (GK 8, age 23) — starting. Biberman backup.
- Key signings: Suttipong Thairung (CD 7, 17yo), Rafa Ribeiro Pidal (Def 8, 17yo), Daniele Gusmai (Scoring 8, 21yo).
- Transfer watchlist: EMPTY (all targets acquired/lost).
- Selling: Attal, Aharon. Release candidates: Ben-Yitzhak, Pedahzur, Vider.
- Training: Scoring (Mallet+Kassab).

## Known Issues & Fixes
- WhatsApp 405 = session invalidated (phone logged out). Fix: `pm2 restart sela` then scan QR at `./qr.png`. Distinct from 408 = network timeout (self-recovers).
- WhatsApp 405 loop: FIXED (Cycle 272). waChannelSetSend moved to 'open' handler, totalAuthClearCount cap (max 3), 15s send timeout guard. Goal c2a155ea at 80%.
- Followup urgency inheritance: fixed Cycle 235 — signalKey() now uses goalId (not matchedGoal) for per-goal cooldowns.
- Hattrick post-match review signal loop: FIXED (Cycle 278). loadState() in agent-loop.js now reads from 'hattrick-cycle' kv_state to populate lastHattrickPostMatchReviewAt and lastHattrickTransferCheckAt. Previously those were never read despite being saved by hattrick-cycle.js.
- Timeout log inflation: a single Claude API timeout triggers ~20 resilience retry log entries. Actual unique timeout events are 3-4/day, not the apparent count in raw grep.
- Memory Guardian false positives: FIXED. getHeapStats() used heapUsed/heapTotal (V8 dynamic alloc ~55MB) → always 85-98%. Fixed to use RSS/PM2_limit (512MB). Real usage is ~14%. All 90%+ alerts were false positives.

## Lessons Learned
- Test files use plain Node.js (no Jest/Vitest) — run with: node test/run-all.js. All 27 suites pass.
- Proactive triggers (goal_progress, anomaly, idle_time) are in agent-loop.js lines 151-242, integrated at collectSignals().
- Skills autoDetect is wired in claude.js (registryAutoDetect at line 155) — Skills M3 was already done.
- Voice transcription: lib/transcribe.js wraps OpenAI Whisper via fetch+FormData. Requires OPENAI_API_KEY. Falls back gracefully if missing.
- Cycle cost control: Sonnet only for high/critical signals or code-keyword goal milestones. Haiku for all else.
- Hard Sonnet daily cap: IMPLEMENTED (Cycle 313). `dailySonnetCost` tracked in agent-loop.js state. Cap = $5/day (env: AGENT_LOOP_SONNET_DAILY_CAP). Alerts via Telegram, resets at midnight IL.
- Circuit breaker: ALREADY EXISTS in error-recovery.js (lines 27-67). 3 failures in 5min window → circuit opens for 10min. No code needed.
- Cost control goal (6d35a8d3): COMPLETED 100% in Cycle 313.
- Timeout log inflation: ~20 log lines per real timeout due to resilience.js retry loop — known, minor. Circuit breaker addresses runaway retries.
- Transfer watchlist stale signals: The signal system may report N targets even when the actual kv_state watchlist items=[] is empty. Always verify with kvGet('hattrick-transfer-watchlist') before acting.
- Telegram markdown errors are self-healing: messages retry without parse_mode automatically. No code fix needed.
- Memory pressure 90%+ was ALWAYS a false positive (see fix above). After the fix, real RSS is ~14% of PM2 limit. Memory Guardian now uses RSS/PM2_limit metric.
- "Invalid status transition" errors in goals.js are validation working correctly, not bugs. Happens when user modifies goals externally.
