import cron from 'node-cron';
import { Resend } from 'resend';
import { execQuery } from './db.js';
import { config } from './configs.js';

const resend = new Resend(config.resendApiKey);

/**
 * Generates CSV content from database rows
 */
function generateCSV(rows, columns) {
  if (!rows || rows.length === 0) {
    return columns.join(',') + '\n'; // Return just headers if no data
  }

  const headers = columns.join(',');
  const csvRows = rows.map(row => {
    return columns.map(col => {
      const val = row[col];
      // Handle nulls and escape quotes
      if (val === null || val === undefined) return '';
      const str = String(val).replace(/"/g, '""'); // Escape quotes
      return `"${str}"`;
    }).join(',');
  });

  return [headers, ...csvRows].join('\n');
}

/**
 * Fetches all data from allocations table and generates CSV
 */
async function backupAllocations() {
  try {
    const result = await execQuery(`
      SELECT 
        id, location_id, tent_id, block_id, tent_index, block_index, bed_number,
        name, phone, gender, start_date, end_date, status, batch_id, is_family,
        reserved_expires_at, created_at, updated_at, deleted_at
      FROM allocations
      ORDER BY id
    `);

    const columns = [
      'id', 'location_id', 'tent_id', 'block_id', 'tent_index', 'block_index', 'bed_number',
      'name', 'phone', 'gender', 'start_date', 'end_date', 'status', 'batch_id', 'is_family',
      'reserved_expires_at', 'created_at', 'updated_at', 'deleted_at'
    ];

    return generateCSV(result.rows, columns);
  } catch (err) {
    console.error('[BACKUP] Error backing up allocations:', err);
    throw err;
  }
}

/**
 * Fetches all data from audit_logs table and generates CSV
 */
async function backupAuditLogs() {
  try {
    const result = await execQuery(`
      SELECT 
        id, user_id, username, action, entity_type, entity_id,
        details, ip_address, created_at
      FROM audit_logs
      ORDER BY id
    `);

    const columns = [
      'id', 'user_id', 'username', 'action', 'entity_type', 'entity_id',
      'details', 'ip_address', 'created_at'
    ];

    return generateCSV(result.rows, columns);
  } catch (err) {
    console.error('[BACKUP] Error backing up audit_logs:', err);
    throw err;
  }
}

/**
 * Sends backup email with CSV attachments
 */
async function sendBackupEmail(allocationsCSV, auditLogsCSV, timestamp) {
  try {
    const { data, error } = await resend.emails.send({
      from: 'BedSched Backups <backups@resend.dev>', // Use your verified domain if available
      to: [config.backupEmail],
      subject: `BedSched Database Backup - ${timestamp}`,
      html: `
        <h2>Automated Database Backup</h2>
        <p>This is an automated backup of the BedSched database.</p>
        <p><strong>Timestamp:</strong> ${timestamp}</p>
        <p><strong>Tables included:</strong></p>
        <ul>
          <li>allocations</li>
          <li>audit_logs</li>
        </ul>
        <p>All CSV files are attached to this email.</p>
        <hr>
        <p style="color: #666; font-size: 12px;">This is an automated message from BedSched backup system.</p>
      `,
      attachments: [
        {
          filename: `allocations_${timestamp}.csv`,
          content: Buffer.from(allocationsCSV).toString('base64'),
        },
        {
          filename: `audit_logs_${timestamp}.csv`,
          content: Buffer.from(auditLogsCSV).toString('base64'),
        },
      ],
    });

    if (error) {
      console.error('[BACKUP] Resend API error:', error);
      throw error;
    }

    console.log('[BACKUP] Email sent successfully:', data?.id);
    return data;
  } catch (err) {
    console.error('[BACKUP] Error sending backup email:', err);
    throw err;
  }
}

/**
 * Main backup function - generates CSVs and sends email
 */
export async function runBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  console.log(`[BACKUP] Starting backup at ${timestamp}`);

  try {
    // Generate all CSVs
    console.log('[BACKUP] Generating allocations CSV...');
    const allocationsCSV = await backupAllocations();
    
    console.log('[BACKUP] Generating audit_logs CSV...');
    const auditLogsCSV = await backupAuditLogs();

    // Send email with attachments
    console.log('[BACKUP] Sending backup email...');
    await sendBackupEmail(allocationsCSV, auditLogsCSV, timestamp);

    console.log('[BACKUP] Backup completed successfully');
  } catch (err) {
    console.error('[BACKUP] Backup failed:', err.message);
  }
}

/**
 * Initialize backup scheduler - runs every 6 hours
 */
export function initBackupScheduler() {
  // Check if backup is enabled
  if (!config.resendApiKey) {
    console.log('[BACKUP] Backup scheduler disabled - RESEND_API_KEY not configured');
    return;
  }

  // Schedule backup every 6 hours (at 00:00, 06:00, 12:00, 18:00)
  cron.schedule('0 */6 * * *', async () => {
    console.log('[BACKUP] Scheduled backup triggered');
    await runBackup();
  });

  console.log('[BACKUP] Backup scheduler initialized - running every 6 hours');
  console.log('[BACKUP] Backup email will be sent to:', config.backupEmail);
  
  // Optional: Run backup immediately on startup (comment out if not needed)
  // console.log('[BACKUP] Running initial backup on startup...');
  // setTimeout(() => runBackup(), 5000); // Wait 5s for server to fully start
}
