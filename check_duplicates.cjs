const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '../.env.local') });

async function run() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  // Use a query using PostgREST to fetch ALL devices.
  const res = await fetch(`${url}/rest/v1/devices?select=serial_number`, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`
    }
  });
  const devices = await res.json();
  console.log("Existing Serial Numbers in devices:", devices);

  const res2 = await fetch(`${url}/rest/v1/dispositivos?select=device_id_hikvision,cliente_id`, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`
    }
  });
  const disp = await res2.json();
  console.log("Existing Hikvision Serials in dispositivos:", disp);
}
run();
