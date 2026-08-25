async function main() {
  const BASE = 'https://attendance-system-rc2e.onrender.com';
  
  // 1. Login
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'iftiyeamin06@gmail.com', password: 'pass123' }),
  });
  console.log('Login status:', loginRes.status);
  const loginData = await loginRes.json();
  console.log('Login response:', JSON.stringify(loginData, null, 2));
  
  if (!loginData.token) {
    console.log('No token received');
    return;
  }
  
  const token = loginData.token;
  
  // 2. Fetch attendance logs
  const logsRes = await fetch(`${BASE}/api/attendance/logs`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  console.log('\nLogs status:', logsRes.status);
  const logsData = await logsRes.json();
  console.log('Logs response:', JSON.stringify(logsData, null, 2));
  
  // 3. Also fetch today status
  const todayRes = await fetch(`${BASE}/api/attendance/today`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  console.log('\nToday status:', todayRes.status);
  const todayData = await todayRes.json();
  console.log('Today response:', JSON.stringify(todayData, null, 2));
}

main().catch(e => console.error('Error:', e));