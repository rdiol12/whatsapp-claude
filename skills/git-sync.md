---
name: "Git Auto-Sync"
description: "Automated hourly commits, tags, and pushes with built-in security scanning to detect and prevent credential leaks."
keywords: ["git", "sync", "commit", "push", "automation", "version-control", "security", "scanning"]
category: "operations"
tags: ["automated", "security", "git", "scheduled"]
---

# Git Auto-Sync

Hourly auto-commit, tag, and push with security scanning.

## What It Does

1. **Stages** all workspace changes
2. **Scans** for sensitive data (API keys, tokens, cookies, credentials)
3. **Blocks** dangerous files, unstages them, continues with safe files
4. **Commits** with timestamp message
5. **Tags** with `sync-YYYY-MM-DD-HHMM`
6. **Pulls** with rebase (detects merge conflicts)
7. **Pushes** to origin/main

## Security Pre-Commit Checks

**Blocked filenames:** auth-profiles.json, credentials.json, token.json, cookies, .env, service-account keys, rclone.conf, .key, .pem, browser user-data

**Scanned content:** Anthropic keys (sk-ant-*), OpenAI keys (sk-*), Google keys (AIzaSy*), GitHub tokens (ghp_*), AgentMail keys (am_*), Bearer tokens, private keys

## Commands

```bash
node scripts/sync.js              # Full sync
node scripts/sync.js --dry-run    # Show what would sync
node scripts/sync.js --no-push    # Commit locally only
```

## Cron

Runs every hour at :30 via `git-auto-sync`. Silent unless conflict or error.

## Alerts (Telegram)

- 🚨 Merge conflict detected → manual resolution needed
- 🚨 Sensitive data blocked → which files and why
- ❌ Push/pull failure → error details
