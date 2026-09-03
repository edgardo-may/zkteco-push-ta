import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Load the backend environment variables
dotenv.config({ path: path.join(process.cwd(), '.env') });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key);

async function run() {
  console.log("=== Checking current devices ===");
  const { data: devices, error: devErr } = await supabase.from('devices').select('id, serial_number, is_active, last_activity, device_type').order('serial_number');
  if (devErr) console.error("Error reading devices:", devErr);
  console.log(devices);

  console.log("\n=== Checking current dispositivos ===");
  const { data: disp, error: dispErr } = await supabase.from('dispositivos').select('*').order('device_id_hikvision');
  if (dispErr) console.error("Error reading dispositivos:", dispErr);
  console.log(disp);

  console.log("\n=== Seeding fixtures ===");
  // Fetch a valid cliente_id
  const { data: clientes } = await supabase.from('clientes').select('id').limit(1);
  if (!clientes || clientes.length === 0) {
    console.error("No tenants exist. Cannot seed.");
    return;
  }
  const cliente_id = clientes[0].id;

  // Delete existing test fixtures to avoid unique constraint violations
  await supabase.from('devices').delete().in('serial_number', ['ZK-VALID', 'ZK-DISABLED']);
  await supabase.from('dispositivos').delete().in('device_id_hikvision', ['ZK-VALID', 'ZK-DISABLED']);

  // Increase the limit
  await supabase.from('clientes').update({ limite_dispositivos: 10 }).eq('id', cliente_id);

  // Insert ZK-VALID
  const { error: i1 } = await supabase.from('devices').insert([
    { serial_number: 'ZK-VALID', is_active: true, last_activity: null, name: 'Valid Test' }
  ]);
  if (i1) console.error("Error inserting ZK-VALID to devices:", i1);

  const { error: i2 } = await supabase.from('dispositivos').insert([
    { cliente_id, device_id_hikvision: 'ZK-VALID', nombre_ubicacion: 'Valid Test', estatus: 'activo' }
  ]);
  if (i2) console.error("Error inserting ZK-VALID to dispositivos:", i2);

  // Insert ZK-DISABLED
  const { error: i3 } = await supabase.from('devices').insert([
    { serial_number: 'ZK-DISABLED', is_active: false, last_activity: null, name: 'Disabled Test' }
  ]);
  if (i3) console.error("Error inserting ZK-DISABLED to devices:", i3);

  const { error: i4 } = await supabase.from('dispositivos').insert([
    { cliente_id, device_id_hikvision: 'ZK-DISABLED', nombre_ubicacion: 'Disabled Test', estatus: 'inactivo' }
  ]);
  if (i4) console.error("Error inserting ZK-DISABLED to dispositivos:", i4);

  console.log("\n=== Checking devices after seed ===");
  const { data: devicesAfter } = await supabase.from('devices').select('id, serial_number, is_active, last_activity, device_type').order('serial_number');
  console.log(devicesAfter);
}

run();
