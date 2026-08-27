async function main() {
  const BASE = 'http://localhost:3000';
  const jar = {};
  function parseCookies(headers) {
    for (const sc of headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const [name, val] = pair.split('=');
      jar[name.trim()] = val.trim();
    }
  }
  function cookieHeader() {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // 1. Reset device
  const saLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'superadmin@attendance.local', password: 'Superadmin#2026' }),
  });
  const sa = await saLogin.json();
  const users = await (await fetch(`${BASE}/api/admin/users`, { headers: { Authorization: `Bearer ${sa.token}` } })).json();
  const ifti = users.data.find(u => u.email === 'iftiyeamin06@gmail.com');
  await fetch(`${BASE}/api/admin/users/${ifti.id}/reset-device`, {
    method: 'POST', headers: { Authorization: `Bearer ${sa.token}` },
  });
  console.log('1. Device reset done');

  // 2. Login as ifti
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'iftiyeamin06@gmail.com', password: 'pass123' }),
  });
  parseCookies(login.headers);
  const d = await login.json();
  console.log('2. Login OK');

  const freshId = 'device_live_' + Date.now();

  // 3. Clock in (auto-binds, sets trust cookie)
  const ciResp = await fetch(`${BASE}/api/attendance/clock-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.token}`, 'X-Device-UUID': freshId, Cookie: cookieHeader() },
    credentials: 'include',
  });
  parseCookies(ciResp.headers);
  const ciData = await ciResp.json();
  const newSecret = ciData.data?.device_secret;
  console.log('3. Clock-in:', ciData.success, '| new secret:', newSecret ? 'YES' : 'NO', '| trust:', ciData.data?.device_trust);

  // 4. Clock out WITH trust cookie
  const co1 = await fetch(`${BASE}/api/attendance/clock-out`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.token}`, 'X-Device-UUID': freshId, Cookie: cookieHeader() },
    credentials: 'include',
  });
  parseCookies(co1.headers);
  const co1Data = await co1.json();
  console.log('4. Clock-out (trust cookie):', co1Data.success, co1Data.message, co1Data.error_code || '');

  // 5. NOW simulate the LIVE scenario: clock in again, then clock out WITHOUT trust cookie but with WRONG secret
  const ci2 = await fetch(`${BASE}/api/attendance/clock-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.token}`, 'X-Device-UUID': freshId, Cookie: cookieHeader() },
    credentials: 'include',
  });
  parseCookies(ci2.headers);
  const ci2Data = await ci2.json();
  const secret2 = ci2Data.data?.device_secret;
  console.log('5. Clock-in again:', ci2Data.success, '| trust:', ci2Data.data?.device_trust);

  // 6. Clock out WITHOUT trust cookie and with WRONG secret (simulating live bug)
  const co2 = await fetch(`${BASE}/api/attendance/clock-out`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.token}`, 'X-Device-UUID': freshId },
    // No Cookie header = no trust cookie
    // No X-Device-Secret = wrong/missing secret
  });
  const co2Data = await co2.json();
  console.log('6. Clock-out (NO cookie, NO secret):', co2Data.success, co2Data.message, co2Data.error_code || '', '| new_secret:', co2Data.data?.device_secret ? 'YES' : 'NO');
}

main().catch(e => console.error('Error:', e));