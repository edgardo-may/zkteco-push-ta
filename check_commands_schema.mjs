import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data, error } = await supabase.from('device_commands').select('*').limit(1);
  if (error) {
    console.error("Error fetching device_commands:", error);
  } else if (data.length > 0) {
    console.log("Columns:", Object.keys(data[0]));
  } else {
    // try to get columns by inserting a dummy and getting the error
    const { error: iErr } = await supabase.from('device_commands').insert([{}]);
    console.log("Insert empty row error (to see columns):", iErr);
  }
}
run();
