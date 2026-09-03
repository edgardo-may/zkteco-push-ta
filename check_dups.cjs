const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
  console.log("=== CHECKING DUPLICATES ===");
  const { data: logs, error } = await supabase.from('attendance_logs').select('device_serial, user_id, timestamp');
  if (error) {
    console.error(error);
  } else {
    const map = {};
    for (const log of logs) {
      const key = `${log.device_serial}|${log.user_id}|${log.timestamp}`;
      map[key] = (map[key] || 0) + 1;
    }
    let hasDups = false;
    for (const [key, count] of Object.entries(map)) {
      if (count > 1) {
        hasDups = true;
        console.log(`DUPLICATE FOUND: ${key} -> Count: ${count}`);
      }
    }
    if (!hasDups) console.log("NO DUPLICATES FOUND");
  }

  // To check nullability, let's just attempt inserting NULLs and see if they fail with Not-Null Constraint
  console.log("=== CHECKING NULLABILITY ===");
  const { error: errDS } = await supabase.from('attendance_logs').insert([{ user_id: 'test', timestamp: new Date(), status: '0' }]);
  console.log("Null device_serial error:", errDS ? errDS.message : "Success (Allows NULL)");

  const { error: errUID } = await supabase.from('attendance_logs').insert([{ device_serial: 'test', timestamp: new Date(), status: '0' }]);
  console.log("Null user_id error:", errUID ? errUID.message : "Success (Allows NULL)");

  const { error: errTS } = await supabase.from('attendance_logs').insert([{ device_serial: 'test', user_id: 'test', status: '0' }]);
  console.log("Null timestamp error:", errTS ? errTS.message : "Success (Allows NULL)");
}
check();
