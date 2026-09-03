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
// Flexible limits for ADMS devices to prevent abuse without breaking polling
const admsRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute per device
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
  // ADMS protocol passes SN in query parameter
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

  logger.info('DIAGNOSTICS', `ADMS SN raw: "${rawSn}"`);
  logger.info('DIAGNOSTICS', `ADMS SN normalized: "${sn}"`);

  try {
    // ─────────────────────────────────────────────────────────────────────
    // 1. Buscar el dispositivo ZKTeco exclusivamente en devices
    // ─────────────────────────────────────────────────────────────────────
    const { data: device, error: devErr } = await supabase
      .from('devices')
      .select('*')
      .eq('serial_number', sn)
      .maybeSingle();

    logger.info(
      'DIAGNOSTICS',
      `Device lookup: ${device ? 'FOUND' : 'NOT_FOUND'}`
    );

    if (devErr) {
      logger.error(
        'DEVICE ERROR',
        `Error looking up ZKTeco device SN: ${sn}`,
        devErr
      );

      return res.status(500).send('INTERNAL SERVER ERROR');
    }

    if (!device) {
      logger.warn(
        'DEVICE UNKNOWN',
        `Unauthorized or unregistered ZKTeco device SN: ${sn}`
      );

      return res.status(401).send(
        'UNAUTHORIZED: Device not registered'
      );
    }

    logger.info(
      'DIAGNOSTICS',
      `Device active: ${device.is_active ? 'TRUE' : 'FALSE'}`
    );

    // ─────────────────────────────────────────────────────────────────────
    // 2. Validar que el dispositivo esté activo
    // ─────────────────────────────────────────────────────────────────────
    if (!device.is_active) {
      logger.warn(
        'DEVICE ERROR',
        `Device SN: ${sn} is disabled in 'devices'`,
        { deviceId: device.id }
      );

      return res.status(403).send(
        'FORBIDDEN: Device is inactive'
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // 3. El tenant de ZKTeco sale directamente de devices.cliente_id
    //    NO consultar dispositivos (Hikvision)
    // ─────────────────────────────────────────────────────────────────────
    const clienteId = device.cliente_id;

    logger.info(
      'DIAGNOSTICS',
      `Tenant binding: ${clienteId ? 'FOUND' : 'NOT_FOUND'}`
    );

    if (!clienteId) {
      logger.warn(
        'DEVICE UNKNOWN',
        `Device SN: ${sn} has no cliente_id in 'devices'`,
        { deviceId: device.id }
      );

      return res.status(401).send(
        'UNAUTHORIZED: No tenant mapping found'
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // 4. Actualizar actividad e IP en segundo plano
    // ─────────────────────────────────────────────────────────────────────
    const rawIp =
      req.headers['x-forwarded-for'] ||
      req.socket.remoteAddress ||
      '';

    const ip =
      typeof rawIp === 'string'
        ? rawIp.split(',')[0].trim()
        : rawIp[0];

    const lastActivity = new Date().toISOString();

    const updatePayload: Partial<Device> = {
      last_activity: lastActivity
    };

    if (ip && ip !== device.ip_address) {
      updatePayload.ip_address = ip;
    }

    supabase
      .from('devices')
      .update(updatePayload)
      .eq('id', device.id)
      .then(({ error }) => {
        if (error) {
          logger.error(
            'DEVICE ERROR',
            `Failed to update activity status for device SN: ${sn}`,
            error
          );
        }
      });

    // ─────────────────────────────────────────────────────────────────────
    // 5. Guardar información para los handlers
    // ─────────────────────────────────────────────────────────────────────
    res.locals.device = device as Device;

    // IMPORTANTE:
    // Ya no usamos Dispositivo de Hikvision para ZKTeco.
    res.locals.clienteId = clienteId;

    res.locals.clientIp = ip;

    logger.info(
      'DEVICE IDENTIFIED',
      `Device SN: ${device.serial_number} authorized and identified for tenant: ${clienteId} from IP: ${ip}`
    );

    next();

  } catch (err: any) {
    logger.error(
      'SERVER ERROR',
      `Device authorization exception for SN: ${sn}`,
      err
    );

    return res.status(500).send(
      'INTERNAL SERVER ERROR'
    );
  }
};

// Apply auth middleware to all /iclock or base endpoints
app.use(['/iclock*', '/cdata*', '/getrequest*', '/devicecmd*'], admsRateLimiter, authorizeDevice);

// ── ZK ADMS PROTOCOL ENDPOINTS ───────────────────────────────────────────────

// 1. Handshake & Registry Query (GET /iclock/cdata or GET /cdata)
app.get(['/iclock/cdata', '/cdata'], (req, res) => {
  const device = res.locals.device as Device;
  const ip = res.locals.clientIp;

  logger.info('DEVICE CONNECT', `Device SN: ${device.serial_number} initialized connection`, {
    ip,
    name: device.name,
    timezone: device.timezone
  });

  // ZKTeco expects registry config options
  const responseText = [
    `GET OPTION FROM: ${device.serial_number}`,
    'RegistryCode=',
    'ServerVersion=3.1.1',
    'ServerName=ADMS',
    'PushVersion=3.2.0',
    'MaxCommSize=102400',
    'Realtime=1',
    'Encrypt=0', // plain text logs
    `Delay=${process.env.HEARTBEAT_INTERVAL || '30'}`,
    `ErrorDelay=${process.env.HEARTBEAT_INTERVAL || '30'}`
  ].join('\n') + '\n';

  res.setHeader('Content-Type', 'text/plain');
  res.status(200).send(responseText);
});

// ── HELPER: DEBUG DE CDATA DESCONOCIDA (FASE 2.1) ───────────────────────
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

    // 1. Buscar assignment activo
    const { data: ass } = await supabase
      .from('device_employee_assignments')
      .select('employee_id, cliente_id, biometric_user_id')
      .eq('device_id', device.id)
      .eq('biometric_user_id', pinStr)
      .maybeSingle();

    let employeeId = ass?.employee_id;

    // 2. Si no hay assignment previo (ej. enrolado directo en checador), buscar por device_userid
    if (!employeeId) {
      const { data: emp } = await supabase
        .from('empleados')
        .select('id, cliente_id')
        .eq('cliente_id', clienteId)
        .eq('device_userid', pinStr)
        .maybeSingle();

      if (emp) {
        employeeId = emp.id;
        // Crear assignment automático para consolidar la relación
        await supabase.from('device_employee_assignments').upsert({
          cliente_id: clienteId,
          device_id: device.id,
          employee_id: emp.id,
          biometric_user_id: pinStr,
          activo: true,
          sync_status: 'SYNCED'
        }, { onConflict: 'device_id,biometric_user_id' });
      }
    }

    if (!employeeId) {
      logger.warn('DEVICE WARNING', `No employee found for device SN: ${device?.serial_number}, PIN: ${pinStr}`);
      return;
    }

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

    // 3. Upsert en biometric_templates
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
        onConflict: 'empleado_id,tipo,indice'
      });

    if (upsertErr) {
      logger.error('SERVER ERROR', `Failed to upsert biometric template for employee ${employeeId}, FID: ${fidNum}`, upsertErr);
    } else {
      logger.info('DEVICE IDENTIFIED', `Biometric template saved: SN=${device?.serial_number} table=${table} PIN=${pinStr} FID=${fidNum} fingerKey=${fingerKey} size=${sizeStr} templateLength=${templateVal.length}`);
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

        const keyUpper = key.toUpperCase();
        if (keyUpper === 'PIN' || keyUpper === 'USERID') pinStr = val;
        if (keyUpper === 'FID') fidStr = val;
        if (keyUpper === 'SIZE') sizeStr = val;
        if (keyUpper === 'TMP' || keyUpper === 'TEMPLATE' || keyUpper === 'BIODATA') templateVal = val;
      } else {
        keys.push('RAW_TOKEN');
      }
    }

    if (process.env.BIOMETRIC_DEBUG === 'true') {
      const method = req.method;
      const pathname = req.path;
      const queryKeys = Object.keys(req.query).join(',');
      const contentType = req.headers['content-type'] || 'none';
      const contentLength = req.headers['content-length'] || rawBody.length;
      logger.info('DEVICE CONNECT', `SN=${device?.serial_number} method=${method} path=${pathname} queryKeys=[${queryKeys}] table=${table} contentType=${contentType} bodyLength=${contentLength} fields=[${keys.join(',')}] PIN=${pinStr} FID=${fidStr} Size=${sizeStr} templateLength=${templateVal.length}`);
    }

    // Si detectamos template de huella, guardarlo de forma persistente
    if (pinStr !== 'none' && fidStr !== 'none' && templateVal.length > 0) {
      await handleBiometricTemplateUpload(device, dispositivo, table, pinStr, fidStr, sizeStr, templateVal);
    }
  }

  if (process.env.BIOMETRIC_DEBUG !== 'true' && lines.length === 0) {
    logger.info('DEVICE CONNECT', `Device SN: ${device?.serial_number} uploaded table: ${table} (ignoring contents)`);
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

  logger.info('ATTENDANCE RECEIVED', `Device SN: ${device.serial_number} sent raw attendance logs`, { bytes: rawBody.length });

  try {
    const parsedRecords = parseAttendanceLogs(rawBody, device.timezone);
    if (parsedRecords.length === 0) {
      return res.status(200).send('OK');
    }

    const clienteId = res.locals.clienteId as string;

    // ── EMPLOYEE IDENTIFICATION ──────────────────────────────────────────────
    // Query active assignments for this device, linking only active employees
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

    // Build a lookup map of active assignments: mapping biometric_user_id -> id & clave_empleado
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

    // ── OPTIMIZED IDEMPOTENCY / DUPLICATE PREVENTION ──────────────────────────
    // Find min and max timestamps in the batch
    const timestamps = parsedRecords.map(r => r.timestamp);
    const minTimestamp = timestamps.reduce((min, t) => t < min ? t : min, timestamps[0]);
    const maxTimestamp = timestamps.reduce((max, t) => t > max ? t : max, timestamps[0]);

    // Query database for existing logs for this device in the batch timestamp range
    const { data: existingLogs, error: queryErr } = await supabase
      .from('attendance_logs')
      .select('user_id, timestamp')
      .eq('device_serial', device.serial_number)
      .gte('timestamp', minTimestamp)
      .lte('timestamp', maxTimestamp);

    if (queryErr) {
      throw queryErr;
    }

    // Build a lookup set of existing records: "user_id_timestamp"
    const existingSet = new Set<string>();
    if (existingLogs) {
      for (const log of existingLogs) {
        existingSet.add(`${log.user_id}_${log.timestamp}`);
      }
    }

    // Filter out invalid employees & duplicates, and format new logs
    const logsToInsert = [];
    let duplicateCount = 0;
    let rejectedCount = 0;

    for (const record of parsedRecords) {
      const trimmedUserId = record.userId.trim();

      // 1. Verify if employee is registered and active in the database
      const empInfo = validEmployeeMap.get(trimmedUserId);
      if (!empInfo) {
        rejectedCount++;
        logger.warn('DEVICE ERROR',`Log rejected: Employee ZK-PIN "${trimmedUserId}" not found or inactive for tenant ${clienteId}`);
        continue;
      }

      const resolvedClave = empInfo.clave;

      // 2. Verify duplicates (idempotency)
      const compositeKey = `${resolvedClave}_${record.timestamp}`;
      if (existingSet.has(compositeKey)) {
        duplicateCount++;
      } else {
        logsToInsert.push({
          device_serial: device.serial_number,
          user_id: resolvedClave,
          timestamp: record.timestamp,
          status: record.status
        });
        // Add to set to prevent duplicates *within* the same uploaded batch
        existingSet.add(compositeKey);
      }
    }

    if (rejectedCount > 0) {
      logger.warn('DEVICE ERROR', `Rejected ${rejectedCount} log entries due to unregistered or inactive employees for device SN: ${device.serial_number}`);
    }

    if (duplicateCount > 0) {
      logger.info('ATTENDANCE DUPLICATE', `Skipped ${duplicateCount} duplicate logs for device SN: ${device.serial_number}`);
    }

    // Batch insert new attendance logs
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
        logger.info('ATTENDANCE SAVED', `Saved log: user ${log.user_id} at ${log.timestamp} status: ${log.status} for device: ${device.serial_number}`);
      }
    }

    res.status(200).send('OK');
  } catch (err: any) {
    logger.error('SERVER ERROR', `Failed to process attendance upload for device SN: ${device.serial_number}`, err);
    res.status(500).send('ERROR');
  }
});

// 3. Command Queue Polling (GET /iclock/getrequest or GET /getrequest)
app.get(['/iclock/getrequest', '/getrequest'], async (req, res) => {
  const device = res.locals.device as Device;

  // Log heartbeat request
  logger.info('HEARTBEAT', `Heartbeat received from device SN: ${device.serial_number}`);

  try {
    // Query the oldest pending command for this device
    const { data: commands, error } = await supabase
      .from('device_commands')
      .select('*')
      .eq('device_serial', device.serial_number)
      .eq('is_executed', false)
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) throw error;

    if (!commands || commands.length === 0) {
      // No commands in queue, respond with OK/empty to signal no instructions
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send('OK');
    }

    const nextCommand = commands[0];

    // Update assignment status to SYNCING if it is a user update/delete command
    if (nextCommand.command_string.startsWith('DATA UPDATE USERINFO Pin=') || nextCommand.command_string.startsWith('DATA DELETE USERINFO Pin=')) {
      const match = nextCommand.command_string.match(/Pin=([^\t\n ]+)/);
      if (match) {
        const biometricUserId = match[1].trim();
        supabase.from('device_employee_assignments')
          .update({
            sync_status: 'SYNCING',
            last_attempt_at: new Date().toISOString()
          })
          .eq('device_id', device.id)
          .eq('biometric_user_id', biometricUserId)
          .then(({ error: syncErr }) => {
            if (syncErr) {
              logger.error('DEVICE ERROR', `Failed to update status to SYNCING for device ID: ${device.id}, user: ${biometricUserId}`, syncErr);
            }
          });
      }
    }

    // Format the command string in ZKTeco ADMS syntax: C:<command_id>:<command_string>
    const shortCmdId = nextCommand.id.replace(/-/g, '').substring(0, 8);
    const responseText = `C:${shortCmdId}:${nextCommand.command_string}\n`;

    logger.info('COMMAND SENT', `Sent command ${nextCommand.id} to device SN: ${device.serial_number}: ${nextCommand.command_string}`);

    res.setHeader('Content-Type', 'text/plain');
    res.status(200).send(responseText);
  } catch (err: any) {
    logger.error('SERVER ERROR', `Failed to poll commands for device SN: ${device.serial_number}`, err);
    res.status(500).send('ERROR');
  }
});

// 4. Command Execution Feedback ACK (POST /iclock/devicecmd or POST /devicecmd)
app.post(['/iclock/devicecmd', '/devicecmd'], async (req, res) => {
  const device = res.locals.device as Device;
  const rawBody = (req.body || '').trim();

  if (!rawBody) {
    return res.status(200).send('OK');
  }

  try {
    // Parse url-encoded structure: e.g. "ID=123e4567-e89b-12d3-a456-426614174000&Return=0"
    const params = new URLSearchParams(rawBody);
    const commandId = params.get('ID') || params.get('id');
    const returnVal = params.get('Return') || params.get('return');

    if (!commandId) {
      logger.warn('DEVICE ERROR', `Command response missing 'ID' field from device SN: ${device.serial_number}`, { body: rawBody });
      return res.status(200).send('OK');
    }

    const returnCode = returnVal ? parseInt(returnVal, 10) : -1;

// 1. Resolver el comando (compatible con ID corto o ID truncado)
    let command = null;

    // A. Intento de coincidencia exacta si es un UUID válido
    if (commandId.length === 36) {
      const { data } = await supabase
        .from('device_commands')
        .select('*')
        .eq('id', commandId)
        .eq('device_serial', device.serial_number)
        .maybeSingle();
      command = data;
    }

    // B. Si es corto o truncado, buscar el comando pendiente más reciente de este equipo
    if (!command) {
      const { data: pendingCommands } = await supabase
        .from('device_commands')
        .select('*')
        .eq('device_serial', device.serial_number)
        .eq('is_executed', false)
        .order('created_at', { ascending: false })
        .limit(10);

      if (pendingCommands && pendingCommands.length > 0) {
        // Encontrar el comando cuyo ID empiece con el ID recibido o que coincida con el shortId
        command = pendingCommands.find(c => {
          const cleanId = c.id.replace(/-/g, '');
          return c.id.startsWith(commandId) || cleanId.startsWith(commandId);
        });
      }
    }

    if (!command) {
      logger.warn('DEVICE WARNING', `Device SN: ${device.serial_number} reported ACK for unknown or unauthorized command ID: ${commandId}`);
      return res.status(200).send('OK');
    }

    const resolvedId = command.id;

    // 2. Marcar como ejecutado usando el UUID original resuelto
    const { error: cmdUpdateErr } = await supabase
      .from('device_commands')
      .update({
        is_executed: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', resolvedId);

    if (cmdUpdateErr) throw cmdUpdateErr;

    // 3. If command matches user sync format, update sync status in assignments
    if (command && (command.command_string.startsWith('DATA UPDATE USERINFO Pin=') || command.command_string.startsWith('DATA DELETE USERINFO Pin='))) {
      const match = command.command_string.match(/Pin=([^\t\n ]+)/);
      if (match) {
        const biometricUserId = match[1].trim();
        
        if (returnCode === 0) {
          // Success
          await supabase
            .from('device_employee_assignments')
            .update({
              sync_status: 'SYNCED',
              last_synced_at: new Date().toISOString(),
              last_error: null,
              retry_count: 0
            })
            .eq('device_id', device.id)
            .eq('biometric_user_id', biometricUserId);

          logger.info('COMMAND SUCCESS', `Command ${resolvedId} successfully executed by device SN: ${device.serial_number} (Return: ${returnCode}). Assignment for user ${biometricUserId} marked as SYNCED.`);
        } else {
          // Failure
          const { data: currentAssignment } = await supabase
            .from('device_employee_assignments')
            .select('retry_count')
            .eq('device_id', device.id)
            .eq('biometric_user_id', biometricUserId)
            .maybeSingle();

          const newRetryCount = (currentAssignment?.retry_count || 0) + 1;

          await supabase
            .from('device_employee_assignments')
            .update({
              sync_status: 'ERROR',
              last_error: `Error de terminal (Código: ${returnCode})`,
              retry_count: newRetryCount
            })
            .eq('device_id', device.id)
            .eq('biometric_user_id', biometricUserId);

          logger.warn('COMMAND ERROR', `Command ${resolvedId} failed execution on device SN: ${device.serial_number} (Return: ${returnCode}). Assignment for user ${biometricUserId} marked as ERROR.`);
        }
      }
    } else {
      if (returnCode === 0) {
        logger.info('COMMAND SUCCESS', `Command ${resolvedId} successfully executed by device SN: ${device.serial_number} (Return: ${returnCode})`);
      } else {
        logger.warn('COMMAND ERROR', `Command ${resolvedId} failed execution on device SN: ${device.serial_number} (Return: ${returnCode})`);
      }
    }

    res.status(200).send('OK');
  } catch (err: any) {
    logger.error('SERVER ERROR', `Failed to process command ACK for device SN: ${device.serial_number}`, err);
    res.status(500).send('ERROR');
  }
});

// Start the HTTP listener if not in test environment
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    logger.info('SERVER INIT', `ZKTeco TA Push Connector running on port ${PORT}`);
    logger.info('SERVER INIT', `Supabase target URL: ${process.env.SUPABASE_URL}`);
  });
}

export { app };
