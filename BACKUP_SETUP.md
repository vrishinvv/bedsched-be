# Backup System Setup

## Overview
The backup system generates CSV exports of allocations and audit logs, then emails them using Resend.

## Vercel Deployment

### Configuration Required

1. **Environment Variables** (in Vercel dashboard):
   ```
   RESEND_API_KEY=re_xxxxx
   BACKUP_EMAIL=your-verified-email@domain.com
   CRON_SECRET=your-random-secret-string
   ```

2. **vercel.json** (already configured):
   - Cron runs daily at midnight UTC
   - Uses dedicated `/api/cron/backup` endpoint
   - 60-second timeout for Pro tier (10s for free tier)

### Limitations on Vercel

Due to serverless constraints:
- **Data limit**: Only backs up last 90 days (50,000 records max)
- **Timeout**: 10s (free) or 60s (Pro tier)
- **Email size**: Resend has 40MB attachment limit

### Testing Backup

**Manual trigger** (for admins):
```
GET /api/admin/trigger-backup
```
Note: Response comes immediately, backup runs in background

**Direct cron endpoint** (protected):
```
GET /api/cron/backup
Authorization: Bearer YOUR_CRON_SECRET
```

### Monitoring

Check Vercel logs after cron runs:
- `[BACKUP] Starting backup at...` - Started
- `[BACKUP] Query returned X records` - Data fetched
- `[BACKUP] Generated CSV (X bytes)` - CSV created
- `[BACKUP] Attachment sizes: ...` - Email prep
- `[BACKUP] Email sent successfully` - Completed

### Common Issues

**"Connection timeout"**:
- Database query too slow
- Too much data
- Solution: Already limited to 90 days

**"Unable to fetch data"**:
- Resend API issue
- Check RESEND_API_KEY is valid
- Verify BACKUP_EMAIL is verified in Resend dashboard

**"Email sending failed"**:
- Fallback: CSVs saved to `/tmp/backups/` (Vercel ephemeral)
- Note: Files lost after function execution

## Alternative: GitHub Actions (Recommended for Full Backup)

For complete historical backups, use GitHub Actions:

1. Create `.github/workflows/backup.yml`
2. Run on schedule with no serverless limits
3. Upload to GitHub Releases or S3

## Local Development

Run backup manually:
```bash
node -e "import('./common/backup.js').then(m => m.runBackup())"
```

CSVs saved to `./backups/` directory if email fails.
