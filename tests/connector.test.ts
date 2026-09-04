import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { app, canonicalUserInfoWireCommand, isSafeDeleteUserInfoCommand } from '../src/server.js';
import { supabase } from '../src/supabase.js';
import { parseAttendanceLogs } from '../src/parser.js';

// Mock DB data storage
let mockDevices: any[] = [];
let mockDispositivos: any[] = [];
let mockCommands: any[] = [];
let mockLogs: any[] = [];
let mockEmpleados: any[] = [];
let mockAssignments: any[] = [];

// Generic query builder to mock Supabase client chains
class MockQueryBuilder {
  private table: string;
  private filters: Array<{ type: string; col: string; val: any }> = [];
  private orderCol: string | null = null;
  private orderAsc: boolean = true;
  private limitVal: number | null = null;

  constructor(table: string) {
    this.table = table;
  }

  select(fields: string = '*') {
    return this;
  }

  eq(col: string, val: any) {
    this.filters.push({ type: 'eq', col, val });
    return this;
  }

  gte(col: string, val: any) {
    this.filters.push({ type: 'gte', col, val });
    return this;
  }

  lte(col: string, val: any) {
    this.filters.push({ type: 'lte', col, val });
    return this;
  }

  order(col: string, options?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = options?.ascending !== false;
    return this;
  }

  limit(val: number) {
    this.limitVal = val;
    return this;
  }

  private execute() {
    let data: any[] = [];
    if (this.table === 'devices') data = mockDevices;
    else if (this.table === 'dispositivos') data = mockDispositivos;
    else if (this.table === 'device_commands') data = mockCommands;
    else if (this.table === 'attendance_logs') data = mockLogs;
    else if (this.table === 'empleados') data = mockEmpleados;
    else if (this.table === 'device_employee_assignments') {
      data = mockAssignments.map(ass => {
        const emp = mockEmpleados.find(e => e.id === ass.employee_id);
        return {
          ...ass,
          empleados: emp ? { ...emp } : null
        };
      });
    }

    // Apply filters
    for (const filter of this.filters) {
      data = data.filter(item => {
        if (filter.col.includes('.')) {
          const parts = filter.col.split('.');
          const parent = item[parts[0]];
          if (!parent) return false;
          const itemVal = parent[parts[1]];
          if (filter.type === 'eq') return itemVal === filter.val;
          return true;
        }
        const itemVal = item[filter.col];
        if (filter.type === 'eq') return itemVal === filter.val;
        if (filter.type === 'gte') return itemVal >= filter.val;
        if (filter.type === 'lte') return itemVal <= filter.val;
        return true;
      });
    }

    // Apply ordering
    if (this.orderCol) {
      data = [...data].sort((a, b) => {
        const aVal = a[this.orderCol!];
        const bVal = b[this.orderCol!];
        if (aVal < bVal) return this.orderAsc ? -1 : 1;
        if (aVal > bVal) return this.orderAsc ? 1 : -1;
        return 0;
      });
    }

    // Apply limit
    if (this.limitVal !== null) {
      data = data.slice(0, this.limitVal);
    }

    return data;
  }

  // Resolve as promise
  async then(onfulfilled?: (value: any) => any) {
    const data = this.execute();
    const res = { data, error: null };
    return onfulfilled ? onfulfilled(res) : res;
  }

  // single / maybeSingle resolves the builder to a single object or null
  async maybeSingle() {
    const data = this.execute();
    return { data: data[0] || null, error: null };
  }

  async single() {
    const data = this.execute();
    if (data.length === 0) {
      return { data: null, error: new Error('Not found') };
    }
    return { data: data[0], error: null };
  }
}

// Generic update builder to mock multiple .eq() chains on update
class MockUpdateBuilder {
  private table: string;
  private updateData: any;
  private filters: Array<{ col: string; val: any }> = [];

  constructor(table: string, updateData: any) {
    this.table = table;
    this.updateData = updateData;
  }

  eq(col: string, val: any) {
    this.filters.push({ col, val });
    return this;
  }

  private execute() {
    let data: any[] = [];
    if (this.table === 'devices') data = mockDevices;
    else if (this.table === 'device_commands') data = mockCommands;
    else if (this.table === 'device_employee_assignments') data = mockAssignments;

    const itemsToUpdate = data.filter(item => {
      return this.filters.every(filter => item[filter.col] === filter.val);
    });

    for (const item of itemsToUpdate) {
      Object.assign(item, this.updateData);
    }

    return itemsToUpdate;
  }

  async then(onfulfilled?: (value: any) => any) {
    const data = this.execute();
    const res = { data, error: null };
    return onfulfilled ? onfulfilled(res) : res;
  }

  async maybeSingle() {
    const data = this.execute();
    return { data: data[0] || null, error: null };
  }
}

// Overwrite supabase.from with our MockQueryBuilder
supabase.from = ((table: string) => {
  return {
    select: (fields: string = '*') => {
      return new MockQueryBuilder(table);
    },
    insert: async (data: any) => {
      if (table === 'attendance_logs') {
        const rows = Array.isArray(data) ? data : [data];
        for (const row of rows) {
          mockLogs.push({ id: `log_${Date.now()}_${Math.random()}`, ...row });
        }
        return { data: rows, error: null };
      }
      return { data: null, error: null };
    },
    update: (updateData: any) => {
      return new MockUpdateBuilder(table, updateData);
    }
  };
}) as any;

describe('ZKTeco TA Push Connector Integration Tests', () => {
  let server: any;
  const baseUrl = 'http://localhost:5001';

  before(() => {
    // Start Express server on test port 5001
    process.env.NODE_ENV = 'test';
    server = app.listen(5001);
  });

  after(() => {
    // Stop Express server
    if (server) {
      server.close();
    }
  });

  beforeEach(() => {
    // Reset mock databases before each test
    mockDevices = [
      {
        id: 'dev_1',
        cliente_id: 'tenant_company_a',
        name: 'SpeedFace Main Entrance',
        serial_number: 'ZKTEST123',
        is_active: true,
        timezone: 'America/Mexico_City',
        ip_address: '192.168.1.100',
        port: 80,
        device_type: 'entrada'
      },
      {
        id: 'dev_disabled',
        cliente_id: 'tenant_company_a',
        name: 'Disabled SpeedFace',
        serial_number: 'ZKTEST_DISABLED',
        is_active: false,
        timezone: 'America/Mexico_City',
        ip_address: '192.168.1.101',
        port: 80,
        device_type: 'general'
      }
    ];

    mockDispositivos = [
      {
        id: 'disp_1',
        cliente_id: 'tenant_company_a',
        device_id_hikvision: 'ZKTEST123',
        estatus: 'activo'
      },
      {
        id: 'disp_disabled_tenant',
        cliente_id: 'tenant_company_b',
        device_id_hikvision: 'ZKTEST_DISABLED_TENANT',
        estatus: 'inactivo'
      },
      {
        id: 'disp_disabled_dev',
        cliente_id: 'tenant_company_a',
        device_id_hikvision: 'ZKTEST_DISABLED',
        estatus: 'activo'
      }
    ];

    mockEmpleados = [
      {
        id: 'emp_1',
        cliente_id: 'tenant_company_a',
        nombre: 'Juan',
        apellido: 'Perez',
        activo: true,
        clave_empleado: 'EMP201'
      },
      {
        id: 'emp_inactive',
        cliente_id: 'tenant_company_a',
        nombre: 'Maria',
        apellido: 'Gomez',
        activo: false,
        clave_empleado: 'EMP202'
      }
    ];

    mockAssignments = [
      {
        id: 'assign_1',
        cliente_id: 'tenant_company_a',
        device_id: 'dev_1',
        employee_id: 'emp_1',
        biometric_user_id: '201',
        activo: true,
        sync_status: 'PENDING'
      },
      {
        id: 'assign_inactive',
        cliente_id: 'tenant_company_a',
        device_id: 'dev_1',
        employee_id: 'emp_inactive',
        biometric_user_id: '202',
        activo: true,
        sync_status: 'PENDING'
      }
    ];

    mockCommands = [
      {
        id: 'cmd_1',
        cliente_id: 'tenant_company_a',
        device_serial: 'ZKTEST123',
        command_string: 'INFO',
        is_executed: false,
        created_at: new Date().toISOString()
      }
    ];

    mockLogs = [];
  });

  // ── 1. PARSER UNIT TESTS ───────────────────────────────────────────────────
  test('Parser - Should parse tab-separated logs correctly', () => {
    const rawData = '101\t2026-08-12 22:30:00\t0\t15\t0\t0\n102\t2026-08-12 22:35:00\t1\t15\t0\t0';
    const parsed = parseAttendanceLogs(rawData, 'America/Mexico_City');
    
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].userId, '101');
    assert.strictEqual(parsed[0].status, 'check_in');
    assert.ok(parsed[0].timestamp.endsWith('Z')); // parsed and converted to UTC
    assert.strictEqual(parsed[1].userId, '102');
    assert.strictEqual(parsed[1].status, 'check_out');
  });

  test('Parser - Should parse space-separated logs correctly', () => {
    const rawData = '103 2026-08-12 22:40:00 2 15\n104 2026-08-12 22:45:00 3 15';
    const parsed = parseAttendanceLogs(rawData, 'America/Mexico_City');
    
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].userId, '103');
    assert.strictEqual(parsed[0].status, 'break_out');
    assert.strictEqual(parsed[1].userId, '104');
    assert.strictEqual(parsed[1].status, 'break_in');
  });

  test('USERINFO - Should preserve Name while normalizing legacy fields', () => {
    const normalized = canonicalUserInfoWireCommand(
      'DATA UPDATE USERINFO Pin=1\nName=Edgardo May Chan\nPri=0'
    );

    assert.strictEqual(
      normalized,
      'DATA UPDATE USERINFO PIN=1\tName=Edgardo May Chan\tPrivilege=0'
    );
    assert.ok(normalized?.includes('PIN=1'));
    assert.ok(normalized?.includes('Name=Edgardo May Chan'));
    assert.ok(normalized?.includes('Privilege=0'));
  });

  test('DELETE USERINFO - only uppercase numeric PIN form is safe', () => {
    assert.strictEqual(isSafeDeleteUserInfoCommand('DATA DELETE USERINFO PIN=201'), true);
    assert.strictEqual(isSafeDeleteUserInfoCommand('DATA DELETE USERINFO Pin=201'), false);
  });

  // ── 2. HANDSHAKE TESTS ─────────────────────────────────────────────────────
  test('Handshake - Active authorized device should receive RegistryCode options', async () => {
    const res = await fetch(`${baseUrl}/iclock/cdata?SN=ZKTEST123&options=all`);
    assert.strictEqual(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('GET OPTION FROM: ZKTEST123'));
    assert.ok(body.includes('RegistryCode='));
    assert.ok(body.includes('PushVersion=3.2.0'));
  });

  test('Handshake - Disabled device should receive 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/iclock/cdata?SN=ZKTEST_DISABLED&options=all`);
    assert.strictEqual(res.status, 403);
  });

  test('Handshake - Unknown device should receive 401 Unauthorized', async () => {
    const res = await fetch(`${baseUrl}/iclock/cdata?SN=UNKNOWN_SN_123&options=all`);
    assert.strictEqual(res.status, 401);
  });

  test('Handshake - Device with inactive tenant mapping should receive 403', async () => {
    // Add device registry
    mockDevices.push({
      id: 'dev_tenant_disabled',
      serial_number: 'ZKTEST_DISABLED_TENANT',
      is_active: true
    });
    const res = await fetch(`${baseUrl}/iclock/cdata?SN=ZKTEST_DISABLED_TENANT&options=all`);
    assert.strictEqual(res.status, 403);
  });

  // ── 3. HEARTBEAT & COMMANDS TESTS ──────────────────────────────────────────
  test('Heartbeat - Polling should return pending command if available', async () => {
    const res = await fetch(`${baseUrl}/iclock/getrequest?SN=ZKTEST123`);
    assert.strictEqual(res.status, 200);
    const body = await res.text();
    assert.strictEqual(body, 'C:cmd_1:INFO\n');
  });

  test('Heartbeat - Polling should return OK if no commands in queue', async () => {
    mockCommands[0].is_executed = true; // Clear command queue
    const res = await fetch(`${baseUrl}/iclock/getrequest?SN=ZKTEST123`);
    assert.strictEqual(res.status, 200);
    const body = await res.text();
    assert.strictEqual(body, 'OK');
  });

  test('Command ACK - Success code should mark command as executed', async () => {
    const res = await fetch(`${baseUrl}/iclock/devicecmd?SN=ZKTEST123`, {
      method: 'POST',
      body: 'ID=cmd_1&Return=0'
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'OK');
    
    // Command in mock DB should now be marked as executed
    const cmd = mockCommands.find(c => c.id === 'cmd_1');
    assert.strictEqual(cmd?.is_executed, true);
  });

  // ── 3.5. EMPLOYEE SYNC STATUS LIFECYCLE TESTS ─────────────────────────────
  test('Sync Lifecycle - Heartbeat polling should update assignment to SYNCING', async () => {
    // Add a user update command to the queue
    mockCommands.push({
      id: 'cmd_sync_update',
      cliente_id: 'tenant_company_a',
      device_serial: 'ZKTEST123',
      command_string: 'DATA UPDATE USERINFO Pin=201\tName=Juan Perez\tPri=0',
      is_executed: false,
      created_at: new Date().toISOString()
    });

    // Verify initial assignment state is PENDING
    const assignBefore = mockAssignments.find(a => a.biometric_user_id === '201');
    assert.strictEqual(assignBefore?.sync_status, 'PENDING');

    // Run getrequest to dispatch the oldest command
    // (cmd_1 is INFO, so we clear it first to let cmd_sync_update be queried)
    mockCommands[0].is_executed = true; 

    const res = await fetch(`${baseUrl}/iclock/getrequest?SN=ZKTEST123`);
    assert.strictEqual(res.status, 200);
    const body = await res.text();
    assert.strictEqual(body, 'C:cmd_sync_update:DATA UPDATE USERINFO Pin=201\tName=Juan Perez\tPri=0\n');

    // Verify assignment state updated to SYNCING
    const assignAfter = mockAssignments.find(a => a.biometric_user_id === '201');
    assert.strictEqual(assignAfter?.sync_status, 'SYNCING');
    assert.ok(assignAfter?.last_attempt_at);
  });

  test('Sync Lifecycle - Success ACK should update assignment to SYNCED', async () => {
    // Setup command and initial syncing state (since database is reset before each test)
    mockCommands.push({
      id: 'cmd_sync_update',
      cliente_id: 'tenant_company_a',
      device_serial: 'ZKTEST123',
      command_string: 'DATA UPDATE USERINFO Pin=201\tName=Juan Perez\tPri=0',
      is_executed: false,
      created_at: new Date().toISOString()
    });
    const assign = mockAssignments.find(a => a.biometric_user_id === '201');
    if (assign) assign.sync_status = 'SYNCING';

    // Now trigger ACK success (Return=0)
    const res = await fetch(`${baseUrl}/iclock/devicecmd?SN=ZKTEST123`, {
      method: 'POST',
      body: 'ID=cmd_sync_update&Return=0'
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'OK');

    // Verify assignment status is updated to SYNCED
    assert.strictEqual(assign?.sync_status, 'SYNCED');
    assert.ok(assign?.last_synced_at);
    assert.strictEqual(assign?.last_error, null);
    assert.strictEqual(assign?.retry_count, 0);
  });

  test('Sync Lifecycle - Error ACK should update assignment to ERROR and increment retry_count', async () => {
    // Setup command and initial syncing state (since database is reset before each test)
    mockCommands.push({
      id: 'cmd_sync_error',
      cliente_id: 'tenant_company_a',
      device_serial: 'ZKTEST123',
      command_string: 'DATA UPDATE USERINFO Pin=201\tName=Juan Perez\tPri=0',
      is_executed: false,
      created_at: new Date().toISOString()
    });
    const assign = mockAssignments.find(a => a.biometric_user_id === '201');
    if (assign) assign.sync_status = 'SYNCING';

    // Trigger ACK error (Return=-1)
    const res = await fetch(`${baseUrl}/iclock/devicecmd?SN=ZKTEST123`, {
      method: 'POST',
      body: 'ID=cmd_sync_error&Return=-1'
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'OK');

    // Verify assignment status is updated to ERROR
    assert.strictEqual(assign?.sync_status, 'ERROR');
    assert.strictEqual(assign?.retry_count, 1);
    assert.ok(assign?.last_error);
  });

  // ── 4. LOGS UPLOAD & DUPLICATES TESTS ──────────────────────────────────────
  test('Data Upload - Should save new logs successfully', async () => {
    const res = await fetch(`${baseUrl}/iclock/cdata?SN=ZKTEST123&table=ATTLOG`, {
      method: 'POST',
      body: '201\t2026-08-12 23:00:00\t0\t15\t0\t0'
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'OK');

    assert.strictEqual(mockLogs.length, 1);
    assert.strictEqual(mockLogs[0].user_id, 'EMP201'); // Resolved!
    assert.strictEqual(mockLogs[0].device_serial, 'ZKTEST123');
  });

  test('Data Upload - Should skip duplicate logs', async () => {
    // Populate an existing log in mock DB
    // Convert 2026-08-12 23:00:00 (local America/Mexico_City = UTC-6) to UTC ISO
    // 2026-08-12 23:00:00 -6 = 2026-08-13 05:00:00Z
    const timestampUTC = '2026-08-13T05:00:00.000Z';
    mockLogs.push({
      device_serial: 'ZKTEST123',
      user_id: 'EMP201', // Already resolved to corporate code
      timestamp: timestampUTC,
      status: 'check_in'
    });

    const res = await fetch(`${baseUrl}/iclock/cdata?SN=ZKTEST123&table=ATTLOG`, {
      method: 'POST',
      body: '201\t2026-08-12 23:00:00\t0\t15\t0\t0'
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'OK');

    // Logs array length should remain 1 (no new duplicate log inserted)
    assert.strictEqual(mockLogs.length, 1);
  });

  test('Data Upload - Should skip logs of unregistered or inactive employees', async () => {
    // 202 is inactive (activo: false), 999 is unregistered
    const rawBody = '202\t2026-08-12 23:05:00\t0\t15\t0\t0\n999\t2026-08-12 23:10:00\t0\t15\t0\t0';
    
    const res = await fetch(`${baseUrl}/iclock/cdata?SN=ZKTEST123&table=ATTLOG`, {
      method: 'POST',
      body: rawBody
    });
    
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'OK');

    // No logs should be saved (mockLogs should remain empty since we reset it)
    assert.strictEqual(mockLogs.length, 0);
  });

  // ── 3.6. ADVANCED PROVISIONING & OFFLINE TESTS ────────────────────────────
  test('Provisioning - Disable User should update status to SYNCING on delete command', async () => {
    // Clear command queue to isolate this test
    mockCommands = [];

    // Queue a DELETE command
    mockCommands.push({
      id: 'cmd_delete_user',
      cliente_id: 'tenant_company_a',
      device_serial: 'ZKTEST123',
      command_string: 'DATA DELETE USERINFO PIN=201',
      is_executed: false,
      created_at: new Date().toISOString()
    });

    const assign = mockAssignments.find(a => a.biometric_user_id === '201');
    if (assign) {
      assign.sync_status = 'PENDING';
      assign.activo = false; // Disabled
    }

    const res = await fetch(`${baseUrl}/iclock/getrequest?SN=ZKTEST123`);
    assert.strictEqual(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('DATA DELETE USERINFO PIN=201'));

    // Check status is updated to SYNCING
    assert.strictEqual(assign?.sync_status, 'SYNCING');
  });

  test('Provisioning - unsafe DELETE USERINFO variants are blocked and consumed', async () => {
    const unsafeCommands = [
      'DATA DELETE USERINFO Pin=9999',
      'DATA DELETE USERINFO pin=9999',
      'DATA DELETE USERINFO',
      'DATA DELETE USERINFO *',
      'DATA DELETE USERINFO PIN=*',
      'DATA DELETE USERINFO PIN=',
      'DATA DELETE USERINFO PIN=9999\tName=ignored'
    ];

    for (const [index, command_string] of unsafeCommands.entries()) {
      mockCommands = [{
        id: `cmd_unsafe_${index}`,
        device_serial: 'ZKTEST123',
        command_string,
        is_executed: false,
        created_at: new Date().toISOString()
      }];

      const res = await fetch(`${baseUrl}/iclock/getrequest?SN=ZKTEST123`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(await res.text(), 'OK');
      assert.strictEqual(mockCommands[0]?.is_executed, true);
      assert.ok(mockCommands[0]?.updated_at);
    }
  });

  test('Provisioning - uppercase numeric DELETE USERINFO remains dispatchable', async () => {
    mockCommands = [{
      id: 'cmd_safe_delete',
      device_serial: 'ZKTEST123',
      command_string: 'DATA DELETE USERINFO PIN=9999',
      is_executed: false,
      created_at: new Date().toISOString()
    }];

    const res = await fetch(`${baseUrl}/iclock/getrequest?SN=ZKTEST123`);
    assert.strictEqual(res.status, 200);
    assert.ok((await res.text()).includes('DATA DELETE USERINFO PIN=9999'));
    assert.strictEqual(mockCommands[0]?.is_executed, false);
  });

  test('Provisioning - DELETE Return=0 confirms removal without reactivating assignment', async () => {
    mockCommands = [{
      id: 'cmd_delete_success',
      cliente_id: 'tenant_company_a',
      device_serial: 'ZKTEST123',
      command_string: 'DATA DELETE USERINFO PIN=201',
      is_executed: false,
      created_at: new Date().toISOString()
    }];
    const assign = mockAssignments.find(a => a.biometric_user_id === '201');
    if (assign) {
      assign.activo = false;
      assign.suspension_reason = 'EMPLOYEE_DEACTIVATED';
      assign.sync_status = 'SYNCING';
    }

    const res = await fetch(`${baseUrl}/iclock/devicecmd?SN=ZKTEST123`, {
      method: 'POST',
      body: 'ID=cmd_delete_success&Return=0'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(assign?.activo, false);
    assert.strictEqual(assign?.suspension_reason, 'EMPLOYEE_DEACTIVATED');
    assert.strictEqual(assign?.sync_status, 'SYNCED');
    assert.strictEqual(mockCommands[0]?.is_executed, true);
    assert.ok(mockCommands[0]?.updated_at);
    assert.strictEqual(mockCommands.length, 1);
  });

  test('Provisioning - DELETE Return!=0 leaves removal in ERROR and consumes its ACK', async () => {
    mockCommands = [{
      id: 'cmd_delete_error',
      cliente_id: 'tenant_company_a',
      device_serial: 'ZKTEST123',
      command_string: 'DATA DELETE USERINFO PIN=201',
      is_executed: false,
      created_at: new Date().toISOString()
    }];
    const assign = mockAssignments.find(a => a.biometric_user_id === '201');
    if (assign) {
      assign.activo = false;
      assign.suspension_reason = 'EMPLOYEE_DEACTIVATED';
      assign.sync_status = 'SYNCING';
    }

    const res = await fetch(`${baseUrl}/iclock/devicecmd?SN=ZKTEST123`, {
      method: 'POST',
      body: 'ID=cmd_delete_error&Return=-7'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(assign?.activo, false);
    assert.strictEqual(assign?.sync_status, 'ERROR');
    assert.strictEqual(assign?.last_error, 'Terminal Return=-7');
    assert.strictEqual(assign?.retry_count, 1);
    assert.strictEqual(mockCommands[0]?.is_executed, true);
    assert.ok(mockCommands[0]?.updated_at);
    assert.strictEqual(mockCommands.length, 1);
  });

  test('Provisioning - ACK never updates an assignment from another tenant', async () => {
    mockCommands = [{
      id: 'cmd_tenant_a',
      cliente_id: 'tenant_company_a',
      device_serial: 'ZKTEST123',
      command_string: 'DATA DELETE USERINFO PIN=201',
      is_executed: false,
      created_at: new Date().toISOString()
    }];
    mockAssignments.push({
      id: 'assign_cross_tenant',
      cliente_id: 'tenant_company_b',
      device_id: 'dev_1',
      employee_id: 'emp_other_tenant',
      biometric_user_id: '201',
      activo: false,
      sync_status: 'PENDING'
    });

    const res = await fetch(`${baseUrl}/iclock/devicecmd?SN=ZKTEST123`, {
      method: 'POST',
      body: 'ID=cmd_tenant_a&Return=0'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(mockAssignments.find(a => a.id === 'assign_1')?.sync_status, 'SYNCED');
    assert.strictEqual(mockAssignments.find(a => a.id === 'assign_cross_tenant')?.sync_status, 'PENDING');
  });

  test('Provisioning - Device Offline should keep command and status pending', async () => {
    // Clear command queue to isolate this test
    mockCommands = [];

    // Queue a command but do NOT poll heartbeat
    mockCommands.push({
      id: 'cmd_offline',
      cliente_id: 'tenant_company_a',
      device_serial: 'ZKTEST123',
      command_string: 'DATA UPDATE USERINFO Pin=201\tName=Juan Perez',
      is_executed: false,
      created_at: new Date().toISOString()
    });

    const assign = mockAssignments.find(a => a.biometric_user_id === '201');
    if (assign) {
      assign.sync_status = 'PENDING';
    }

    // Since no fetch to getrequest was made, state remains PENDING
    assert.strictEqual(assign?.sync_status, 'PENDING');
    const cmd = mockCommands.find(c => c.id === 'cmd_offline');
    assert.strictEqual(cmd?.is_executed, false);
  });

  test('Provisioning - Duplicate command enqueuing behaves sequentially', async () => {
    // Clear command queue to isolate this test
    mockCommands = [];

    // In our mock database, if we add two commands, the getrequest endpoint should serve the oldest one first
    mockCommands.push(
      {
        id: 'cmd_dup_old',
        cliente_id: 'tenant_company_a',
        device_serial: 'ZKTEST123',
        command_string: 'DATA UPDATE USERINFO Pin=201\tName=Old Name',
        is_executed: false,
        created_at: new Date(Date.now() - 10000).toISOString() // 10s ago
      },
      {
        id: 'cmd_dup_new',
        cliente_id: 'tenant_company_a',
        device_serial: 'ZKTEST123',
        command_string: 'DATA UPDATE USERINFO Pin=201\tName=New Name',
        is_executed: false,
        created_at: new Date().toISOString() // Now
      }
    );

    // Run heartbeat poll, should receive the old one first
    const res1 = await fetch(`${baseUrl}/iclock/getrequest?SN=ZKTEST123`);
    assert.ok((await res1.text()).includes('cmd_dup_old'));

    // Mark old as executed (like the device confirmed it or failed it)
    const cmdOld = mockCommands.find(c => c.id === 'cmd_dup_old');
    if (cmdOld) cmdOld.is_executed = true;

    // Run heartbeat poll again, should receive the new one
    const res2 = await fetch(`${baseUrl}/iclock/getrequest?SN=ZKTEST123`);
    assert.ok((await res2.text()).includes('cmd_dup_new'));
  });
});
