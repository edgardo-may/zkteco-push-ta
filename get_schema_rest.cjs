const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '../.env.local') });

async function run() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.error("Missing credentials in .env");
    return;
  }

  try {
    const res = await fetch(`${url}/rest/v1/devices?limit=1`, {
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`
      }
    });
    const devices = await res.json();
    console.log("DEVICES COLUMNS:", Object.keys(devices[0] || {}));

    const res2 = await fetch(`${url}/rest/v1/dispositivos?limit=1`, {
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`
      }
    });
    const dispositivos = await res2.json();
    console.log("DISPOSITIVOS COLUMNS:", Object.keys(dispositivos[0] || {}));
  } catch (e) {
    console.error(e);
  }
}
run();
