async function main() {
  const BASE = 'http://localhost:3000';
  const jar = {}; // simulate browser cookie jar

  function parseCookies(headers) {
    const setCookies = headers.getSetCookie ? headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const [name, val] = pair.split('=');
      jar[name.trim()] = val.trim();
    }
  }
  function cookieHeader() {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // 1. Reset device for ifti
  const saLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'superadmin@attendance.local', password: 'Superadmin#2026' }),
  });
  const sa = await saLogin.json();
  const users = await (await fetch(`${BASE}/api/admin/users`, { headers: { Authorization: `Bearer ${sa.token}` } })).json();
  const ifti = users.data.find(u => u.email === 'iftiyeamin06@gmail.com');
  const resetRes = await (await fetch(`${BASE}/api/admin/users/${ifti.id}/reset-device`, {
    method: 'POST', headers: { Authorization: `Bearer ${sa.token}` },
  })).json();
  console.log('1. Reset:', resetRes.message, '| closed_logs:', resetRes.closed_logs);

  // 2. Login as ifti
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'iftiyeamin06@gmail.com', password: 'pass123' }),
  });
  parseCookies(login.headers);
  const d = await login.json();
  const token = d.token;
  console.log('2. Login OK');

  const freshId = 'device_fresh_' + Date.now();

  async function api(method, path, body) {
    const hdrs = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Device-UUID': freshId,
      Cookie: cookieHeader(),
    };
    const opts = { method, headers: hdrs, credentials: 'include' };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(`${BASE}${path}`, opts);
    parseCookies(r.headers);
    return r.json();
  }

  // 3. Clock in (auto-binds)
  let r = await api('POST', '/api/attendance/clock-in');
  console.log('3. Clock-in:', r.success, r.message || r.error_code);

  // 4. Clock out (trust cookie sent automatically)
  r = await api('POST', '/api/attendance/clock-out');
  console.log('4. Clock-out:', r.success, r.message || r.error_code);

  // 5. Clock in again
  r = await api('POST', '/api/attendance/clock-in');
  console.log('5. Clock-in again:', r.success, r.message || r.error_code);

  // 6. Clock out again
  r = await api('POST', '/api/attendance/clock-out');
  console.log('6. Clock-out again:', r.success, r.message || r.error_code);

  // Cleanup
  if (!r.success) await api('POST', '/api/attendance/clock-out');
}

main().catch(e => console.error('Error:', e));