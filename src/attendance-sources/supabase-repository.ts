import { supabase } from '../supabase.js';
import {
  AttendanceSourceEventInput,
  AttendanceSourceEventRepository,
  PersistedAttendanceSourceEvent,
} from './types.js';

type SupabaseQueryClient = {
  from(table: string): any;
};

type SourceEventRow = {
  id: string;
  processing_status: PersistedAttendanceSourceEvent['processingStatus'];
};

function payloadForInsert(input: AttendanceSourceEventInput): Record<string, unknown> {
  return {
    cliente_id: input.clienteId,
    employee_id: input.employeeId ?? null,
    device_id: input.deviceId ?? null,
    source_type: input.sourceType,
    source_reference: input.sourceReference ?? null,
    request_id: input.requestId ?? null,
    occurred_at: input.occurredAt,
    received_at: input.receivedAt,
    processing_status: input.processingStatus,
    processing_error: input.processingError ?? null,
    raw_payload: input.rawPayload,
  };
}

function idempotencyQuery(client: SupabaseQueryClient, input: AttendanceSourceEventInput) {
  if (input.sourceType === 'ZKTECO' && input.sourceReference) {
    return client
      .from('attendance_source_events')
      .select('id, processing_status')
      .eq('source_type', input.sourceType)
      .eq('source_reference', input.sourceReference)
      .maybeSingle();
  }

  if ((input.sourceType === 'WEB' || input.sourceType === 'MOBILE_APP') && input.requestId) {
    return client
      .from('attendance_source_events')
      .select('id, processing_status')
      .eq('cliente_id', input.clienteId)
      .eq('request_id', input.requestId)
      .maybeSingle();
  }

  return null;
}

function persisted(row: SourceEventRow, created: boolean): PersistedAttendanceSourceEvent {
  return {
    id: row.id,
    created,
    processingStatus: row.processing_status,
  };
}

/**
 * Repositorio real para la tabla propuesta en 08. La carrera de reintentos la
 * resuelve PostgreSQL mediante sus índices UNIQUE; el SELECT posterior solo
 * recupera la fila ganadora y no se usa como garantía de idempotencia.
 */
export class SupabaseAttendanceSourceEventRepository implements AttendanceSourceEventRepository {
  public constructor(private readonly client: SupabaseQueryClient = supabase) {}

  public async createOrGet(input: AttendanceSourceEventInput): Promise<PersistedAttendanceSourceEvent> {
    const { data, error } = await this.client
      .from('attendance_source_events')
      .insert(payloadForInsert(input))
      .select('id, processing_status')
      .maybeSingle();

    if (!error && data) return persisted(data as SourceEventRow, true);

    if (error?.code === '23505') {
      const existing = idempotencyQuery(this.client, input);
      if (!existing) throw error;

      const { data: existingData, error: existingError } = await existing;
      if (existingError) throw existingError;
      if (existingData) return persisted(existingData as SourceEventRow, false);
    }

    throw error ?? new Error('No se pudo persistir el evento RAW de asistencia.');
  }
}
