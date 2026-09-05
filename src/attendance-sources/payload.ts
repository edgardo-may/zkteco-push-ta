import { AttendanceRawPayload } from './types.js';

const MAX_CONTEXT_LENGTH = 160;
const FORBIDDEN_KEY = /(authorization|cookie|token|password|secret|template|fingerprint|face|photo|image|snapshot)/i;

function compactText(value: unknown, maxLength = MAX_CONTEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function safeIsoContext(value: unknown): string | undefined {
  const text = compactText(value, 64);
  return text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/**
 * Rechaza nombres de contexto que puedan transportar secretos o biometría. Las
 * rutas futuras deben enviar solo los campos permitidos de abajo, no payloads
 * arbitrarios del navegador o teléfono.
 */
export function assertNoSensitivePayloadKeys(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error('Attendance source payload contains a prohibited sensitive field.');
    }
  }
}

export interface ZktecoRawContext {
  deviceSerial: string;
  hardwareUserId: string;
  rawStatus?: string;
  verifyType?: number;
  sourceLogId: string;
}

/**
 * ZKTeco conserva el identificador físico recibido como contexto RAW. No lo
 * convierte a clave_empleado, pin funcional ni device_userid.
 */
export function createZktecoRawPayload(context: ZktecoRawContext): AttendanceRawPayload {
  const deviceSerial = compactText(context.deviceSerial);
  const hardwareUserId = compactText(context.hardwareUserId);
  const sourceLogId = compactText(context.sourceLogId, 64);

  if (!deviceSerial || !hardwareUserId || !sourceLogId) {
    throw new Error('ZKTeco source context is incomplete.');
  }

  const rawStatus = compactText(context.rawStatus, 32);
  const verifyType = safeInteger(context.verifyType);

  return {
    source: 'zkteco',
    device_serial: deviceSerial,
    hardware_user_id: hardwareUserId,
    ...(rawStatus ? { raw_status: rawStatus } : {}),
    ...(verifyType !== undefined ? { verify_type: verifyType } : {}),
    source_log_id: sourceLogId,
  };
}

export interface WebOrMobileRawContext {
  source: 'web' | 'mobile_app';
  clientTimestamp?: string;
  appVersion?: string;
  verificationMethod: 'web' | 'mobile';
  browser?: string;
  platform?: string;
}

/**
 * Guarda solo evidencia de contexto permitida. La hora oficial pertenece al
 * backend y se pasa por occurredAt; client_timestamp nunca define asistencia.
 */
export function createWebOrMobileRawPayload(context: WebOrMobileRawContext): AttendanceRawPayload {
  const clientTimestamp = safeIsoContext(context.clientTimestamp);
  const appVersion = compactText(context.appVersion);
  const browser = compactText(context.browser);
  const platform = compactText(context.platform);

  return {
    source: context.source,
    ...(clientTimestamp ? { client_timestamp: clientTimestamp } : {}),
    ...(appVersion ? { app_version: appVersion } : {}),
    ...(browser ? { browser } : {}),
    ...(platform ? { platform } : {}),
    verification_method: context.verificationMethod,
  };
}
