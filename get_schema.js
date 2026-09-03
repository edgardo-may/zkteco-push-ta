import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function run() {
  const { data: devices, error: e1 } = await supabase.from('devices').select('*').limit(1);
  const { data: dispositivos, error: e2 } = await supabase.from('dispositivos').select('*').limit(1);

  console.log("DEVICES COLUMNS:");
  if (devices && devices.length > 0) {
    console.log(Object.keys(devices[0]));
  } else {
    console.log("No rows, cannot infer columns, checking types.ts if available");
  }

  console.log("\nDISPOSITIVOS COLUMNS:");
  if (dispositivos && dispositivos.length > 0) {
    console.log(Object.keys(dispositivos[0]));
  } else {
    console.log("No rows");
  }
}

run();
