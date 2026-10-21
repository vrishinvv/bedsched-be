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
    console.log('[BACKUP] Executing allocations query...');
    // Join to include human-readable location / tent / block names instead of numeric ids
    // LIMIT to recent records to avoid timeout on large datasets
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
      WHERE a.created_at >= NOW() - INTERVAL '90 days'
      ORDER BY a.id DESC
      LIMIT 50000
    `);

    console.log(`[BACKUP] Query returned ${result.rows.length} allocation records`);

    const columns = [
      'id', 'location_name', 'tent_name', 'block_name', 'tent_index', 'block_index', 'bed_number',
      'person_name', 'phone', 'gender', 'start_date', 'end_date', 'status', 'batch_id', 'is_family',
      'reserved_expires_at', 'created_at', 'updated_at', 'deleted_at'
    ];

    const csv = generateCSV(result.rows, columns);
    console.log(`[BACKUP] Generated allocations CSV (${csv.length} bytes)`);
    return csv;
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
    console.log('[BACKUP] Executing audit_logs query...');
    // LIMIT to recent records to avoid timeout
    const result = await execQuery(`
      SELECT 
        id, user_id, username, action, entity_type, entity_id,
        details, ip_address, created_at
      FROM audit_logs
      WHERE created_at >= NOW() - INTERVAL '90 days'
      ORDER BY id DESC
      LIMIT 50000
    `);

    console.log(`[BACKUP] Query returned ${result.rows.length} audit log records`);

    const columns = [
      'id', 'user_id', 'username', 'action', 'entity_type', 'entity_id',
      'details', 'ip_address', 'created_at'
    ];

    const csv = generateCSV(result.rows, columns);
    console.log(`[BACKUP] Generated audit_logs CSV (${csv.length} bytes)`);
    return csv;
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

    // Log attachment sizes
    const allocationsSize = Buffer.from(allocationsCSV).length;
    const auditLogsSize = Buffer.from(auditLogsCSV).length;
    const totalSize = allocationsSize + auditLogsSize;

    console.log(`[BACKUP] Attachment sizes: allocations=${(allocationsSize/1024).toFixed(2)}KB, audit_logs=${(auditLogsSize/1024).toFixed(2)}KB, total=${(totalSize/1024).toFixed(2)}KB`);

    // Warn if attachments are large (Resend has 40MB limit)
    if (totalSize > 40 * 1024 * 1024) {
      console.warn(`[BACKUP] WARNING: Total attachment size (${(totalSize/1024/1024).toFixed(2)}MB) exceeds 40MB limit`);
    }

    console.log(`[BACKUP] Sending to ${emailList.length} recipient(s): ${emailList.join(', ')}`);

    const { data, error } = await resend.emails.send({
      from: 'BedSched Backups <onboarding@resend.dev>', // Use onboarding address for dev
      to: emailList,
      subject: `BedSched Database Backup - ${timestamp}`,
      html: `
        <h2>Automated Database Backup</h2>
        <p>This is an automated backup of the BedSched database.</p>
        <p><strong>Timestamp:</strong> ${timestamp}</p>
        <p><strong>Tables included:</strong></p>
        <ul>
          <li>allocations (${(allocationsSize/1024).toFixed(2)}KB)</li>
          <li>audit_logs (${(auditLogsSize/1024).toFixed(2)}KB)</li>
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
      console.error('[BACKUP] Error details:', JSON.stringify(error, null, 2));
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

  // Set a timeout to avoid hanging forever (especially on Vercel)
  const timeoutMs = 50000; // 50 seconds (Vercel free tier is 10s, Pro is 60s)
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Backup timeout exceeded')), timeoutMs);
  });

  try {
    // Race between backup completion and timeout
    await Promise.race([
      (async () => {
        // Generate all CSVs
        console.log('[BACKUP] Generating allocations CSV...');
        const allocationsCSV = await backupAllocations();

        console.log('[BACKUP] Generating audit_logs CSV...');
        const auditLogsCSV = await backupAuditLogs();

        // Send email with attachments
        console.log('[BACKUP] Sending backup email...');
        try {
          await sendBackupEmail(allocationsCSV, auditLogsCSV, timestamp);
          console.log('[BACKUP] Backup completed successfully');
        } catch (emailError) {
          console.error('[BACKUP] Email sending failed, saving CSVs locally as fallback...');

          // Save to local files as fallback
          const fs = await import('fs');
          const path = await import('path');

          const backupDir = path.join(process.cwd(), 'backups');
          if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
          }

          const allocationsPath = path.join(backupDir, `allocations_${timestamp}.csv`);
          const auditLogsPath = path.join(backupDir, `audit_logs_${timestamp}.csv`);

          fs.writeFileSync(allocationsPath, allocationsCSV);
          fs.writeFileSync(auditLogsPath, auditLogsCSV);

          console.log(`[BACKUP] CSVs saved locally:`);
          console.log(`[BACKUP]   - ${allocationsPath}`);
          console.log(`[BACKUP]   - ${auditLogsPath}`);
          console.log('[BACKUP] Backup completed with local files (email failed)');

          throw emailError; // Re-throw to indicate partial failure
        }
      })(),
      timeoutPromise
    ]);
  } catch (err) {
    console.error('[BACKUP] Backup failed:', err.message);
    throw err;
  }
}
