const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '../.env.local') });

async function run() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;

  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  try {
    // Fetch a valid cliente_id
    const clientsRes = await fetch(`${url}/rest/v1/clientes?select=id&limit=1`, { headers });
    const clients = await clientsRes.json();
    if (!clients || clients.length === 0) {
      console.error("No clients found in the database. Please create a tenant first.");
      return;
    }
    const cliente_id = clients[0].id;

    // Seed devices
    await fetch(`${url}/rest/v1/devices`, {
      method: 'POST',
      headers,
      body: JSON.stringify([
        { serial_number: 'ZK-VALID', is_active: true, name: 'Valid Device' },
        { serial_number: 'ZK-DISABLED', is_active: false, name: 'Disabled Device' }
      ])
    });

    // Seed dispositivos (tenant mapping)
    await fetch(`${url}/rest/v1/dispositivos`, {
      method: 'POST',
      headers,
      body: JSON.stringify([
        { cliente_id, device_id_hikvision: 'ZK-VALID', nombre_ubicacion: 'Valid Device', estatus: 'activo' },
        { cliente_id, device_id_hikvision: 'ZK-DISABLED', nombre_ubicacion: 'Disabled Device', estatus: 'inactivo' }
      ])
    });

    console.log("Database seeded successfully");
  } catch (e) {
    console.error("Error seeding DB:", e);
  }
}

run();
