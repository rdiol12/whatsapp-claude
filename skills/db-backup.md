# Database Backup System

Automated SQLite database backup with auto-discovery, encryption, and Google Drive upload.

## How It Works

1. **Auto-discovers** all SQLite databases in the workspace and OpenClaw directories (no manual config)
2. **Safe copies** using `sqlite3 .backup` (falls back to file copy)
3. **Archives** into a tar bundle with manifest
4. **Encrypts** with AES-256 (via 7z or gpg)
5. **Uploads** to Google Drive via rclone
6. **Prunes** old backups, keeping the last 7
7. **Alerts** on failure via Telegram

## Setup Required

### 1. Encryption key (required for encryption)
```powershell
[System.Environment]::SetEnvironmentVariable("OPENCLAW_BACKUP_KEY", "your-strong-passphrase", "User")
```

### 2. Google Drive (required for cloud upload)
```powershell
rclone config
# Create a remote named "gdrive" with type "drive"
# Follow the OAuth flow to authorize
```

## Commands

```bash
# Full backup (discover → copy → archive → encrypt → upload → prune)
node scripts/backup.js

# Dry run (discover only)
node scripts/backup.js --dry-run

# Local backup only (skip upload)
node scripts/backup.js --no-upload

# Restore from backup
.\scripts\restore.ps1 -BackupName "db-backup-2026-02-19T04-53-14.tar.7z"

# Restore and auto-copy back to original locations
.\scripts\restore.ps1 -BackupName "db-backup-2026-02-19T04-53-14.tar.7z" -AutoRestore
```

## Currently Discovered Databases

- `data/logs.db` — Structured logger
- `skills/knowledge-base/data/kb.db` — Knowledge base
- `skills/personal-crm/data/crm.db` — Personal CRM
- `../memory/main.sqlite` — Vestige memory (14.7 MB)
- Browser databases (auto-discovered)

New databases are picked up automatically on next run.

## Cron

Runs hourly via `db-backup-hourly` cron job. Silent unless something fails.

## State

`data/backup-state.json` — tracks runs, discovered DBs, and backup history.
