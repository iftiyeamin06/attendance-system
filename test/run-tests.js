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
            resolve({ status: res.statusCode, body: parsed, raw: chunks, headers: res.headers });
          } catch (e) {
            resolve({ status: res.statusCode, body: {}, raw: chunks, headers: res.headers });
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

  console.log('\n1b. Test Fixture Setup');
  const adminLogin = await request('POST', '/api/auth/login', {
    email: process.env.TEST_ADMIN_EMAIL || 'admin@attendance.local',
    password: process.env.TEST_ADMIN_PASSWORD || 'admin123',
  });
  test('Admin login', adminLogin.status === 200 && adminLogin.body.user.role === 'admin',
    `Role: ${adminLogin.body.user?.role}`);

  const adminToken = adminLogin.body.token;
  const adminId = adminLogin.body.user.id;

  const e2eEmail = `e2e.${Date.now()}@attendance.local`;
  const e2ePassword = 'e2e-pass-123';
  const e2eCreate = await request('POST', '/api/admin/users', {
    name: 'E2E Test Employee',
    email: e2eEmail,
    password: e2ePassword,
  }, { Authorization: `Bearer ${adminToken}` });
  const employee = { id: e2eCreate.body.data?.id, email: e2eEmail };
  test('Create dedicated test employee',
    (e2eCreate.status === 200 || e2eCreate.status === 201) && !!employee.id,
    `Status: ${e2eCreate.status}, Email: ${e2eEmail}`);

  console.log('\n2. Authentication');
  const loginRes = await request('POST', '/api/auth/login', {
    email: e2eEmail,
    password: e2ePassword,
  });
  test('Login with valid credentials', loginRes.status === 200, `Status: ${loginRes.status}`);

  const token = loginRes.body.token;
  test('Token returned', !!token, token ? `Token length: ${token.length}` : 'No token');

  const badLogin = await request('POST', '/api/auth/login', {
    email: 'nobody@attendance.local',
    password: 'wrongpassword',
  });
  test('Login with wrong password fails', badLogin.status === 401, `Status: ${badLogin.status}`);

  console.log('\n3. Device Registration');

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
  const dashboard = await request('GET', '/api/admin/dashboard', null, {
    Authorization: `Bearer ${adminToken}`,
  });
  test('Admin dashboard accessible', dashboard.status === 200, `Status: ${dashboard.status}`);

  console.log('\n6. Settings');
  const origOfficeIp = await request('GET', '/api/attendance/office-ip', null, {
    Authorization: `Bearer ${token}`,
  });
  const officeIpBefore = origOfficeIp.body?.office_public_ip;

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
  const { Leave, AttendanceLog } = require('../models');
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

  console.log('\n12. Attendance Edit & Manual Punch\n');

  const punchNoReason = await request('POST', '/api/admin/attendance/punch', {
    user_id: employee.id,
    shift_date: dateStr,
    clock_in: '09:15',
    status: 'PRESENT',
  }, { Authorization: `Bearer ${adminToken}` });
  test('Manual punch rejected without reason',
    punchNoReason.status === 400,
    `Status: ${punchNoReason.status}, Message: ${punchNoReason.body.message}`);

  const punchForbidden = await request('POST', '/api/admin/attendance/punch', {
    user_id: employee.id,
    shift_date: dateStr,
    clock_in: '09:15',
    status: 'PRESENT',
    reason: 'test',
  }, { Authorization: `Bearer ${token}` });
  test('Employee blocked from manual punch', punchForbidden.status === 403,
    `Status: ${punchForbidden.status}`);

  const punch = await request('POST', '/api/admin/attendance/punch', {
    user_id: employee.id,
    shift_date: dateStr,
    clock_in: '09:15',
    clock_out: '17:00',
    status: 'PRESENT',
    reason: 'Admin correction - missed clock-in',
  }, { Authorization: `Bearer ${adminToken}` });
  const punchId = punch.body.data?.id;
  test('Admin creates manual punch',
    (punch.status === 200 || punch.status === 201) && !!punchId,
    `Status: ${punch.status}, Data: ${JSON.stringify(punch.body.data)}`);

  const dashPunch = await request('GET', `/api/admin/dashboard?date=${dateStr}&refresh=true`, null, {
    Authorization: `Bearer ${adminToken}`,
  });
  const punchRow = dashPunch.body.data?.attendance_today?.find(l => l.id === punchId);
  test('Manual punch visible on dashboard',
    dashPunch.status === 200 && !!punchRow && punchRow.status === 'VERIFIED' && punchRow.manual_status === 'PRESENT',
    JSON.stringify(punchRow));

  const editNoReason = await request('PUT', `/api/admin/attendance/logs/${punchId}`, {
    clock_in: '09:40',
    status: 'LATE',
  }, { Authorization: `Bearer ${adminToken}` });
  test('Edit rejected without reason', editNoReason.status === 400,
    `Status: ${editNoReason.status}, Message: ${editNoReason.body.message}`);

  const edit = await request('PUT', `/api/admin/attendance/logs/${punchId}`, {
    clock_in: '09:40',
    status: 'LATE',
    reason: 'Late arrival confirmed by HR',
  }, { Authorization: `Bearer ${adminToken}` });
  test('Admin edits attendance log',
    edit.status === 200 && edit.body.data?.manual_status === 'LATE',
    `Status: ${edit.status}, Data: ${JSON.stringify(edit.body.data)}`);

  const dashEdit = await request('GET', `/api/admin/dashboard?date=${dateStr}&refresh=true`, null, {
    Authorization: `Bearer ${adminToken}`,
  });
  const editRow = dashEdit.body.data?.attendance_today?.find(l => l.id === punchId);
  test('Edited log shows LATE on dashboard',
    dashEdit.status === 200 && !!editRow && editRow.is_late === true,
    `Row: ${JSON.stringify(editRow)}`);

  const delPunch = await request('DELETE', `/api/admin/attendance/logs/${punchId}`, null, {
    Authorization: `Bearer ${adminToken}`,
  });
  test('Cleanup: manual punch deleted', delPunch.status === 200, `Status: ${delPunch.status}`);

  const chopNoOut = await request('POST', '/api/admin/attendance/punch', {
    user_id: employee.id,
    shift_date: dateStr,
    clock_in: '09:15',
    status: 'PRESENT',
    reason: 'test no clock-out',
  }, { Authorization: `Bearer ${adminToken}` });
  test('PRESENT manual punch without clock-out blocked',
    chopNoOut.status === 400,
    `Status: ${chopNoOut.status}, Message: ${chopNoOut.body.message}`);

  const chopAbsent = await request('POST', '/api/admin/attendance/punch', {
    user_id: employee.id,
    shift_date: dateStr,
    status: 'ABSENT',
    reason: 'test absent correction',
  }, { Authorization: `Bearer ${adminToken}` });
  const chopAbsentId = chopAbsent.body.data?.id;
  test('ABSENT manual punch without times allowed',
    (chopAbsent.status === 200 || chopAbsent.status === 201) && !!chopAbsentId && chopAbsent.body.data?.manual_status === 'ABSENT',
    `Status: ${chopAbsent.status}, Data: ${JSON.stringify(chopAbsent.body.data)}`);

  const chopEditToPresent = await request('PUT', `/api/admin/attendance/logs/${chopAbsentId}`, {
    status: 'PRESENT',
    reason: 'test edit without times',
  }, { Authorization: `Bearer ${adminToken}` });
  test('Edit to PRESENT without times blocked',
    chopEditToPresent.status === 400,
    `Status: ${chopEditToPresent.status}, Message: ${chopEditToPresent.body.message}`);

  const delChopAbsent = await request('DELETE', `/api/admin/attendance/logs/${chopAbsentId}`, null, {
    Authorization: `Bearer ${adminToken}`,
  });
  test('Cleanup: absent test punch deleted', delChopAbsent.status === 200, `Status: ${delChopAbsent.status}`);

  console.log('\n13. Password Reset & Account Security\n');

  const pwEmail = `pwtest.${Date.now()}@attendance.local`;
  const pwInitial = 'pw-initial-123';

  const pwCreate = await request('POST', '/api/admin/users', {
    name: 'PW Reset Test',
    email: pwEmail,
    password: pwInitial,
  }, { Authorization: `Bearer ${adminToken}` });
  const pwUserId = pwCreate.body.data?.id;
  test('Create temp employee for reset tests',
    (pwCreate.status === 200 || pwCreate.status === 201) && !!pwUserId,
    `Status: ${pwCreate.status}`);

  const pwEmpLogin = await request('POST', '/api/auth/login', {
    email: pwEmail,
    password: pwInitial,
  });
  const pwEmpToken = pwEmpLogin.body.token;
  test('Temp employee can sign in', pwEmpLogin.status === 200 && !!pwEmpToken, `Status: ${pwEmpLogin.status}`);

  const pwForbidden = await request('POST', `/api/admin/users/${pwUserId}/reset-password`, null, {
    Authorization: `Bearer ${pwEmpToken}`,
  });
  test('Employee blocked from admin reset', pwForbidden.status === 403, `Status: ${pwForbidden.status}`);

  const pwReset = await request('POST', `/api/admin/users/${pwUserId}/reset-password`, {
    password: 'newtemp123',
  }, { Authorization: `Bearer ${adminToken}` });
  test('Admin resets employee password with custom password',
    pwReset.status === 200 && pwReset.body.temporary_password === 'newtemp123' && pwReset.body.must_change_password === true,
    `Status: ${pwReset.status}`);

  const pwCustomShort = await request('POST', `/api/admin/users/${pwUserId}/reset-password`, {
    password: 'short',
  }, { Authorization: `Bearer ${adminToken}` });
  test('Short custom password rejected', pwCustomShort.status === 400, `Status: ${pwCustomShort.status}`);

  const pwAdminSelfReset = await request('POST', `/api/admin/users/${adminId}/reset-password`, null, {
    Authorization: `Bearer ${adminToken}`,
  });
  test('Admin reset on admin account blocked', pwAdminSelfReset.status === 400, `Status: ${pwAdminSelfReset.status}`);

  const pwOldLogin = await request('POST', '/api/auth/login', {
    email: pwEmail,
    password: pwInitial,
  });
  test('Old password no longer works', pwOldLogin.status === 401, `Status: ${pwOldLogin.status}`);

  const pwNewLogin = await request('POST', '/api/auth/login', {
    email: pwEmail,
    password: 'newtemp123',
  });
  test('Login with temp password flags forced change',
    pwNewLogin.status === 200 && pwNewLogin.body.user.must_change_password === true,
    `Status: ${pwNewLogin.status}`);

  const pwForcedChange = await request('POST', '/api/auth/change-password', {
    current_password: 'newtemp123',
    new_password: 'freshpwd456',
  }, { Authorization: `Bearer ${pwNewLogin.body.token}` });
  test('Forced password change succeeds', pwForcedChange.status === 200, `Status: ${pwForcedChange.status}`);

  const pwNewPassLogin = await request('POST', '/api/auth/login', {
    email: pwEmail,
    password: 'freshpwd456',
  });
  test('Login after forced change clears flag',
    pwNewPassLogin.status === 200 && pwNewPassLogin.body.user.must_change_password === false,
    `Status: ${pwNewPassLogin.status}`);

  const pwForgot = await request('POST', '/api/auth/forgot-password', {
    email: pwEmail,
  });
  const pwResetToken = pwForgot.body.reset_token;
  test('Forgot password returns one-time token',
    pwForgot.status === 200 && pwForgot.body.success && !!pwResetToken,
    `Status: ${pwForgot.status}`);

  const pwResetVia = await request('POST', '/api/auth/reset-password', {
    token: pwResetToken,
    new_password: 'resetme789',
  });
  test('Reset password with token succeeds', pwResetVia.status === 200, `Status: ${pwResetVia.status}`);

  const pwResetReuse = await request('POST', '/api/auth/reset-password', {
    token: pwResetToken,
    new_password: 'whatever456',
  });
  test('Used reset token rejected', pwResetReuse.status === 400, `Status: ${pwResetReuse.status}`);

  const pwResetGarbage = await request('POST', '/api/auth/reset-password', {
    token: 'not-a-real-token',
    new_password: 'whatever456',
  });
  test('Garbage reset token rejected', pwResetGarbage.status === 400, `Status: ${pwResetGarbage.status}`);

  const pwResetShort = await request('POST', '/api/auth/reset-password', {
    token: pwResetToken,
    new_password: '123',
  });
  test('Short reset password rejected', pwResetShort.status === 400, `Status: ${pwResetShort.status}`);

  const pwForgotUnknown = await request('POST', '/api/auth/forgot-password', {
    email: 'doesnotexist@attendance.local',
  });
  test('Unknown email does not leak account existence',
    pwForgotUnknown.status === 200 && pwForgotUnknown.body.success && !pwForgotUnknown.body.reset_token,
    `Status: ${pwForgotUnknown.status}`);

  const pwNewLogin3 = await request('POST', '/api/auth/login', {
    email: pwEmail,
    password: 'resetme789',
  });
  test('Login with reset password works', pwNewLogin3.status === 200, `Status: ${pwNewLogin3.status}`);

  const pwCleanup = await request('DELETE', `/api/admin/users/${pwUserId}`, null, {
    Authorization: `Bearer ${adminToken}`,
  });
  test('Cleanup: temp employee deleted', pwCleanup.status === 200, `Status: ${pwCleanup.status}`);

  console.log('\n14. Holiday Calendar\n');
  const holidayAdmin = { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` };
  const todayStr = `${cy}-${String(cm + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  let holidayDate = null;
  let holidayDateStr = '';
  for (let d = new Date(cy, cm, 1); d.getMonth() === cm; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (ds === todayStr) continue;
    const logOverlap = await AttendanceLog.findAll({ where: { userId: employee.id, shiftDate: ds } });
    const leaveOverlap = await Leave.findAll({
      where: {
        userId: employee.id,
        status: { [Op.ne]: 'Rejected' },
        startDate: { [Op.lte]: ds },
        endDate: { [Op.gte]: ds },
      },
    });
    if (logOverlap.length === 0 && leaveOverlap.length === 0) {
      holidayDate = d;
      holidayDateStr = ds;
      break;
    }
  }
  test('Found a clean weekday for holiday test', !!holidayDate, holidayDateStr || 'none available');

  const summaryUrl = `/api/admin/employee/${employee.id}/summary?month=${cm + 1}&year=${cy}`;
  const holBefore = await request('GET', summaryUrl, null, { Authorization: `Bearer ${adminToken}` });
  const holBaseWorkdays = holBefore.body.data.summary.total_workdays;
  const holBaseAbsent = holBefore.body.data.summary.absent;
  const hadInBreakdown = holBefore.body.data.daily_breakdown.some(d => d.date === holidayDateStr);
  test('Holiday test date is a normal ABSENT workday before holiday', hadInBreakdown,
    `date: ${holidayDateStr}, base_workdays: ${holBaseWorkdays}`);

  const holAdd = await request('POST', '/api/admin/holidays', { date: holidayDateStr, name: 'Holiday Test Day' }, holidayAdmin);
  test('Holiday created', holAdd.status === 201, `Status: ${holAdd.status}`);
  const holidayId = holAdd.body.data?.id;

  const holAfter = await request('GET', summaryUrl, null, { Authorization: `Bearer ${adminToken}` });
  const holAfterDays = holAfter.body.data.summary.total_workdays;
  const holStillInBreakdown = holAfter.body.data.daily_breakdown.some(d => d.date === holidayDateStr);
  test('Holiday date removed from daily breakdown', !holStillInBreakdown,
    `date: ${holidayDateStr}`);
  test('Workday count reduced for the holiday', holAfterDays === holBaseWorkdays - 1,
    `${holBaseWorkdays} -> ${holAfterDays}`);
  test('Absent count reduced for the holiday', holAfter.body.data.summary.absent === holBaseAbsent - 1,
    `${holBaseAbsent} -> ${holAfter.body.data.summary.absent}`);

  const holList = await request('GET', '/api/admin/holidays', null, { Authorization: `Bearer ${adminToken}` });
  test('Holiday listed in admin holidays', !!holList.body.data?.find(h => h.id === holidayId),
    JSON.stringify(holList.body.data));

  const holBad = await request('POST', '/api/admin/holidays', { date: 'bad-date', name: 'X' }, holidayAdmin);
  test('Invalid holiday date rejected', holBad.status === 400, `Status: ${holBad.status}`);

  if (holidayId) {
    const holDel = await request('DELETE', `/api/admin/holidays/${holidayId}`, null, { Authorization: `Bearer ${adminToken}` });
    test('Holiday deleted (cleanup)', holDel.status === 200, `Status: ${holDel.status}`);
  }

  const holRestored = await request('GET', summaryUrl, null, { Authorization: `Bearer ${adminToken}` });
  test('Workdays restored after holiday removal', holRestored.body.data.summary.total_workdays === holBaseWorkdays,
    `${holRestored.body.data.summary.total_workdays} == ${holBaseWorkdays}`);

  console.log('\n15. Audit Log\n');

  const auditEmail = `audit.${Date.now()}@attendance.local`;
  const auditCreate = await request('POST', '/api/admin/users', {
    name: 'Audit Log Tester',
    email: auditEmail,
    password: 'auditpass123',
  }, { Authorization: `Bearer ${adminToken}` });
  const auditUserId = auditCreate.body.data?.id;
  test('Audit: temp employee created', (auditCreate.status === 200 || auditCreate.status === 201) && !!auditUserId,
    `Status: ${auditCreate.status}`);

  const auditReset = await request('POST', `/api/admin/users/${auditUserId}/reset-password`, {
    password: 'resetpass456',
  }, { Authorization: `Bearer ${adminToken}` });
  test('Audit: password reset performed (operation succeeds)', auditReset.status === 200,
    `Status: ${auditReset.status}`);

  const auditList = await request('GET', '/api/admin/audit-logs?limit=30', null, { Authorization: `Bearer ${adminToken}` });
  test('Audit: logs endpoint returns data', auditList.status === 200 && Array.isArray(auditList.body.data),
    `Status: ${auditList.status}, Entries: ${auditList.body.data?.length}`);

  const auditEntries = auditList.body.data || [];
  const auditResetEntry = auditEntries.find((l) => l.action.includes('reset-password'));
  test('Audit: reset-password action logged', !!auditResetEntry, `Action: ${auditResetEntry?.action}`);
  test('Audit: admin_id recorded', !!auditResetEntry && auditResetEntry.admin_id === adminId,
    `Logged admin: ${auditResetEntry?.admin_id}`);

  const auditDetailsStr = auditResetEntry ? JSON.stringify(auditResetEntry.details) : '';
  test('Audit: password value never stored in details',
    auditDetailsStr !== '' && !auditDetailsStr.includes('resetpass456') && !auditDetailsStr.includes('auditpass123'),
    `Details leaked: ${auditDetailsStr.includes('resetpass456')}`);

  const auditUserEntry = auditEntries.find((l) => l.action.includes('POST /api/admin/users'));
  test('Audit: employee-creation action logged', !!auditUserEntry, `Action: ${auditUserEntry?.action}`);
  test('Audit: target user captured on user operations',
    auditUserEntry && (auditUserEntry.target_user_id === auditUserId || auditEntries.some((l) => l.target_user_id === auditUserId)),
    `Expected: ${auditUserId}`);

  const auditCleanup = await request('DELETE', `/api/admin/users/${auditUserId}`, null, {
    Authorization: `Bearer ${adminToken}`,
  });
  test('Audit: temp employee cleaned up', auditCleanup.status === 200, `Status: ${auditCleanup.status}`);

  console.log('\n16. Device Trust Token\n');

  const ipForTrust = await request('POST', '/api/admin/settings/ip', {
    office_public_ip: '127.0.0.1',
  }, { Authorization: `Bearer ${adminToken}` });
  test('Trust test: office IP set to localhost', ipForTrust.status === 200, `Status: ${ipForTrust.status}`);

  const trReg = await request('POST', '/api/device/register', {
    device_uuid: 'trust-dev-001',
    device_info: 'trust test device',
  }, { Authorization: `Bearer ${token}` });
  const trustSecret = trReg.body.data?.device_secret;
  const trustSetCookie = trReg.headers['set-cookie'];
  const trustCookieArr = Array.isArray(trustSetCookie) ? trustSetCookie : (trustSetCookie ? [trustSetCookie] : []);
  const trustCookieLine = trustCookieArr.find((c) => c.includes('device_trust=')) || '';
  const trustToken = trustCookieLine.split(';')[0].replace('device_trust=', '');
  test('Device trust: registration returns signed trust cookie',
    trReg.status === 200 && !!trustToken,
    `Status: ${trReg.status}, Cookie set: ${!!trustToken}`);
  test('Device trust: cookie is HttpOnly + SameSite=Lax',
    /HttpOnly/i.test(trustCookieLine) && /SameSite=Lax/i.test(trustCookieLine),
    trustCookieLine);
  test('Device trust: cookie is NOT readable via JSON body', !JSON.stringify(trReg.body).includes('device_trust'),
    'Body exposes only bound_device_id/trust_level');

  const ciTrusted = await request('POST', '/api/attendance/clock-in', null, {
    Authorization: `Bearer ${token}`,
    'X-Device-UUID': 'trust-dev-001',
    Cookie: `device_trust=${trustToken}`,
  });
  test('Device trust: clock-in with valid signed cookie is TRUSTED',
    ciTrusted.status === 200 && ciTrusted.body.data?.device_trust === 'trusted' && !!ciTrusted.body.data?.log_id,
    `Status: ${ciTrusted.status}, Trust: ${ciTrusted.body.data?.device_trust}`);

  const coTrusted = await request('POST', '/api/attendance/clock-out', null, {
    Authorization: `Bearer ${token}`,
    'X-Device-UUID': 'trust-dev-001',
    Cookie: `device_trust=${trustToken}`,
  });
  test('Device trust: clock-out with valid signed cookie succeeds',
    coTrusted.status === 200 && coTrusted.body.data?.device_trust === 'trusted',
    `Status: ${coTrusted.status}`);

  const ciMismatch = await request('POST', '/api/attendance/clock-in', null, {
    Authorization: `Bearer ${token}`,
    'X-Device-UUID': 'some-other-device',
    Cookie: `device_trust=${trustToken}`,
  });
  test('Device trust: cookie bound to another device REJECTED',
    ciMismatch.status === 403 && ciMismatch.body.error_code === 'DEVICE_TRUST_MISMATCH',
    `Status: ${ciMismatch.status}, Code: ${ciMismatch.body.error_code}`);

  const ciRecovery = await request('POST', '/api/attendance/clock-in', null, {
    Authorization: `Bearer ${token}`,
    'X-Device-UUID': 'trust-dev-001',
    'X-Device-Secret': trustSecret || '',
    Cookie: 'device_trust=Fake.Signed.Token',
  });
  const recoverCookie = ciRecovery.headers['set-cookie'];
  const recoverArr = Array.isArray(recoverCookie) ? recoverCookie : (recoverCookie ? [recoverCookie] : []);
  const recoverLine = recoverArr.find((c) => c.includes('device_trust=')) || '';
  test('Device trust: missing/invalid cookie uses office-IP recovery + re-mints cookie',
    ciRecovery.status === 200 && ciRecovery.body.data?.device_trust === 'recovered' && /device_trust=/.test(recoverLine),
    `Status: ${ciRecovery.status}, Trust: ${ciRecovery.body.data?.device_trust}, Remint: ${/device_trust=/.test(recoverLine)}`);

  const recoverToken = recoverLine.split(';')[0].replace('device_trust=', '');
  const coRecovered = await request('POST', '/api/attendance/clock-out', null, {
    Authorization: `Bearer ${token}`,
    'X-Device-UUID': 'trust-dev-001',
    Cookie: `device_trust=${recoverToken}`,
  });
  test('Device trust: re-minted cookie works for clock-out (TRUSTED path)',
    coRecovered.status === 200 && coRecovered.body.data?.device_trust === 'trusted',
    `Status: ${coRecovered.status}`);

  const ciWrongUuid = await request('POST', '/api/attendance/clock-in', null, {
    Authorization: `Bearer ${token}`,
    'X-Device-UUID': 'wrong-device',
  });
  test('Device trust: unregistered uuid without trust token stays blocked',
    ciWrongUuid.status === 403 && ciWrongUuid.body.error_code === 'UNREGISTERED_DEVICE',
    `Status: ${ciWrongUuid.status}, Code: ${ciWrongUuid.body.error_code}`);

  console.log('\n17. Concurrency, Holiday/Leave Conflict & Device Reset\n');

  const s17Reset = await request('POST', `/api/admin/users/${employee.id}/reset-device`, null, {
    Authorization: `Bearer ${adminToken}`,
  });
  test('Reset: admin resets device', s17Reset.status === 200, `Status: ${s17Reset.status}`);

  const s17Revoked = await request('POST', '/api/attendance/clock-in', null, {
    Authorization: `Bearer ${token}`,
    'X-Device-UUID': 'trust-dev-001',
    Cookie: `device_trust=${recoverToken || ''}`,
  });
  test('Reset: old httpOnly trust cookie rejected on next request',
    s17Revoked.status === 403 && s17Revoked.body.error_code === 'DEVICE_TRUST_REVOKED',
    `Status: ${s17Revoked.status}, Code: ${s17Revoked.body.error_code}`);

  const s17Reg = await request('POST', '/api/device/register', {
    device_uuid: 'race-dev-01',
  }, { Authorization: `Bearer ${token}` });
  const s17CookieArr = Array.isArray(s17Reg.headers['set-cookie'])
    ? s17Reg.headers['set-cookie'] : (s17Reg.headers['set-cookie'] ? [s17Reg.headers['set-cookie']] : []);
  const s17CookieLine = s17CookieArr.find((c) => c.includes('device_trust=')) || '';
  const s17Token = s17CookieLine.split(';')[0].replace('device_trust=', '');
  test('Reset: re-registration mints a fresh cookie', s17Reg.status === 200 && !!s17Token,
    `Status: ${s17Reg.status}, Cookie: ${!!s17Token}`);

  const s17Base = {
    Authorization: `Bearer ${token}`,
    'X-Device-UUID': 'race-dev-01',
    Cookie: `device_trust=${s17Token}`,
  };
  const s17Ci = await request('POST', '/api/attendance/clock-in', null, s17Base);
  const s17Co = await request('POST', '/api/attendance/clock-out', null, s17Base);
  test('Shift: clock-in/out keep the same log and stable shift_date',
    s17Ci.status === 200 && s17Co.status === 200 &&
    s17Co.body.data?.log_id === s17Ci.body.data?.log_id && !!s17Co.body.data?.shift_date,
    `Ci: ${s17Ci.status}, Co: ${s17Co.status}, Same log: ${s17Co.body.data?.log_id === s17Ci.body.data?.log_id}`);

  const s17Punch = {
    user_id: employee.id,
    shift_date: dateStr,
    clock_in: '09:00',
    clock_out: '17:00',
    status: 'PRESENT',
    reason: 'concurrent race test',
  };
  const raceReq = [
    request('POST', '/api/admin/attendance/punch', s17Punch, { Authorization: `Bearer ${adminToken}` }),
    request('POST', '/api/admin/attendance/punch', s17Punch, { Authorization: `Bearer ${adminToken}` }),
    request('POST', '/api/admin/attendance/punch', s17Punch, { Authorization: `Bearer ${adminToken}` }),
  ];
  const raceRes = await Promise.all(raceReq);
  const raceStatuses = raceRes.map((r) => r.status);
  test('Race: 3 concurrent punches all accepted (201 create / 200 update)',
    raceStatuses.every((s) => s === 200 || s === 201), `Statuses: ${raceStatuses.join(', ')}`);

  const raceDash = await request('GET', `/api/admin/dashboard?date=${dateStr}&refresh=true`, null, {
    Authorization: `Bearer ${adminToken}`,
  });
  const raceRows = (raceDash.body.data?.attendance_today || [])
    .filter((l) => l.user && l.user.id === employee.id && l.shift_date === dateStr);
  test('Race: EXACTLY ONE row after concurrent punches', raceRows.length === 1, `Rows: ${raceRows.length}`);

  const hol17Before = await request('GET', summaryUrl, null, { Authorization: `Bearer ${adminToken}` });
  const h17Workdays = hol17Before.body.data.summary.total_workdays;
  const h17Present = hol17Before.body.data.summary.present;
  const h17OnLeave = hol17Before.body.data.summary.on_leave;

  const hol17Add = await request('POST', '/api/admin/holidays', { date: dateStr, name: 'Holiday/Leave Conflict' }, holidayAdmin);
  const hol17Id = hol17Add.body.data?.id;
  test('Conflict: holiday added on a punched workday', hol17Add.status === 201 && !!hol17Id, `Date: ${dateStr}`);

  const lv17Add = await request('POST', '/api/admin/leaves', {
    user_id: employee.id,
    start_date: dateStr,
    end_date: dateStr,
    leave_type: 'paid',
    notes: 'holiday conflict test',
  }, { Authorization: `Bearer ${adminToken}` });
  const lv17Id = lv17Add.body.data?.id;
  await request('POST', `/api/admin/leaves/${lv17Id}/status`, {
    status: 'Approved',
  }, { Authorization: `Bearer ${adminToken}` });

  const hol17After = await request('GET', summaryUrl, null, { Authorization: `Bearer ${adminToken}` });
  const h17 = hol17After.body.data.summary;
  test('Conflict: workdays drop by exactly 1 for the holiday',
    h17.total_workdays === h17Workdays - 1, `${h17Workdays} -> ${h17.total_workdays}`);
  test('Conflict: holiday+leave day not in breakdown',
    !hol17After.body.data.daily_breakdown.some((d) => d.date === dateStr), `date: ${dateStr}`);
  test('Conflict: leave on holiday NOT double-counted in on_leave',
    h17.on_leave === h17OnLeave, `${h17OnLeave} -> ${h17.on_leave}`);
  test('Conflict: previously-present holiday day removed from present exactly once (no double count)',
    h17.present === h17Present - 1, `${h17Present} -> ${h17.present}`);

  await request('DELETE', `/api/admin/leaves/${lv17Id}`, null, { Authorization: `Bearer ${adminToken}` });
  await request('DELETE', `/api/admin/holidays/${hol17Id}`, null, { Authorization: `Bearer ${adminToken}` });
  const hol17Restored = await request('GET', summaryUrl, null, { Authorization: `Bearer ${adminToken}` });
  test('Conflict: workdays restored after cleanup',
    hol17Restored.body.data.summary.total_workdays === h17Workdays,
    `Status: ${hol17Restored.status}`);

  console.log('\n13b. Fixture Cleanup\n');
  if (officeIpBefore) {
    const ipRestore = await request(
      'POST',
      '/api/admin/settings/ip',
      { office_public_ip: officeIpBefore },
      { Authorization: `Bearer ${adminToken}` }
    );
    test('Restore original office IP', ipRestore.status === 200, `Status: ${ipRestore.status}, IP: ${officeIpBefore}`);
  } else {
    test('Restore original office IP', true, 'No previous IP found');
  }

  const delE2e = await request('DELETE', `/api/admin/users/${employee.id}`, null, {
    Authorization: `Bearer ${adminToken}`,
  });
  test('Cleanup: E2E test employee deleted', delE2e.status === 200, `Status: ${delE2e.status}`);

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