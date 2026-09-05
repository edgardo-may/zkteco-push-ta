import { createWebOrMobileRawPayload, createZktecoRawPayload } from './payload.js';
import { AttendanceSourceEventInput } from './types.js';

export interface ZktecoAttendanceAdapterInput {
  clienteId: string;
  deviceId: string;
  attendanceLogId: string;
  occurredAt: string;
  receivedAt: string;
  employeeId?: string | null;
  deviceSerial: string;
  hardwareUserId: string;
  rawStatus?: string;
  verifyType?: number;
}

/**
 * Se invoca solo después de persistir ATTLOG y obtener su id. El PIN físico se
 * conserva en contexto RAW, mientras que employeeId proviene exclusivamente de
 * device + Empresa + biometric_user_id.
 */
export function toZktecoAttendanceSourceEvent(input: ZktecoAttendanceAdapterInput): AttendanceSourceEventInput {
  return {
    clienteId: input.clienteId,
    employeeId: input.employeeId ?? null,
    deviceId: input.deviceId,
    sourceType: 'ZKTECO',
    sourceReference: input.attendanceLogId,
    requestId: null,
    occurredAt: input.occurredAt,
    receivedAt: input.receivedAt,
    processingStatus: 'PENDING',
    processingError: null,
    rawPayload: createZktecoRawPayload({
      deviceSerial: input.deviceSerial,
      hardwareUserId: input.hardwareUserId,
      rawStatus: input.rawStatus,
      verifyType: input.verifyType,
      sourceLogId: input.attendanceLogId,
    }),
  };
}

interface AuthenticatedAttendanceAdapterInput {
  clienteId: string;
  /** Resuelto por backend desde auth.uid()/perfil; jamás desde el body cliente. */
  authenticatedEmployeeId: string;
  requestId: string;
  receivedAt: string;
  clientTimestamp?: string;
  appVersion?: string;
  browser?: string;
  platform?: string;
}

export type WebAttendanceAdapterInput = AuthenticatedAttendanceAdapterInput;
export type MobileAttendanceAdapterInput = AuthenticatedAttendanceAdapterInput;

/**
 * Contrato futuro: occurred_at es la hora oficial de backend (receivedAt), no
 * el reloj del navegador. Esta función no expone ni habilita una ruta HTTP.
 */
export function toWebAttendanceSourceEvent(input: WebAttendanceAdapterInput): AttendanceSourceEventInput {
  return {
    clienteId: input.clienteId,
    employeeId: input.authenticatedEmployeeId,
    deviceId: null,
    sourceType: 'WEB',
    sourceReference: input.requestId,
    requestId: input.requestId,
    occurredAt: input.receivedAt,
    receivedAt: input.receivedAt,
    processingStatus: 'PENDING',
    processingError: null,
    rawPayload: createWebOrMobileRawPayload({
      source: 'web',
      clientTimestamp: input.clientTimestamp,
      appVersion: input.appVersion,
      browser: input.browser,
      platform: input.platform,
      verificationMethod: 'web',
    }),
  };
}

/** Igual contrato que Web; la fuente cambia, no la lógica laboral posterior. */
export function toMobileAttendanceSourceEvent(input: MobileAttendanceAdapterInput): AttendanceSourceEventInput {
  return {
    clienteId: input.clienteId,
    employeeId: input.authenticatedEmployeeId,
    deviceId: null,
    sourceType: 'MOBILE_APP',
    sourceReference: input.requestId,
    requestId: input.requestId,
    occurredAt: input.receivedAt,
    receivedAt: input.receivedAt,
    processingStatus: 'PENDING',
    processingError: null,
    rawPayload: createWebOrMobileRawPayload({
      source: 'mobile_app',
      clientTimestamp: input.clientTimestamp,
      appVersion: input.appVersion,
      platform: input.platform,
      verificationMethod: 'mobile',
    }),
  };
}
