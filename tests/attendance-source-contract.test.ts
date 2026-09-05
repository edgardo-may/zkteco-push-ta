import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toMobileAttendanceSourceEvent,
  toWebAttendanceSourceEvent,
  toZktecoAttendanceSourceEvent,
} from '../src/attendance-sources/adapters.js';
import { assertNoSensitivePayloadKeys } from '../src/attendance-sources/payload.js';
import {
  AttendanceSourceEventService,
  assertAttendanceSourceEventInput,
  attendanceSourceIdempotency,
} from '../src/attendance-sources/service.js';
import {
  DEFAULT_ATTENDANCE_SOURCE_POLICY,
  AttendanceSourceEventRepository,
} from '../src/attendance-sources/types.js';
import { SupabaseAttendanceSourceEventRepository } from '../src/attendance-sources/supabase-repository.js';

const empresaId = '11111111-1111-4111-8111-111111111111';
const otherEmpresaId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const employeeId = '44444444-4444-4444-8444-444444444444';
const attlogId = '55555555-5555-4555-8555-555555555555';
const requestId = '66666666-6666-4666-8666-666666666666';
const receivedAt = '2026-09-05T12:00:00.000Z';

describe('Attendance source event contracts', () => {
  test('ZKTeco preserves the physical hardware user id and uses ATTLOG id as its idempotency reference', () => {
    const event = toZktecoAttendanceSourceEvent({
      clienteId: empresaId,
      employeeId,
      deviceId,
      attendanceLogId: attlogId,
      occurredAt: receivedAt,
      receivedAt,
      deviceSerial: 'ZK-UNIT-01',
      hardwareUserId: '4',
      rawStatus: '0',
      verifyType: 15,
    });

    assertAttendanceSourceEventInput(event);
    assert.equal(event.sourceType, 'ZKTECO');
    assert.equal(event.sourceReference, attlogId);
    assert.equal(event.rawPayload.hardware_user_id, '4');
    assert.equal(event.rawPayload.source_log_id, attlogId);
    assert.deepEqual(attendanceSourceIdempotency(event), {
      kind: 'ZKTECO_SOURCE_REFERENCE',
      sourceReference: attlogId,
    });
  });

  test('Web uses backend time and preserves client time only as non-authoritative context', () => {
    const event = toWebAttendanceSourceEvent({
      clienteId: empresaId,
      authenticatedEmployeeId: employeeId,
      requestId,
      receivedAt,
      clientTimestamp: '2026-09-05T06:00:00.000-06:00',
      appVersion: 'web-1.0.0',
      browser: 'Example Browser',
    });

    assertAttendanceSourceEventInput(event);
    assert.equal(event.occurredAt, receivedAt);
    assert.equal(event.rawPayload.client_timestamp, '2026-09-05T06:00:00.000-06:00');
    assert.deepEqual(attendanceSourceIdempotency(event), {
      kind: 'REQUEST_PER_EMPRESA',
      clienteId: empresaId,
      requestId,
    });
  });

  test('Mobile has the same normalized contract and request idempotency as Web', () => {
    const event = toMobileAttendanceSourceEvent({
      clienteId: empresaId,
      authenticatedEmployeeId: employeeId,
      requestId,
      receivedAt,
      clientTimestamp: '2026-09-05T05:59:59.000-06:00',
      appVersion: 'mobile-1.0.0',
      platform: 'ios',
    });

    assertAttendanceSourceEventInput(event);
    assert.equal(event.sourceType, 'MOBILE_APP');
    assert.equal(event.sourceReference, requestId);
    assert.equal(event.requestId, requestId);
  });

  test('future Web and mobile sources are disabled by default and do not call persistence', async () => {
    let calls = 0;
    const repository: AttendanceSourceEventRepository = {
      async createOrGet() {
        calls += 1;
        return { id: attlogId, created: true, processingStatus: 'PENDING' };
      },
    };
    const service = new AttendanceSourceEventService(repository, DEFAULT_ATTENDANCE_SOURCE_POLICY);
    const event = toWebAttendanceSourceEvent({
      clienteId: empresaId,
      authenticatedEmployeeId: employeeId,
      requestId,
      receivedAt,
    });

    await assert.rejects(service.register(event), /disabled for this Empresa/);
    assert.equal(calls, 0);
  });

  test('a request id is scoped to the Empresa in the application contract; authorization must resolve the employee first', () => {
    const first = toMobileAttendanceSourceEvent({
      clienteId: empresaId,
      authenticatedEmployeeId: employeeId,
      requestId,
      receivedAt,
    });
    const second = toMobileAttendanceSourceEvent({
      clienteId: otherEmpresaId,
      authenticatedEmployeeId: employeeId,
      requestId,
      receivedAt,
    });

    assert.notDeepEqual(attendanceSourceIdempotency(first), attendanceSourceIdempotency(second));
  });

  test('sensitive payload keys are rejected before they can enter raw context', () => {
    assert.throws(
      () => assertNoSensitivePayloadKeys({ authorization: 'not-allowed' }),
      /prohibited sensitive field/,
    );
    assert.throws(
      () => assertNoSensitivePayloadKeys({ fingerprint_template: 'not-allowed' }),
      /prohibited sensitive field/,
    );
    assert.doesNotThrow(() => assertNoSensitivePayloadKeys({ app_version: '1.0.0', platform: 'ios' }));
  });

  test('Supabase repository resolves a PostgreSQL unique conflict instead of check-then-insert', async () => {
    let insertAttempts = 0;
    const fakeClient = {
      from() {
        return {
          insert() {
            insertAttempts += 1;
            return {
              select() {
                return {
                  async maybeSingle() {
                    return insertAttempts === 1
                      ? { data: { id: attlogId, processing_status: 'PENDING' }, error: null }
                      : { data: null, error: { code: '23505', message: 'duplicate key' } };
                  },
                };
              },
            };
          },
          select() {
            const filters: Record<string, string> = {};
            const query = {
              eq(field: string, value: string) { filters[field] = value; return query; },
              async maybeSingle() {
                assert.equal(filters.source_reference, attlogId);
                return { data: { id: attlogId, processing_status: 'PENDING' }, error: null };
              },
            };
            return query;
          },
        };
      },
    };
    const repository = new SupabaseAttendanceSourceEventRepository(fakeClient);
    const event = toZktecoAttendanceSourceEvent({
      clienteId: empresaId,
      employeeId,
      deviceId,
      attendanceLogId: attlogId,
      occurredAt: receivedAt,
      receivedAt,
      deviceSerial: 'ZK-UNIT-01',
      hardwareUserId: '4',
    });

    assert.equal((await repository.createOrGet(event)).created, true);
    assert.equal((await repository.createOrGet(event)).created, false);
    assert.equal(insertAttempts, 2);
  });
});
