# Health Monitor

Automated health monitoring with daily/weekly/monthly checks. Philosophy: silence means everything is fine.

## Usage

```bash
node scripts/health-check.js                    # Run all due checks
node scripts/health-check.js --force             # Force all checks regardless of schedule
node scripts/health-check.js --check daily       # Run only daily checks
node scripts/health-check.js --check weekly      # Run only weekly checks
node scripts/health-check.js --check monthly     # Run only monthly checks
```

## Checks

### Daily
- **social-data-freshness**: Flag if social media tracker data is older than 3 days
- **repo-size**: Alert if any git repo exceeds 500MB (binary blob accumulation)
- **error-log-scan**: Scan logs for recurring error patterns
- **git-backup**: Auto-commit and push workspace changes

### Weekly
- **gateway-bind**: Verify gateway only binds to localhost
- **gateway-auth**: Verify authentication is enabled
- **cron-health**: Verify all cron jobs are running without errors

### Monthly
- **injection-scan**: Scan memory files for suspicious prompt injection patterns
- **stale-memory**: Flag memory files that haven't been updated in 30+ days
- **disk-usage**: Check workspace disk usage trends

## State

All check timestamps tracked in `data/health-state.json`. Checks skip if not due.

## Alerts

Only alerts when something needs attention. Silent = healthy.
Alerts go to Telegram (chat ID 6965182247).
