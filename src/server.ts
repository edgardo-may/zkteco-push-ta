import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { supabase } from './supabase.js';
import { logger } from './logger.js';
import { parseAttendanceLogs } from './parser.js';
import { Device } from './types.js';
import 'dotenv/config';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const ZK_PUSH_SECRET = process.env.ZK_PUSH_SECRET || '';

// Middleware to parse raw text bodies (since ZK devices upload plain text payloads)
app.use(express.text({ type: '*/*', limit: '10mb' }));

// ── RATE LIMITING ────────────────────────────────────────────────────────────
const admsRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const rawSn = (req.query.SN || req.query.sn) as string;
    const sn = rawSn ? String(rawSn).trim().toUpperCase() : '';
    if (sn) {
      return `${sn}_${req.path}`;
    }
    return ipKeyGenerator(req.ip || 'unknown');
  },
  handler: (req, res) => {
    logger.warn('RATE LIMIT', 'ADMS Rate limit exceeded', { ip: req.ip, sn: req.query.SN || req.query.sn });
    res.status(429).send('TOO MANY REQUESTS');
  }
});

// ── HEALTH CHECK ENDPOINTS ───────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    service: 'zkteco-ta-push-connector',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/health/supabase', async (req, res) => {
  try {
    const { count, error } = await supabase.from('devices').select('*', { count: 'exact', head: true });
    if (error) throw error;
    res.status(200).json({
      status: 'OK',
      database: 'connected',
      device_count: count ?? 0
    });
  } catch (err: any) {
    logger.error('SERVER ERROR', 'Supabase health check failed', err);
    res.status(500).json({
      status: 'ERROR',
      database: 'disconnected',
      error: err.message
    });
  }
});

// ── DEVICE AUTHORIZATION MIDDLEWARE ──────────────────────────────────────────
const authorizeDevice = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  const rawSn = String((req.query.SN || req.query.sn) ?? '')
    .trim()
    .toUpperCase();

  if (!rawSn || rawSn.length > 50) {
    if (req.path === '/health' || req.path === '/health/supabase') {
      return next();
    }

    logger.warn(
      'DEVICE ERROR',
      'Request missing or invalid device Serial Number (SN)',
      { path: req.path, rawSn }
    );

    return res.status(400).send('INVALID SERIAL');
  }

  const sn = rawSn;

  try {
    const { data: device, error: devErr } = await supabase
      .from('devices')
      .select('*')
      .eq('serial_number', sn)
      .maybeSingle();

    if (devErr) {
      logger.error('DEVICE ERROR', `Error looking up ZKTeco device SN: ${sn}`, devErr);
      return res.status(500).send('INTERNAL SERVER ERROR');
    }

    if (!device) {
      logger.warn('DEVICE UNKNOWN', `Unauthorized or unregistered ZKTeco device SN: ${sn}`);
      return res.status(401).send('UNAUTHORIZED: Device not registered');
    }

    if (!device.is_active) {
      logger.warn('DEVICE ERROR', `Device SN: ${sn} is disabled in 'devices'`, { deviceId: device.id });
      return res.status(403).send('FORBIDDEN: Device is inactive');
    }

    const clienteId = device.cliente_id;

    if (!clienteId) {
      logger.warn('DEVICE UNKNOWN', `Device SN: ${sn} has no cliente_id in 'devices'`, { deviceId: device.id });
      return res.status(401).send('UNAUTHORIZED: No tenant mapping found');
    }

    const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ip = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : rawIp[0];
    const lastActivity = new Date().toISOString();

    const updatePayload: Partial<Device> = { last_activity: lastActivity };
    if (ip && ip !== device.ip_address) {
      updatePayload.ip_address = ip;
    }

    supabase
      .from('devices')
      .update(updatePayload)
      .eq('id', device.id)
      .then(({ error }) => {
        if (error) {
          logger.error('DEVICE ERROR', `Failed to update activity status for device SN: ${sn}`, error);
        }
      });

    res.locals.device = device as Device;
    res.locals.clienteId = clienteId;
    res.locals.clientIp = ip;

    next();
  } catch (err: any) {
    logger.error('SERVER ERROR', `Device authorization exception for SN: ${sn}`, err);
    return res.status(500).send('INTERNAL SERVER ERROR');
  }
};

app.use(['/iclock*', '/cdata*', '/getrequest*', '/devicecmd*'], admsRateLimiter, authorizeDevice);

// ── ZK ADMS PROTOCOL ENDPOINTS ───────────────────────────────────────────────

function getTimezoneOffsetHours(tz?: string | null): number {
  if (!tz) return -5;
  try {
    const d = new Date();
    const str = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).format(d);
    const match = str.match(/GMT([+-]?\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
  } catch {
    // fallback
  }
  return -5;
}

// 1. Handshake & Registry Query
app.get(['/iclock/cdata', '/cdata'], (req, res) => {
  const device = res.locals.device as Device;
  const ip = res.locals.clientIp;
  const tzOffset = getTimezoneOffsetHours(device.timezone);

  logger.info('DEVICE CONNECT', `Device SN: ${device.serial_number} initialized connection`, {
    ip,
    name: device.name,
    timezone: device.timezone,
    tzOffset
  });

  const responseText = [
    `GET OPTION FROM: ${device.serial_number}`,
    'RegistryCode=',
    'ServerVersion=3.1.1',
    'ServerName=ADMS',
    'PushVersion=3.2.0',
    'MaxCommSize=102400',
    'Realtime=1',
    'Encrypt=0',
    `Delay=${process.env.HEARTBEAT_INTERVAL || '30'}`,
    `ErrorDelay=${process.env.HEARTBEAT_INTERVAL || '30'}`,
    `TimeZone=${tzOffset}`
  ].join('\n') + '\n';

  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send(responseText);
});

// ── HELPER: PROCESAMIENTO Y RECEPCIÓN DE TEMPLATES BIOMÉTRICOS ────────
async function handleBiometricTemplateUpload(
  device: any,
  dispositivo: any,
  table: string,
  pinStr: string,
  fidStr: string,
  sizeStr: string,
  templateVal: string
) {
  try {
    const fidNum = parseInt(fidStr, 10);
    if (isNaN(fidNum) || fidNum < 0 || fidNum > 9) {
      logger.warn('DEVICE WARNING', `Invalid FID received for SN: ${device?.serial_number}, PIN: ${pinStr}, FID: ${fidStr}`);
      return;
    }

    const clienteId = dispositivo?.cliente_id || device?.cliente_id;
    if (!clienteId) {
      logger.warn('DEVICE WARNING', `No cliente_id found for device SN: ${device?.serial_number}`);
      return;
    }

    const { data: ass, error: assignmentError } = await supabase
      .from('device_employee_assignments')
      .select('employee_id')
      .eq('device_id', device.id)
      .eq('cliente_id', clienteId)
      .eq('biometric_user_id', pinStr)
      .eq('activo', true)
      .maybeSingle();

    if (assignmentError) {
      logger.error('SERVER ERROR', `Failed to resolve biometric assignment for SN: ${device?.serial_number}, PIN: ${pinStr}`, assignmentError);
      return;
    }

    if (!ass?.employee_id) {
      logger.warn('DEVICE WARNING', `No active assignment found for biometric upload: SN=${device?.serial_number} PIN=${pinStr}`);
      return;
    }

    const { data: employee, error: employeeError } = await supabase
      .from('empleados')
      .select('id')
      .eq('id', ass.employee_id)
      .eq('cliente_id', clienteId)
      .maybeSingle();

    if (employeeError) {
      logger.error('SERVER ERROR', `Failed to validate assigned employee for SN: ${device?.serial_number}, PIN: ${pinStr}`, employeeError);
      return;
    }

    if (!employee) {
      logger.warn('DEVICE WARNING', `Assigned employee is not valid for tenant biometric upload: SN=${device?.serial_number} PIN=${pinStr}`);
      return;
    }

    const employeeId = employee.id;

    const FINGER_MAP: Record<number, string> = {
      0: 'left_thumb',
      1: 'left_index',
      2: 'left_middle',
      3: 'left_ring',
      4: 'left_pinky',
      5: 'right_thumb',
      6: 'right_index',
      7: 'right_middle',
      8: 'right_ring',
      9: 'right_pinky',
    };

    const fingerKey = FINGER_MAP[fidNum] || `finger_${fidNum}`;

    const { error: upsertErr } = await supabase
      .from('biometric_templates')
      .upsert({
        cliente_id: clienteId,
        empleado_id: employeeId,
        device_id: device.id,
        tipo: 'huella',
        indice: fidNum,
        finger_key: fingerKey,
        template_data: templateVal,
        actualizado_at: new Date().toISOString()
      }, {
        onConflict: 'empleado_id,device_id,tipo,indice'
      });

    if (upsertErr) {
      logger.error('SERVER ERROR', `Failed to upsert biometric template for employee ${employeeId}, FID: ${fidNum}`, upsertErr);
    } else {
      logger.info('DEVICE IDENTIFIED', `Biometric template saved: SN=${device?.serial_number} PIN=${pinStr} FID=${fidNum} fingerKey=${fingerKey}`);
    }
  } catch (err: any) {
    logger.error('SERVER ERROR', `Exception in handleBiometricTemplateUpload for SN: ${device?.serial_number}`, err);
  }
}

// ── HELPER: DEBUG Y RECEPCIÓN DE CDATA (FINGERTMP / BIODATA) ───────────
async function handleUnknownCdataDebug(req: any, res: any) {
  const device = res.locals.device;
  const dispositivo = res.locals.dispositivo;
  const table = req.query.table as string;
  const rawBody = req.body || '';

  const lines = rawBody.split(/\r?\n/).filter((l: string) => l.trim().length > 0);

  for (const line of lines) {
    const pairs = line.split('\t');
    let pinStr = 'none';
    let fidStr = 'none';
    let sizeStr = 'none';
    let templateVal = '';
    const keys: string[] = [];

    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const key = pair.substring(0, eqIdx);
        const val = pair.substring(eqIdx + 1);
        keys.push(key);

        const keyUpper = key.trim().toUpperCase();
        if (keyUpper === 'PIN' || keyUpper === 'USERID' || keyUpper === 'FP PIN' || keyUpper === 'USER PIN') pinStr = val.trim();
        if (keyUpper === 'FID') fidStr = val;
        if (keyUpper === 'SIZE') sizeStr = val;
        if (keyUpper === 'TMP' || keyUpper === 'TEMPLATE' || keyUpper === 'BIODATA') templateVal = val;
      } else {
        keys.push('RAW_TOKEN');
      }
    }

    if (pinStr !== 'none' && fidStr !== 'none' && templateVal.length > 0) {
      logger.info('DIAGNOSTICS', `BIOMETRIC UPLOAD SN=${device?.serial_number} table=${table} PIN=${pinStr} FID=${fidStr} Size=${sizeStr} templateLength=${templateVal.length}`);
      await handleBiometricTemplateUpload(device, dispositivo, table, pinStr, fidStr, sizeStr, templateVal);
    }
  }

  return res.status(200).send('OK');
}

// 2. Data Upload - Logs & Templates (POST /iclock/cdata or POST /cdata)
app.post(['/iclock/cdata', '/cdata'], async (req, res) => {
  const device = res.locals.device as Device;
  const table = req.query.table as string;
  const rawBody = req.body || '';

  // ── DISPATCHER DE TABLAS ADMS ──
  if (table !== 'ATTLOG') {
    return await handleUnknownCdataDebug(req, res);
  }

  // Debug payload crudo de asistencia
  logger.info('DIAGNOSTICS', `[RAW ATTLOG] Device SN: ${device.serial_number} sent: ${JSON.stringify(rawBody)}`);
  logger.info('ATTENDANCE RECEIVED', `Device SN: ${device.serial_number} sent raw attendance logs`, { bytes: rawBody.length });

  try {
    const parsedRecords = parseAttendanceLogs(rawBody, device.timezone);
    if (parsedRecords.length === 0) {
      return res.status(200).send('OK');
    }

    const clienteId = res.locals.clienteId as string;

    const { data: assignments, error: assignErr } = await supabase
      .from('device_employee_assignments')
      .select(`
        biometric_user_id,
        empleados!inner (
          id,
          clave_empleado,
          activo
        )
      `)
      .eq('device_id', device.id)
      .eq('activo', true)
      .eq('empleados.activo', true);

    if (assignErr) {
      throw assignErr;
    }

    const validEmployeeMap = new Map<string, { id: string; clave: string }>();
    if (assignments) {
      for (const ass of assignments) {
        const emp = ass.empleados as any;
        if (ass.biometric_user_id && emp && emp.clave_empleado) {
          validEmployeeMap.set(ass.biometric_user_id.trim(), {
            id: emp.id,
            clave: emp.clave_empleado.trim()
          });
        }
      }
    }

    const timestamps = parsedRecords.map(r => r.timestamp);
    const minTimestamp = timestamps.reduce((min, t) => t < min ? t : min, timestamps[0]);
    const maxTimestamp = timestamps.reduce((max, t) => t > max ? t : max, timestamps[0]);

    const { data: existingLogs, error: queryErr } = await supabase
      .from('attendance_logs')
      .select('user_id, timestamp')
      .eq('device_serial', device.serial_number)
      .gte('timestamp', minTimestamp)
      .lte('timestamp', maxTimestamp);

    if (queryErr) {
      throw queryErr;
    }

    const existingSet = new Set<string>();
    if (existingLogs) {
      for (const log of existingLogs) {
        existingSet.add(`${log.user_id}_${log.timestamp}`);
      }
    }

    const logsToInsert = [];
    let duplicateCount = 0;
    let rejectedCount = 0;

    for (const record of parsedRecords) {
      const trimmedUserId = record.userId.trim();

      const empInfo = validEmployeeMap.get(trimmedUserId);
      if (!empInfo) {
        rejectedCount++;
        logger.warn('DEVICE ERROR', `Log rejected: Employee ZK-PIN "${trimmedUserId}" not found or inactive for tenant ${clienteId}`);
        continue;
      }

      const resolvedClave = empInfo.clave;
      const compositeKey = `${resolvedClave}_${record.timestamp}`;

      if (existingSet.has(compositeKey)) {
        duplicateCount++;
      } else {
        logsToInsert.push({
          device_serial: device.serial_number,
          user_id: resolvedClave,
          timestamp: record.timestamp,
          status: record.status,
          verify_type: record.verifyType ?? 1,
          metodo: record.metodo ?? 'huella'
        });
        existingSet.add(compositeKey);
      }
    }

    if (rejectedCount > 0) {
      logger.warn('DEVICE ERROR', `Rejected ${rejectedCount} log entries due to unregistered or inactive employees for device SN: ${device.serial_number}`);
    }

    if (duplicateCount > 0) {
      logger.info('ATTENDANCE DUPLICATE', `Skipped ${duplicateCount} duplicate logs for device SN: ${device.serial_number}`);
    }

    if (logsToInsert.length > 0) {
      const { error: insertErr } = await supabase
        .from('attendance_logs')
        .upsert(logsToInsert, {
          onConflict: 'device_serial, user_id, timestamp',
          ignoreDuplicates: true
        });

      if (insertErr) {
        throw insertErr;
      }

      for (const log of logsToInsert) {
        logger.info('ATTENDANCE SAVED', `Saved log: user ${log.user_id} at ${log.timestamp} status: ${log.status} [method: ${log.metodo}] for device: ${device.serial_number}`);
      }
    }

    res.status(200).send('OK');
  } catch (err: any) {
    logger.error('SERVER ERROR', `Failed to process attendance upload for device SN: ${device.serial_number}`, err);
    res.status(500).send('ERROR');
  }
});

function commandUserId(commandString: string): string | null {
  return commandString.match(/\bPin=([^\t\r\n ]+)/i)?.[1].trim() || null;
}

function isUserCommand(commandString: string): boolean {
  return /^DATA (?:UPDATE |DELETE )?USER/i.test(commandString);
}

function isDeleteUserInfoCommand(commandString: string): boolean {
  return /^\s*DATA\s+DELETE\s+USERINFO\b/i.test(commandString);
}

// DELETE USERINFO is hazardous on this firmware. Do not normalize a malformed
// payload: only this full, uppercase, numeric form may reach the terminal.
function isSafeDeleteUserInfoCommand(commandString: string): boolean {
  return /^DATA DELETE USERINFO PIN=[0-9]+$/.test(commandString);
}

function commandUserName(commandString: string): string | null {
  return commandString.match(/\bName=([^\t\r\n]+)/i)?.[1].trim() || null;
}

function canonicalUserInfoWireCommand(commandString: string): string | null {
  if (!/^DATA UPDATE USERINFO\b/i.test(commandString)) {
    return commandString;
  }

  const pin = commandUserId(commandString);
  const name = commandUserName(commandString);
  if (!pin || !name) {
    return null;
  }

  return `DATA UPDATE USERINFO PIN=${pin}\tName=${name}\tPrivilege=0`;
}

function commandWireId(commandId: string): string {
  const compactUuid = commandId.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(compactUuid)) {
    return compactUuid.substring(0, 8);
  }

  const firstUuidWord = Number.parseInt(compactUuid.substring(0, 8), 16);
  return String((firstUuidWord % 90000000) + 10000000);
}

function commandMatchesAckId(command: { id: string }, receivedId: string): boolean {
  const received = receivedId.trim().toLowerCase();
  const commandUuid = command.id.toLowerCase();
  const compactUuid = commandUuid.replace(/-/g, '');

  if (received === commandUuid || received === compactUuid || received === commandWireId(command.id).toLowerCase()) {
    return true;
  }

  return received.length >= 4 && compactUuid.startsWith(received);
}

function parseReturnCode(returnValue: string | null): number | null {
  if (returnValue === null || !/^-?\d+$/.test(returnValue.trim())) {
    return null;
  }

  return Number.parseInt(returnValue, 10);
}

// 3. Command Queue Polling
app.get(['/iclock/getrequest', '/getrequest'], async (req, res) => {
  const device = res.locals.device as Device;
  const clienteId = res.locals.clienteId as string;

  try {
    const { data: commands, error } = await supabase
      .from('device_commands')
      .select('*')
      .eq('device_serial', device.serial_number)
      .eq('is_executed', false)
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) throw error;

    if (!commands || commands.length === 0) {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send('OK');
    }

    const nextCommand = commands[0];

    if (isDeleteUserInfoCommand(nextCommand.command_string) && !isSafeDeleteUserInfoCommand(nextCommand.command_string)) {
      logger.error('COMMAND BLOCKED', 'Unsafe DELETE USERINFO command', {
        sn: device.serial_number,
        commandUuid: nextCommand.id
      });

      // device_commands has no error column in production. Consume the unsafe
      // row so polling cannot retry it forever; do not infer a PIN from it.
      const { error: blockErr } = await supabase
        .from('device_commands')
        .update({
          is_executed: true,
          updated_at: new Date().toISOString()
        })
        .eq('id', nextCommand.id)
        .eq('device_serial', device.serial_number);

      if (blockErr) throw blockErr;

      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send('OK');
    }

    const wireCommandString = canonicalUserInfoWireCommand(nextCommand.command_string);

    if (!wireCommandString) {
      logger.error('DEVICE ERROR', 'USERINFO command missing required PIN or Name; command was not dispatched', {
        sn: device.serial_number,
        commandUuid: nextCommand.id
      });
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send('OK');
    }

    const biometricUserId = commandUserId(nextCommand.command_string);
    if (biometricUserId && isUserCommand(nextCommand.command_string)) {
      const { error: syncErr } = await supabase
        .from('device_employee_assignments')
        .update({
          sync_status: 'SYNCING',
          last_attempt_at: new Date().toISOString()
        })
        .eq('device_id', device.id)
        .eq('cliente_id', clienteId)
        .eq('biometric_user_id', biometricUserId);

      if (syncErr) {
        logger.error('DEVICE ERROR', `Failed to update status to SYNCING for device ID: ${device.id}, user: ${biometricUserId}`, syncErr);
      }
    }

    const wireCommandId = commandWireId(nextCommand.id);
    const responseText = `C:${wireCommandId}:${wireCommandString}\n`;

    logger.info('COMMAND SENT', `ADMS command dispatched: SN=${device.serial_number} wireCommandId=${wireCommandId} commandUuid=${nextCommand.id}`);

    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(responseText);
  } catch (err: any) {
    logger.error('SERVER ERROR', `Failed to poll commands for device SN: ${device.serial_number}`, err);
    res.status(500).send('ERROR');
  }
});

// 4. Command Execution Feedback ACK
app.post(['/iclock/devicecmd', '/devicecmd'], async (req, res) => {
  const device = res.locals.device as Device;
  const clienteId = res.locals.clienteId as string;
  const rawBody = (req.body || '').trim();

  if (!rawBody) {
    return res.status(200).send('OK');
  }

  try {
    const params = new URLSearchParams(rawBody);
    const commandId = params.get('ID') || params.get('id');
    const returnVal = params.get('Return') || params.get('return');
    const returnCode = parseReturnCode(returnVal);

    if (!commandId) {
      logger.warn('DEVICE ERROR', `Command response missing ID: SN=${device.serial_number} Return=${returnVal ?? 'missing'}`);
      return res.status(200).send('OK');
    }

    let command = null;

    if (commandId.length === 36) {
      const { data, error: exactCommandErr } = await supabase
        .from('device_commands')
        .select('*')
        .eq('id', commandId)
        .eq('device_serial', device.serial_number)
        .eq('is_executed', false)
        .maybeSingle();
      if (exactCommandErr) {
        throw exactCommandErr;
      }
      command = data;
    }

    if (!command) {
      const { data: pendingCommands, error: pendingCommandsErr } = await supabase
        .from('device_commands')
        .select('*')
        .eq('device_serial', device.serial_number)
        .eq('is_executed', false)
        .order('created_at', { ascending: false })
        .limit(50);

      if (pendingCommandsErr) {
        throw pendingCommandsErr;
      }

      if (pendingCommands && pendingCommands.length > 0) {
        const matches = pendingCommands.filter(candidate => commandMatchesAckId(candidate, commandId));
        if (matches.length === 1) {
          command = matches[0];
        } else if (matches.length > 1) {
          logger.error('DEVICE ERROR', 'Ambiguous ADMS ACK command ID; no command was updated', {
            sn: device.serial_number,
            receivedId: commandId,
            candidateUuids: matches.map(candidate => candidate.id)
          });
          return res.status(200).send('OK');
        }
      }
    }

    if (!command) {
      logger.warn('DEVICE WARNING', `Device SN: ${device.serial_number} reported ACK for unknown or unauthorized command ID: ${commandId}`);
      return res.status(200).send('OK');
    }

    const resolvedId = command.id;
    const biometricUserId = commandUserId(command.command_string);

    if (biometricUserId && isUserCommand(command.command_string)) {
      if (returnCode === 0) {
        await supabase
          .from('device_employee_assignments')
          .update({
            sync_status: 'SYNCED',
            last_synced_at: new Date().toISOString(),
            last_error: null,
            retry_count: 0
          })
          .eq('device_id', device.id)
          .eq('cliente_id', clienteId)
          .eq('biometric_user_id', biometricUserId);
      } else {
        const { data: currentAssignment } = await supabase
          .from('device_employee_assignments')
          .select('retry_count')
          .eq('device_id', device.id)
          .eq('cliente_id', clienteId)
          .eq('biometric_user_id', biometricUserId)
          .maybeSingle();

        const newRetryCount = (currentAssignment?.retry_count || 0) + 1;
        await supabase
          .from('device_employee_assignments')
          .update({
            sync_status: 'ERROR',
            last_error: returnCode === null ? 'Terminal ACK missing Return value' : `Terminal Return=${returnCode}`,
            retry_count: newRetryCount
          })
          .eq('device_id', device.id)
          .eq('cliente_id', clienteId)
          .eq('biometric_user_id', biometricUserId);
      }
    }

    await supabase
      .from('device_commands')
      .update({
        is_executed: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', resolvedId)
      .eq('device_serial', device.serial_number);

    res.status(200).send('OK');
  } catch (err: any) {
    logger.error('SERVER ERROR', `Failed to process command ACK for device SN: ${device.serial_number}`, err);
    res.status(500).send('ERROR');
  }
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    logger.info('SERVER INIT', `ZKTeco TA Push Connector running on port ${PORT}`);
    logger.info('SERVER INIT', `Supabase target URL: ${process.env.SUPABASE_URL}`);
  });
}

export { app, canonicalUserInfoWireCommand, isSafeDeleteUserInfoCommand };
