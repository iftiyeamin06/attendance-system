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
  console.log('=== What if ADMIN creds are typed into EMPLOYEE form? ===');

  const login = await request('POST', '/api/auth/login-web', {
    email: 'admin@attendance.local',
    password: 'admin123',
  });
  console.log('Status:', login.status);
  console.log('Redirect:', login.location);
  console.log('This lands on:', login.location);
  console.log('=> This is EXPECTED behavior if admin creds are used on employee login form');

  console.log('\n=== What if EMPLOYEE creds are typed into ADMIN form? ===');
  const adminLogin = await request('POST', '/api/auth/admin-login-web', {
    email: 'employee@attendance.local',
    password: 'employee123',
  });
  console.log('Status:', adminLogin.status);
  console.log('This shows:', adminLogin.body.match(/Invalid credentials/) ? 'Invalid credentials (expected)' : 'something else');
  console.log('=> EMPLOYEE cannot login via admin form (by design)');

  process.exit(0);
})();
