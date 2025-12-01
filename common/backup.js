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
    // Join to include human-readable location / tent / block names instead of numeric ids
    const result = await execQuery(`
      SELECT 
        a.id,
        l.name as location_name,
        t.name as tent_name,
        b.name as block_name,
        a.tent_index,
        a.block_index,
        a.bed_number,
        a.name as person_name,
        a.phone,
        a.gender,
        a.start_date,
        a.end_date,
        a.status,
        a.batch_id,
        a.is_family,
        a.reserved_expires_at,
        a.created_at,
        a.updated_at,
        a.deleted_at
      FROM allocations a
      LEFT JOIN blocks b ON a.block_id = b.id
      LEFT JOIN tents t ON b.tent_id = t.id
      LEFT JOIN locations l ON t.location_id = l.id
      ORDER BY a.id
    `);

    const columns = [
      'id', 'location_name', 'tent_name', 'block_name', 'tent_index', 'block_index', 'bed_number',
      'person_name', 'phone', 'gender', 'start_date', 'end_date', 'status', 'batch_id', 'is_family',
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
 * Sends backup email with CSV attachments to multiple recipients
 */
async function sendBackupEmail(allocationsCSV, auditLogsCSV, timestamp) {
  try {
    // Parse comma-separated email list from config
    const emailList = config.backupEmail
      .split(',') 
      .map(email => email.trim())
      .filter(email => email.length > 0);
    
    if (emailList.length === 0) {
      throw new Error('No valid email addresses found in BACKUP_EMAIL config');
    }

    const { data, error } = await resend.emails.send({
      from: 'BedSched Backups <backups@resend.dev>', // Use your verified domain if available
      to: emailList,
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


