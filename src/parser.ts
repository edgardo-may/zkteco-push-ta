import { parse } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';
import { ParsedAttendanceRecord } from './types.js';

/**
 * Maps ZKTeco attendance status code to a descriptive string.
 * ZKTeco standard status:
 * 0: Check In
 * 1: Check Out
 * 2: Break Out (Start Break)
 * 3: Break In (End Break)
 * 4: Overtime In
 * 5: Overtime Out
 */
export function mapZKStatus(status: string): string {
  const trimmed = status.trim();
  switch (trimmed) {
    case '0':
      return 'check_in';
    case '1':
      return 'check_out';
    case '2':
      return 'break_out';
    case '3':
      return 'break_in';
    case '4':
      return 'overtime_in';
    case '5':
      return 'overtime_out';
    default:
      // If it is already a descriptive string, return it
      return trimmed || 'check_in';
  }
}

/**
 * Parses ZKTeco ADMS upload log text body.
 * Typical format for table=ATTLOG:
 * Each line is:
 * PIN\tTIMESTAMP\tSTATUS\tVERIFYMETHOD\tWORKCODE\tRESERVED
 * Example:
 * 101\t2026-08-12 22:30:00\t0\t15\t0\t0
 * 
 * Also supports space-separated fields if tab is not present.
 */
export function parseAttendanceLogs(bodyText: string, deviceTimezone: string = 'America/Mexico_City'): ParsedAttendanceRecord[] {
  if (!bodyText || !bodyText.trim()) {
    return [];
  }

  const records: ParsedAttendanceRecord[] = [];
  const lines = bodyText.split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Skip empty lines, comments, or header lines
    if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.toLowerCase().startsWith('pin') || trimmedLine.toLowerCase().startsWith('user')) {
      continue;
    }

    let parts = trimmedLine.split('\t');
    let userId = '';
    let dateTimeStr = '';
    let statusRaw = '0';

    if (parts.length >= 3) {
      // Tab-separated format
      userId = parts[0].trim();
      dateTimeStr = parts[1].trim();
      statusRaw = parts[2].trim();
    } else {
      // Try splitting by spaces
      parts = trimmedLine.split(/\s+/);
      if (parts.length >= 4) {
        // Space-separated: e.g. "101 2026-08-12 22:30:00 0 15 0"
        userId = parts[0].trim();
        // Combine date and time
        dateTimeStr = `${parts[1].trim()} ${parts[2].trim()}`;
        statusRaw = parts[3].trim();
      } else {
        // Invalid or unrecognized line format
        continue;
      }
    }

    if (!userId || !dateTimeStr) {
      continue;
    }

    try {
      // Normalize date separator if using slashes
      const normalizedDateStr = dateTimeStr.replace(/\//g, '-');
      
      // Parse local time string in ZK format "yyyy-MM-dd HH:mm:ss"
      const parsedLocal = parse(normalizedDateStr, 'yyyy-MM-dd HH:mm:ss', new Date());
      
      if (isNaN(parsedLocal.getTime())) {
        // Fallback: try parsing with ISO format
        const parsedISO = new Date(normalizedDateStr);
        if (isNaN(parsedISO.getTime())) {
          continue;
        }
      }

      // Convert local date time to UTC based on the device timezone
      const utcDate = fromZonedTime(parsedLocal, deviceTimezone);
      const timestamp = utcDate.toISOString();
      const status = mapZKStatus(statusRaw);

      records.push({
        userId,
        timestamp,
        status
      });
    } catch (err) {
      // Skip invalid date lines
      continue;
    }
  }

  return records;
}
