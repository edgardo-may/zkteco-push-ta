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
      return trimmed || 'check_in';
  }
}

/**
 * Maps ZKTeco VerifyMethod code (parts[3] in ATTLOG) to a normalized method.
 * Common ZK codes:
 * 1: Fingerprint (Huella)
 * 2: PIN / Password (Teclado)
 * 3, 10: RFID / Proximity Card (Tarjeta)
 * 4, 15, 25: Face / Visible Light Face (Rostro)
 * 200+: Combined / Multi-factor verification
 */
export function mapZKVerifyMethod(verifyCode: number): { verifyType: number; metodo: string } {
  switch (verifyCode) {
    case 15: // SpeedFace Visible Light Facial Recognition
    case 25: // Face IR / Palm + Face
    case 4:  // Face tradicional ZKFace
      return { verifyType: verifyCode, metodo: 'rostro' };

    case 1:  // Huella dactilar
      return { verifyType: 1, metodo: 'huella' };

    case 2:  // Contraseña / Teclado
      return { verifyType: 2, metodo: 'pin' };

    case 3:  // Tarjeta RFID
    case 10:
      return { verifyType: 3, metodo: 'tarjeta' };

    default:
      // Si es un código superior a 3 suele ser multi-factor o rostro extendido
      if (verifyCode > 3) {
        return { verifyType: verifyCode, metodo: 'rostro' };
      }
      return { verifyType: verifyCode || 1, metodo: 'huella' };
  }
}

/**
 * Parses ZKTeco ADMS upload log text body.
 * Typical format for table=ATTLOG:
 * Each line is:
 * PIN\tTIMESTAMP\tSTATUS\tVERIFYMETHOD\tWORKCODE\tRESERVED
 * Example:
 * 1\t2026-09-03 14:32:26\t255\t15\t0\t0\t0\t255\t0\t0\t
 */
export function parseAttendanceLogs(bodyText: string, deviceTimezone: string = 'America/Cancun'): ParsedAttendanceRecord[] {
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
    let verifyCodeRaw = 1;

    if (parts.length >= 3) {
      // Tab-separated format
      userId = parts[0].trim();
      dateTimeStr = parts[1].trim();
      statusRaw = parts[2].trim();
      
      // Extraer columna 4 (VerifyMethod)
      if (parts.length >= 4 && parts[3].trim()) {
        const parsedCode = parseInt(parts[3].trim(), 10);
        if (!isNaN(parsedCode)) {
          verifyCodeRaw = parsedCode;
        }
      }
    } else {
      // Try splitting by spaces: "1 2026-09-03 14:32:26 255 15 0"
      parts = trimmedLine.split(/\s+/);
      if (parts.length >= 4) {
        userId = parts[0].trim();
        dateTimeStr = `${parts[1].trim()} ${parts[2].trim()}`;
        statusRaw = parts[3].trim();

        if (parts.length >= 5 && parts[4].trim()) {
          const parsedCode = parseInt(parts[4].trim(), 10);
          if (!isNaN(parsedCode)) {
            verifyCodeRaw = parsedCode;
          }
        }
      } else {
        continue;
      }
    }

    if (!userId || !dateTimeStr) {
      continue;
    }

    try {
      const normalizedDateStr = dateTimeStr.replace(/\//g, '-');
      const parsedLocal = parse(normalizedDateStr, 'yyyy-MM-dd HH:mm:ss', new Date());

      if (isNaN(parsedLocal.getTime())) {
        const parsedISO = new Date(normalizedDateStr);
        if (isNaN(parsedISO.getTime())) {
          continue;
        }
      }

      const utcDate = fromZonedTime(parsedLocal, deviceTimezone);
      const timestamp = utcDate.toISOString();
      const status = mapZKStatus(statusRaw);
      const { verifyType, metodo } = mapZKVerifyMethod(verifyCodeRaw);

      records.push({
        userId,
        timestamp,
        status,
        verifyType,
        metodo
      });
    } catch (err) {
      continue;
    }
  }

  return records;
}
