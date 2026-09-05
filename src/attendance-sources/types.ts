/**
 * Contrato interno para la futura capa RAW universal de asistencia.
 *
 * No es una ruta HTTP ni contiene acceso a Supabase. La persistencia solo se
 * habilita después de aplicar y verificar database/live-schema/08.
 */
export const ATTENDANCE_SOURCE_TYPES = [
  'ZKTECO',
  'WEB',
  'MOBILE_APP',
  'API',
  'IMPORT',
  'MANUAL',
] as const;

export type AttendanceSourceType = (typeof ATTENDANCE_SOURCE_TYPES)[number];

export const ATTENDANCE_PROCESSING_STATUSES = [
  'PENDING',
  'PROCESSED',
  'UNCHANGED',
  'ERROR',
  'IGNORED',
] as const;

export type AttendanceProcessingStatus = (typeof ATTENDANCE_PROCESSING_STATUSES)[number];

export type AttendanceRawPayload = Record<string, unknown>;

export interface AttendanceSourceEventInput {
  clienteId: string;
  employeeId?: string | null;
  deviceId?: string | null;
  sourceType: AttendanceSourceType;
  sourceReference?: string | null;
  requestId?: string | null;
  occurredAt: string;
  receivedAt: string;
  processingStatus: AttendanceProcessingStatus;
  processingError?: string | null;
  rawPayload: AttendanceRawPayload;
}

export interface PersistedAttendanceSourceEvent {
  id: string;
  created: boolean;
  processingStatus: AttendanceProcessingStatus;
}

/**
 * El adaptador de base debe implementar create-or-get sobre las restricciones
 * PostgreSQL; nunca puede depender solo de un `if` en Node.
 */
export interface AttendanceSourceEventRepository {
  createOrGet(input: AttendanceSourceEventInput): Promise<PersistedAttendanceSourceEvent>;
}

export interface AttendanceSourcePolicy {
  allowPhysicalAttendance: boolean;
  allowWebAttendance: boolean;
  allowMobileAttendance: boolean;
}

export const DEFAULT_ATTENDANCE_SOURCE_POLICY: AttendanceSourcePolicy = {
  allowPhysicalAttendance: true,
  allowWebAttendance: false,
  allowMobileAttendance: false,
};

export type AttendanceSourceIdempotency =
  | { kind: 'ZKTECO_SOURCE_REFERENCE'; sourceReference: string }
  | { kind: 'REQUEST_PER_EMPRESA'; clienteId: string; requestId: string }
  | { kind: 'NONE' };
