async function main() {
  const BASE = 'https://attendance-system-rc2e.onrender.com';
  
  // 1. Login as superadmin
  const saLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'superadmin@attendance.local', password: 'Superadmin#2026' }),
  });
  const saData = await saLogin.json();
  const saToken = saData.token;
  console.log('1. Superadmin login:', saToken ? 'OK' : 'FAIL');

  // 2. Find ifti user ID
  const usersRes = await fetch(`${BASE}/api/admin/users`, {
    headers: { 'Authorization': `Bearer ${saToken}` },
  });
  const usersData = await usersRes.json();
  const ifti = usersData.data.find(u => u.email === 'iftiyeamin06@gmail.com');
  console.log('2. ifti user:', ifti ? `${ifti.id} device=${ifti.bound_device_id}` : 'NOT FOUND');

  // 3. Reset device binding for ifti
  const resetRes = await fetch(`${BASE}/api/admin/users/${ifti.id}/reset-device`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${saToken}` },
  });
  const resetData = await resetRes.json();
  console.log('3. Reset device:', resetData.success, resetData.message);

  // 4. Verify device is cleared
  const verifyRes = await fetch(`${BASE}/api/admin/users`, {
    headers: { 'Authorization': `Bearer ${saToken}` },
  });
  const verifyData = await verifyRes.json();
  const iftiAfter = verifyData.data.find(u => u.email === 'iftiyeamin06@gmail.com');
  console.log('4. After reset:', `${iftiAfter.email} device=${iftiAfter.bound_device_id}`);

  // 5. Login as ifti
  const iftiLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'iftiyeamin06@gmail.com', password: 'pass123' }),
  });
  const iftiData = await iftiLogin.json();
  const iftiToken = iftiData.token;
  console.log('5. ifti login:', iftiToken ? 'OK' : 'FAIL');

  // 6. Generate a fresh deviceId (simulating browser behavior)
  const freshDeviceId = 'device_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
  console.log('6. Fresh deviceId:', freshDeviceId);

  // 7. Clock in (should auto-bind)
  const clockInRes = await fetch(`${BASE}/api/attendance/clock-in`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${iftiToken}`,
      'X-Device-UUID': freshDeviceId,
    },
    credentials: 'include',
  });
  const clockInData = await clockInRes.json();
  console.log('7. Clock-in:', clockInData.success, clockInData.message);
  if (clockInData.data) {
    console.log('   device_id:', clockInData.data.device_id);
    console.log('   device_secret:', clockInData.data.device_secret ? 'YES (len=' + clockInData.data.device_secret.length + ')' : 'NULL');
  }
  
  // Check Set-Cookie
  const setCookie = clockInRes.headers.get('set-cookie');
  console.log('   Set-Cookie:', setCookie ? setCookie.substring(0, 80) + '...' : 'NONE');
  const hasTrustCookie = setCookie && setCookie.includes('device_trust');
  console.log('   device_trust cookie set:', hasTrustCookie);

  // 8. Extract the device secret from response
  const deviceSecret = clockInData.data?.device_secret;
  const boundDeviceId = clockInData.data?.device_id || freshDeviceId;

  // 9. Clock out WITH credentials and secret
  const clockOutRes = await fetch(`${BASE}/api/attendance/clock-out`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${iftiToken}`,
      'X-Device-UUID': boundDeviceId,
      ...(deviceSecret ? { 'X-Device-Secret': deviceSecret } : {}),
    },
    credentials: 'include',
  });
  const clockOutData = await clockOutRes.json();
  console.log('8. Clock-out:', clockOutData.success, clockOutData.message, clockOutData.error_code || '');

  // 10. Now test WITHOUT the secret header (trusting cookie only)
  const clockIn2Res = await fetch(`${BASE}/api/attendance/clock-in`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${iftiToken}`,
      'X-Device-UUID': boundDeviceId,
    },
    credentials: 'include',
  });
  const clockIn2Data = await clockIn2Res.json();
  console.log('9. Second clock-in (no secret header):', clockIn2Data.success, clockIn2Data.message);

  const clockOut2Res = await fetch(`${BASE}/api/attendance/clock-out`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${iftiToken}`,
      'X-Device-UUID': boundDeviceId,
    },
    credentials: 'include',
  });
  const clockOut2Data = await clockOut2Res.json();
  console.log('10. Second clock-out (no secret header):', clockOut2Data.success, clockOut2Data.message, clockOut2Data.error_code || '');
}

main().catch(e => console.error('Error:', e));