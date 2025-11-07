# BedSched Database Backup System

## Overview
Automated database backup system that generates CSV files and emails them every 6 hours.

## Configuration

### Environment Variables
Add these to your `.env` file:

```bash
# Resend API Key (get from https://resend.com)
RESEND_API_KEY=re_your_api_key_here

# Email address to receive backups (default: vvnihsirv@gmail.com)
BACKUP_EMAIL=your-email@example.com
```

### Getting Resend API Key
1. Go to https://resend.com
2. Sign up or log in
3. Navigate to API Keys section
4. Create a new API key
5. Copy and paste into `.env` file

## Features

### Automatic Backups
- **Schedule**: Every 6 hours (00:00, 06:00, 12:00, 18:00)
- **Tables backed up**:
  - `allocations` (all data including deleted records)
  - `dall_values` (all beds and allocation status)
  - `audit_logs` (all audit trail records)

### File Format
- **Format**: CSV with headers
- **Naming**: `{table_name}_{timestamp}.csv`
- **Example**: `allocations_2025-11-07T18-00-00.csv`

### Email Delivery
- **Subject**: `BedSched Database Backup - {timestamp}`
- **Attachments**: 3 CSV files (one per table)
- **Sender**: `BedSched Backups <backups@resend.dev>`

## Manual Backup Trigger

You can manually trigger a backup via API (admin only):

```bash
GET /api/admin/trigger-backup
Authorization: Bearer {admin_jwt_token}
```

Response:
```json
{
  "ok": true,
  "message": "Backup triggered, check server logs for status"
}
```

## Monitoring

Check server logs for backup status:
```bash
# Backup scheduled
[BACKUP] Backup scheduler initialized - running every 6 hours

# Backup running
[BACKUP] Starting backup at 2025-11-07T18-00-00
[BACKUP] Generating allocations CSV...
[BACKUP] Generating dall_values CSV...
[BACKUP] Generating audit_logs CSV...
[BACKUP] Sending backup email...
[BACKUP] Email sent successfully: email_id_12345
[BACKUP] Backup completed successfully

# If backup is disabled
[BACKUP] Backup scheduler disabled - RESEND_API_KEY not configured
```

## Error Handling
- Failed backups are logged to console but don't crash the server
- If email sending fails, error is logged with details
- Database query errors are caught and logged

## Security Notes
- Only admin users can manually trigger backups
- All data including deleted records is included (for complete recovery)
- CSV files contain sensitive data - email is sent over TLS

## Disabling Backups
To disable automatic backups:
1. Remove or comment out `RESEND_API_KEY` from `.env`
2. Restart the server
3. You'll see: `[BACKUP] Backup scheduler disabled`

## Data Retention
- Backups are sent via email (not stored on server)
- You should configure email retention policies in your email client
- Recommended: Create a dedicated folder/label for backup emails
