const http = require('http');
const querystring = require('querystring');

async function request(method, path, body, cookie) {
  return new Promise((resolve) => {
    const data = body ? querystring.stringify(body) : null;
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (cookie) headers['Cookie'] = cookie;

    const req = http.request(
      { hostname: 'localhost', port: 3000, path, method, headers },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          const newCookie = res.headers['set-cookie']?.[0]?.split(';')[0];
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            cookie: newCookie || cookie,
            body: chunks,
          });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  let cookie = '';

  console.log('=== SCENARIO: User was previously logged in as ADMIN ===');

  // Step 1: Admin logs in
  console.log('\n1. Admin login...');
  const adminLogin = await request('POST', '/api/auth/admin-login-web', {
    email: 'admin@attendance.local',
    password: 'admin123',
  }, cookie);
  cookie = adminLogin.cookie;
  console.log('   Status:', adminLogin.status, '| Redirect:', adminLogin.location);
  console.log('   Cookie now:', cookie);

  // Step 2: Admin visits admin dashboard
  console.log('\n2. Admin visits dashboard...');
  const adminDash = await request('GET', '/admin/dashboard', null, cookie);
  console.log('   Status:', adminDash.status, '| Title:', adminDash.body.match(/<title>([^<]+)<\/title>/)?.[1]);

  // Step 3: Admin logs out
  console.log('\n3. Admin logs out...');
  const logout = await request('GET', '/logout', null, cookie);
  cookie = logout.cookie || '';
  console.log('   Status:', logout.status, '| Redirect:', logout.location);
  console.log('   Cookie now:', cookie || '(cleared)');

  // Step 4: Employee logs in (same browser)
  console.log('\n4. Employee logs in (same browser)...');
  const empLogin = await request('POST', '/api/auth/login-web', {
    email: 'employee@attendance.local',
    password: 'employee123',
  }, cookie);
  cookie = empLogin.cookie;
  console.log('   Status:', empLogin.status, '| Redirect:', empLogin.location);
  console.log('   Cookie now:', cookie);

  // Step 5: Follow redirect
  console.log('\n5. Following redirect...');
  const redirectTarget = empLogin.location;
  const result = await request('GET', redirectTarget, null, cookie);
  console.log('   URL:', redirectTarget);
  console.log('   Status:', result.status);
  console.log('   Final URL:', result.location || redirectTarget);
  const title = result.body.match(/<title>([^<]+)<\/title>/)?.[1];
  console.log('   Title:', title);

  console.log('\n=== RESULT ===');
  if (redirectTarget === '/employee/dashboard') {
    console.log('Employee correctly lands on /employee/dashboard ✓');
  } else {
    console.log('ISSUE: Employee landed on', redirectTarget, 'instead of /employee/dashboard ✗');
  }
  process.exit(0);
})();
