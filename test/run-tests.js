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
    password: 'pass123',
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
  test('shift_date for clock-in 09:00 - previous day (noon cutoff)',
    computeShiftDate(after) === '2026-08-06', `Got: ${computeShiftDate(after)}`);

  const afterNoon = new Date('2026-08-07T13:00:00');
  test('shift_date for clock-in 13:00 = same day (noon cutoff)',
    computeShiftDate(afterNoon) === '2026-08-07', `Got: ${computeShiftDate(afterNoon)}`);

  const dur = calculateDuration(day1, day2Early);
  test('duration 20:00 to 05:00 next day = 9h',
    dur === '9h 0m', `Got: ${dur}`);

  const midnightBoundaryDur = calculateDuration('2026-08-05T23:30:00', '2026-08-06T00:30:00');
  test('duration crossing midnight = 1h',
    midnightBoundaryDur === '1h 0m', `Got: ${midnightBoundaryDur}`);

  const nightDur = calculateDuration('2026-08-05T23:00:00', '2026-08-06T01:00:00');
  test('duration 23:00 to 01:00 = 2h',
    nightDur === '2h 0m', `Got: ${nightDur}`);

  console.log('\n11. Leave Request Workflow');
  const { Leave } = require('../models');
  const { Op } = require('sequelize');

  const now = new Date();
  const cy = now.getFullYear();
  const cm = now.getMonth();

  let chosenDate = null;
  let dateStr = '';
  for (let d = new Date(cy, cm, 1); d.getMonth() === cm; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const overlap = await Leave.findAll({
      where: {
        userId: employee.id,
        status: { [Op.ne]: 'Rejected' },
        startDate: { [Op.lte]: ds },
        endDate: { [Op.gte]: ds },
      },
    });
    if (overlap.length === 0) {
      chosenDate = d;
      dateStr = ds;
      break;
    }
  }
  test('Found a leave-free weekday in current month', !!chosenDate, dateStr || 'none available');

  const invalidStatus = await request(
    'POST',
    `/api/admin/leaves/${'00000000-0000-0000-0000-000000000000'}/status`,
    { status: 'Weird' },
    { Authorization: `Bearer ${adminToken}` }
  );
  test('Invalid status rejected with 400', invalidStatus.status === 400,
    `Status: ${invalidStatus.status}, Message: ${invalidStatus.body.message}`);

  const leaveSubmit = await request('POST', '/api/leaves', {
    start_date: dateStr,
    end_date: dateStr,
    leave_type: 'sick',
    notes: 'Automated leave request test',
  }, { Authorization: `Bearer ${token}` });
  test('Employee submits leave request',
    leaveSubmit.status === 201 && leaveSubmit.body.data?.status === 'Pending',
    `Status: ${leaveSubmit.status}, Data: ${JSON.stringify(leaveSubmit.body.data)}`);
  const leaveId = leaveSubmit.body.data?.id;

  const myLeaves = await request('GET', '/api/leaves', null, { Authorization: `Bearer ${token}` });
  const myPending = myLeaves.body.data?.find(l => l.id === leaveId);
  test('Employee sees own Pending request',
    !!myPending && myPending.status === 'Pending',
    JSON.stringify(myPending));

  const adminLeaves = await request('GET', '/api/admin/leaves', null, { Authorization: `Bearer ${adminToken}` });
  const adminPending = adminLeaves.body.data?.find(l => l.id === leaveId);
  test('Admin sees Pending request',
    !!adminPending && adminPending.status === 'Pending',
    JSON.stringify(adminPending));

  const notifications = await request('GET', '/api/admin/notifications/leaves', null, { Authorization: `Bearer ${adminToken}` });
  const notifPending = notifications.body.data?.find(l => l.id === leaveId);
  test('Pending leave appears in admin notifications',
    notifications.status === 200 && !!notifPending && notifPending.status === 'Pending',
    `Status: ${notifications.status}, Found: ${!!notifPending}`);

  const notifForbidden = await request('GET', '/api/admin/notifications/leaves', null, { Authorization: `Bearer ${token}` });
  test('Employee cannot access admin notifications', notifForbidden.status === 403,
    `Status: ${notifForbidden.status}`);

  const summaryBefore = await request(
    'GET',
    `/api/admin/employee/${employee.id}/summary?month=${cm + 1}&year=${cy}`,
    null,
    { Authorization: `Bearer ${adminToken}` }
  );
  const dayBefore = summaryBefore.body.data?.daily_breakdown?.find(d => d.date === dateStr);
  test('Pending leave NOT counted as ON_LEAVE',
    summaryBefore.status === 200 && (!dayBefore || dayBefore.status !== 'ON_LEAVE'),
    `Summary status: ${summaryBefore.status}, Day: ${JSON.stringify(dayBefore)}`);

  const employeeApprove = await request(
    'POST',
    `/api/admin/leaves/${leaveId}/status`,
    { status: 'Approved' },
    { Authorization: `Bearer ${token}` }
  );
  test('Employee cannot approve own leave', employeeApprove.status === 403,
    `Status: ${employeeApprove.status}, Message: ${employeeApprove.body.message}`);

  const approve = await request(
    'POST',
    `/api/admin/leaves/${leaveId}/status`,
    { status: 'Approved' },
    { Authorization: `Bearer ${adminToken}` }
  );
  test('Admin approves leave', approve.status === 200 && approve.body.data?.status === 'Approved',
    `Status: ${approve.status}, Data: ${JSON.stringify(approve.body.data)}`);

  const notificationsAfter = await request('GET', '/api/admin/notifications/leaves', null, { Authorization: `Bearer ${adminToken}` });
  const stillPending = notificationsAfter.body.data?.find(l => l.id === leaveId);
  test('Approved leave removed from admin notifications',
    notificationsAfter.status === 200 && !stillPending,
    `Status: ${notificationsAfter.status}, Still listed: ${!!stillPending}`);

  const myLeaves2 = await request('GET', '/api/leaves', null, { Authorization: `Bearer ${token}` });
  const myApproved = myLeaves2.body.data?.find(l => l.id === leaveId);
  test('Employee sees request as Approved',
    !!myApproved && myApproved.status === 'Approved',
    JSON.stringify(myApproved));

  const summaryAfter = await request(
    'GET',
    `/api/admin/employee/${employee.id}/summary?month=${cm + 1}&year=${cy}`,
    null,
    { Authorization: `Bearer ${adminToken}` }
  );
  const dayAfter = summaryAfter.body.data?.daily_breakdown?.find(d => d.date === dateStr);
  test('Approved leave shown as ON_LEAVE in report',
    summaryAfter.status === 200 && !!dayAfter && dayAfter.status === 'ON_LEAVE',
    `Summary status: ${summaryAfter.status}, Day: ${JSON.stringify(dayAfter)}`);

  const allSummary = await request(
    'GET',
    `/api/admin/report/summary?month=${cm + 1}&year=${cy}`,
    null,
    { Authorization: `Bearer ${adminToken}` }
  );
  const empRow = allSummary.body.data?.employees?.find(e => e.id === employee.id);
  test('All-employees report reflects approved leave',
    allSummary.status === 200 && (empRow?.leave_days || 0) >= 1,
    JSON.stringify(empRow));

  const delLeave = await request('DELETE', `/api/admin/leaves/${leaveId}`, null, {
    Authorization: `Bearer ${adminToken}`,
  });
  test('Cleanup: leave deleted', delLeave.status === 200, `Status: ${delLeave.status}`);

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