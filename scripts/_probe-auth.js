const BASE = 'https://attendance-system-rc2e.onrender.com';
function getCookie(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(/,(?=[^;]+?=)/).map(c => c.split(';')[0]).join('; ') : '';
}
(async () => {
  const r1 = await fetch(`${BASE}/api/auth/login-web`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'superadmin@attendance.local', password: 'Superadmin#2026' }),
    redirect: 'manual',
  });
  const cookie = getCookie(r1);
  console.log('1. login-web:', r1.status, '->', r1.headers.get('location'), '| cookie:', cookie ? 'YES (' + cookie.slice(0, 30) + '...)' : 'NO');

  const dash = await fetch(`${BASE}/admin/dashboard`, { headers: { cookie }, redirect: 'manual' });
  console.log('2. /admin/dashboard with session:', dash.status, dash.status === 302 ? '-> ' + dash.headers.get('location') : '(page served)');

  const out = await fetch(`${BASE}/logout`, { headers: { cookie }, redirect: 'manual' });
  console.log('3. logout:', out.status, '->', out.headers.get('location'));

  const after = await fetch(`${BASE}/admin/dashboard`, { headers: { cookie }, redirect: 'manual' });
  console.log('4. dashboard with OLD cookie post-logout:', after.status, after.status === 302 ? '-> ' + after.headers.get('location') : '(STILL SERVED - BUG)');

  const noAuth = await fetch(`${BASE}/employee/dashboard`, { redirect: 'manual' });
  console.log('5. /employee/dashboard with NO cookie:', noAuth.status, '->', noAuth.headers.get('location'));
})();