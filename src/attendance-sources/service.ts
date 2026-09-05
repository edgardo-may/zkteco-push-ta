import {
  ATTENDANCE_SOURCE_TYPES,
  AttendanceSourceEventInput,
  AttendanceSourceEventRepository,
  AttendanceSourceIdempotency,
  AttendanceSourcePolicy,
  AttendanceSourceType,
  PersistedAttendanceSourceEvent,
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function assertTimestamp(value: string, field: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Attendance source event has an invalid ${field}.`);
  }
}

export function isAttendanceSourceAllowed(sourceType: AttendanceSourceType, policy: AttendanceSourcePolicy): boolean {
  switch (sourceType) {
    case 'ZKTECO':
      return policy.allowPhysicalAttendance;
    case 'WEB':
      return policy.allowWebAttendance;
    case 'MOBILE_APP':
      return policy.allowMobileAttendance;
    default:
      return false;
  }
}

export function attendanceSourceIdempotency(input: AttendanceSourceEventInput): AttendanceSourceIdempotency {
  if (input.sourceType === 'ZKTECO' && input.sourceReference) {
    return { kind: 'ZKTECO_SOURCE_REFERENCE', sourceReference: input.sourceReference };
  }

  if ((input.sourceType === 'WEB' || input.sourceType === 'MOBILE_APP') && input.requestId) {
    return { kind: 'REQUEST_PER_EMPRESA', clienteId: input.clienteId, requestId: input.requestId };
  }

  return { kind: 'NONE' };
}

/**
 * Validación de contrato previa al repositorio. La relación Empresa/empleado/
 * dispositivo se vuelve a validar en PostgreSQL por el trigger del script 08.
 */
export function assertAttendanceSourceEventInput(input: AttendanceSourceEventInput): void {
  if (!ATTENDANCE_SOURCE_TYPES.includes(input.sourceType)) {
    throw new Error('Attendance source event has an unsupported source type.');
  }
  if (!isUuid(input.clienteId)) throw new Error('Attendance source event has an invalid Empresa id.');
  if (input.employeeId && !isUuid(input.employeeId)) throw new Error('Attendance source event has an invalid employee id.');
  if (input.deviceId && !isUuid(input.deviceId)) throw new Error('Attendance source event has an invalid device id.');
  if (input.sourceReference && !isUuid(input.sourceReference)) throw new Error('Attendance source event has an invalid source reference.');
  if (input.requestId && !isUuid(input.requestId)) throw new Error('Attendance source event has an invalid request id.');
  if (!input.rawPayload || Array.isArray(input.rawPayload) || typeof input.rawPayload !== 'object') {
    throw new Error('Attendance source event raw payload must be an object.');
  }
  if (input.processingError && input.processingError.length > 512) {
    throw new Error('Attendance source event error exceeds the safe length.');
  }
  assertTimestamp(input.occurredAt, 'occurred_at');
  assertTimestamp(input.receivedAt, 'received_at');

  if (input.sourceType === 'ZKTECO' && (!input.sourceReference || !input.deviceId || input.requestId)) {
    throw new Error('ZKTeco source events require an ATTLOG reference and a device, without request_id.');
  }
  if ((input.sourceType === 'WEB' || input.sourceType === 'MOBILE_APP') &&
      (!input.employeeId || !input.requestId || input.sourceReference !== input.requestId)) {
    throw new Error('Web and mobile source events require an authenticated employee and matching request identifiers.');
  }
}

export class AttendanceSourceEventService {
  public constructor(
    private readonly repository: AttendanceSourceEventRepository,
    private readonly policy: AttendanceSourcePolicy,
  ) {}

  public async register(input: AttendanceSourceEventInput): Promise<PersistedAttendanceSourceEvent> {
    assertAttendanceSourceEventInput(input);

    if (!isAttendanceSourceAllowed(input.sourceType, this.policy)) {
      throw new Error('Attendance source is disabled for this Empresa.');
    }

    // createOrGet must rely on the unique indexes in PostgreSQL. It may not
    // turn this into a check-then-insert race in application memory.
    return this.repository.createOrGet(input);
  }
}
