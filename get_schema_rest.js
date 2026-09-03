import * as dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

async function run() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

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
