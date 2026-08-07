const http = require('http');

const PORT = process.env.PORT || 3000;

async function request(method, path, body = null, headers = {}) {
  const data = body ? JSON.stringify(body) : null;
  const allHeaders = {
    'Content-Type': 'application/json',
    ...headers,
  };
  if (data) allHeaders['Content-Length'] = Buffer.byteLength(data);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: PORT,
        path: path,
        method: method,
        headers: allHeaders,
        timeout: 15000,
      },
      (res) => {
        let chunks = '';
        res.on('data', (chunk) => (chunks += chunk));
        res.on('end', () => {
          try {
            const parsed = chunks ? JSON.parse(chunks) : {};
            resolve({ status: res.statusCode, body: parsed, raw: chunks });
          } catch (e) {
            resolve({ status: res.statusCode, body: {}, raw: chunks });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function runTests() {
  const results = [];

  function test(name, passed, details = '') {
    const status = passed ? 'PASS' : 'FAIL';
    results.push({ name, status, details });
    console.log(`  [${status}] ${name}${details ? ' - ' + details : ''}`);
  }

  console.log('\n--- API Tests ---\n');

  console.log('1. Health Check');
  const health = await request('GET', '/api/health');
  test('Health endpoint returns 200', health.status === 200, `Status: ${health.status}`);

  console.log('\n2. Authentication');
  const loginRes = await request('POST', '/api/auth/login', {
    email: 'iftiyeamin06@gmail.com',
    password: 'ifti1234',
  });
  test('Login with valid credentials', loginRes.status === 200, `Status: ${loginRes.status}`);

  const token = loginRes.body.token;
  test('Token returned', !!token, token ? `Token length: ${token.length}` : 'No token');

  const badLogin = await request('POST', '/api/auth/login', {
    email: 'employee@attendance.local',
    password: 'wrongpassword',
  });
  test('Login with wrong password fails', badLogin.status === 401, `Status: ${badLogin.status}`);

  console.log('\n3. Device Registration');

  // Reset employee device first to ensure clean state
  const { User } = require('../models');
  const employee = await User.findOne({ where: { email: 'iftiyeamin06@gmail.com' } });
  if (employee.boundDeviceId) {
    employee.boundDeviceId = null;
    await employee.save();
    const cache = require('../redis/cache');
    await cache.del(`bound_device:${employee.id}`);
  }

  const deviceCheck = await request('GET', '/api/device/status', null, {
    Authorization: `Bearer ${token}`,
  });
  test('Device not bound initially',
    deviceCheck.status === 200 && !deviceCheck.body.data.has_bound_device,
    JSON.stringify(deviceCheck.body.data));

  const deviceReg = await request(
    'POST',
    '/api/device/register',
    { device_uuid: 'test-device-001' },
    { Authorization: `Bearer ${token}` }
  );
  test('Device registration succeeds', deviceReg.status === 200, `Status: ${deviceReg.status}`);

  const duplicateReg = await request(
    'POST',
    '/api/device/register',
    { device_uuid: 'test-device-002' },
    { Authorization: `Bearer ${token}` }
  );
  test('Duplicate device registration blocked', duplicateReg.status === 400, `Status: ${duplicateReg.status}`);

  console.log('\n4. IP Validation (Clock-In)');
  const clockInWrongIp = await request(
    'POST',
    '/api/attendance/clock-in',
    null,
    { Authorization: `Bearer ${token}`, 'X-Device-UUID': 'test-device-001' }
  );
  test('Clock-in blocked - wrong IP', clockInWrongIp.status === 403,
    `Status: ${clockInWrongIp.status}, Message: ${clockInWrongIp.body.message}`);

  const clockInWrongDevice = await request(
    'POST',
    '/api/attendance/clock-in',
    null,
    { Authorization: `Bearer ${token}`, 'X-Device-UUID': 'wrong-device' }
  );
  test('Clock-in blocked - wrong device (IP check fails first)', clockInWrongDevice.status === 403,
    `Status: ${clockInWrongDevice.status}, Message: ${clockInWrongDevice.body.message}`);

  console.log('\n5. Admin Panel');
  const adminLogin = await request('POST', '/api/auth/login', {
    email: 'admin@attendance.local',
    password: 'admin123',
  });
  test('Admin login', adminLogin.status === 200 && adminLogin.body.user.role === 'admin',
    `Role: ${adminLogin.body.user?.role}`);

  const adminToken = adminLogin.body.token;
  const dashboard = await request('GET', '/api/admin/dashboard', null, {
    Authorization: `Bearer ${adminToken}`,
  });
  test('Admin dashboard accessible', dashboard.status === 200, `Status: ${dashboard.status}`);

  console.log('\n6. Settings');
  const ipUpdate = await request(
    'POST',
    '/api/admin/settings/ip',
    { office_public_ip: '10.0.0.50' },
    { Authorization: `Bearer ${adminToken}` }
  );
  test('Office IP update', ipUpdate.status === 200, `Status: ${ipUpdate.status}, IP: ${ipUpdate.body.data?.office_public_ip}`);

  console.log('\n7. Device Reset');
  const resetDevice = await request(
    'POST',
    `/api/admin/users/${employee.id}/reset-device`,
    null,
    { Authorization: `Bearer ${adminToken}` }
  );
  test('Device reset', resetDevice.status === 200, `Status: ${resetDevice.status}`);

  const deviceStatusAfter = await request('GET', '/api/device/status', null, {
    Authorization: `Bearer ${token}`,
  });
  test('Device cleared after reset', !deviceStatusAfter.body.data.has_bound_device,
    JSON.stringify(deviceStatusAfter.body.data));

  console.log('\n8. CSV Export');
  const csvExport = await request('GET', '/api/admin/export', null, {
    Authorization: `Bearer ${adminToken}`,
  });
  test('CSV export', csvExport.status === 200, `Status: ${csvExport.status}`);

  console.log('\n9. Unauthorized Access');
  const noAuth = await request('GET', '/api/admin/dashboard');
  test('Admin endpoint without token blocked', noAuth.status === 401, `Status: ${noAuth.status}`);

  const employeeToAdmin = await request('GET', '/api/admin/dashboard', null, {
    Authorization: `Bearer ${token}`,
  });
  test('Employee cannot access admin', employeeToAdmin.status === 403, `Status: ${employeeToAdmin.status}`);

  console.log('\n10. Night Shift (shift_date)');
  const { computeShiftDate, calculateDuration } = require('../controllers/attendanceController');

  const day1 = new Date('2026-08-06T20:00:00');
  test('shift_date for clock-in 20:00 = same day',
    computeShiftDate(day1) === '2026-08-06', `Got: ${computeShiftDate(day1)}`);

  const day2Early = new Date('2026-08-07T05:00:00');
  test('shift_date for clock-in 05:00 - previous day',
    computeShiftDate(day2Early) === '2026-08-06', `Got: ${computeShiftDate(day2Early)}`);

  const after = new Date('2026-08-07T09:00:00');
  test('shift_date for clock-in 09:00 -> same day',
    computeShiftDate(after) === '2026-08-07', `Got: ${computeShiftDate(after)}`);

  const dur = calculateDuration(day1, day2Early);
  test('duration 20:00 to 05:00 next day = 9h',
    dur === '9h 0m', `Got: ${dur}`);

  const midnightBoundaryDur = calculateDuration('2026-08-05T23:30:00', '2026-08-06T00:30:00');
  test('duration crossing midnight = 1h',
    midnightBoundaryDur === '1h 0m', `Got: ${midnightBoundaryDur}`);

  const nightDur = calculateDuration('2026-08-05T23:00:00', '2026-08-06T01:00:00');
  test('duration 23:00 to 01:00 = 2h',
    nightDur === '2h 0m', `Got: ${nightDur}`);

  console.log('\n--- Test Summary ---\n');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`Total: ${results.length}, Passed: ${passed}, Failed: ${failed}`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => {
      console.log(`  - ${r.name}: ${r.details}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});