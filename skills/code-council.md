# Code Council

Automated codebase audit that reviews security, code quality, and suggests features. Three perspectives in one pass.

## Usage

Run on-demand via WhatsApp: mention "code council", "audit the code", "review the codebase", or "security audit".
Also runs weekly via cron (Sunday 22:00 Israel time).

## Audit Process

You are performing a 3-panel code council review of the WhatsApp Claude bot at ~/whatsapp-claude/. Read ALL source files in lib/ and index.js, then produce a single structured report covering three perspectives:

### Panel 1: Security Auditor
Review for:
- Injection vulnerabilities (command injection, path traversal, prompt injection)
- Authentication/authorization bypass
- Secret exposure (hardcoded tokens, credentials in logs)
- Unsafe file operations (arbitrary read/write, directory traversal)
- Plugin system security (isolation, state access)
- Dependency vulnerabilities
- Data integrity risks

For each finding: Severity (CRITICAL/HIGH/MEDIUM/LOW), file:line, exploit scenario, fix.

### Panel 2: Code Quality Reviewer
Review for:
- Bugs and logic errors
- Memory leaks (growing Sets, Maps, arrays)
- Resource leaks (zombie processes, unclosed connections)
- Error handling gaps (unhandled rejections, missing catch blocks)
- Race conditions and concurrency issues
- Edge cases (null messages, empty strings, large files)
- Missing tests (identify top 5 functions that need tests)

For each finding: Severity (BUG/WARNING/INFO), file:line, impact, fix.

### Panel 3: Feature Strategist
Suggest 5-10 improvements in categories:
- Quick wins (< 50 lines, high impact)
- Plugin ideas (leverage onMessage, onCommand, preChat, postChat hooks)
- Quality of life improvements
- Power features
- Missing vs commercial products (ChatGPT, Claude app)

For each: name, effort (trivial/small/medium), which files, why it matters.

## Output Format

Structure the report as:

```
*CODE COUNCIL REPORT*
Date: YYYY-MM-DD

*SECURITY* (X findings)
CRITICAL: [count]
HIGH: [count]
- [one-line summary per finding]

*CODE QUALITY* (X findings)
BUGS: [count]
- [one-line summary per finding]

*TOP 5 FEATURES*
1. [name] — [one-line description] ([effort])
...

*ACTION ITEMS* (prioritized)
1. [most urgent fix]
2. ...
3. ...
```

Keep the WhatsApp output concise (under 3000 chars). Save the full detailed report to ~/whatsapp-claude/workspace/council-report-YYYY-MM-DD.md using the Write tool.

## Comparison with Previous Reports

Before writing the report, check if a previous council report exists in ~/whatsapp-claude/workspace/ (glob for council-report-*.md). If found, compare findings: note what was fixed since last time, what is new, and what persists. Include a "Delta" section.

## Alerts

If any CRITICAL security finding is found, send a Telegram alert immediately (don't wait for the full report).
