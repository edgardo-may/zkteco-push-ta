const dotenv = require('dotenv');
const path = require('path');
const http = require('http');

dotenv.config({ path: path.join(__dirname, '.env') });

const ADMS_HOST = 'localhost';
const ADMS_PORT = 5000;

async function requestAdms(path, serial, method = 'GET', body = '') {
  return new Promise((resolve) => {
    const query = serial ? `?SN=${encodeURIComponent(serial)}&table=ATTLOG` : '';
    const req = http.request(
      {
        hostname: ADMS_HOST,
        port: ADMS_PORT,
        path: `${path}${query}`,
        method,
        headers: {
          'Content-Type': method === 'POST' ? 'application/x-www-form-urlencoded' : 'text/plain',
          'User-Agent': 'ZKTeco/1.0',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, data }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

async function runTest() {
  const payload = '111\t2026-08-26 08:00:00\t0\t1\t0\t0\t0\n';
  console.log("Sending ATTLOG...");
  const res = await requestAdms('/iclock/cdata', 'ZK-SYNC-TEST', 'POST', payload);
  console.log("Response:", res.status, res.data);
}
runTest();
