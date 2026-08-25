async function main() {
  const BASE = 'https://attendance-system-rc2e.onrender.com';
  
  // 1. Login as superadmin
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'superadmin@attendance.local', password: 'Superadmin#2026' }),
  });
  const loginData = await loginRes.json();
  if (!loginData.token) {
    console.log('Superadmin login failed:', loginData);
    return;
  }
  const token = loginData.token;
  console.log('Superadmin token acquired');
  
  // 2. Get all users
  const usersRes = await fetch(`${BASE}/api/admin/users`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const usersData = await usersRes.json();
  console.log('\nAll users:');
  usersData.data.forEach(u => console.log(`  ${u.email} (${u.role}) id=${u.id} name=${u.name}`));
  
  // 3. Find ifti@attendance.local
  const target = usersData.data.find(u => u.email === 'ifti@attendance.local');
  if (!target) {
    console.log('\nNo ifti@attendance.local found');
    return;
  }
  console.log(`\nFound target: ${target.email} id=${target.id}`);
  
  // 4. Delete that user
  const delRes = await fetch(`${BASE}/api/admin/users/${target.id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const delData = await delRes.json();
  console.log('\nDelete result:', delData);
  
  // 5. Verify removal
  const verifyRes = await fetch(`${BASE}/api/admin/users`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const verifyData = await verifyRes.json();
  console.log('\nRemaining users:');
  verifyData.data.forEach(u => console.log(`  ${u.email} (${u.role})`));
}

main().catch(e => console.error('Error:', e));