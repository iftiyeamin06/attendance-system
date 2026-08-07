const http = require('http');
const querystring = require('querystring');

function request(method, path, body, cookie) {
  return new Promise((resolve) => {
    let postData = '';
    const headers = {};

    if (body && typeof body === 'object') {
      postData = querystring.stringify(body);
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(postData);
    }
    if (cookie) headers['Cookie'] = cookie;

    const req = http.request(
      { hostname: 'localhost', port: 3000, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const cookie = res.headers['set-cookie']?.[0]?.split(';')[0];
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            setCookie: cookie,
            body: data,
          });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (postData) req.write(postData);
    req.end();
  });
}

(async () => {
  console.log('=== Employee Login Flow ===');

  // Step 1: Load employee login page
  const empLoginPage = await request('GET', '/login');
  console.log('1. Employee login page loaded:', empLoginPage.status);

  // Step 2: Submit login form
  const loginResp = await request('POST', '/api/auth/login-web', {
    email: 'employee@attendance.local',
    password: 'employee123',
  });
  const cookie = loginResp.setCookie;
  console.log('2. Login submitted:', loginResp.status);
  console.log('   Redirect to:', loginResp.location);
  console.log('   Cookie set:', cookie ? 'YES' : 'NO');

  // Step 3: Follow redirect to dashboard
  if (loginResp.location) {
    const dashboard = await request('GET', loginResp.location, null, cookie);
    console.log('3. Dashboard loaded:', dashboard.status);
    const title = dashboard.body.match(/<title>([^<]+)<\/title>/)?.[1];
    console.log('   Title:', title);
    const token = dashboard.body.match(/const AUTH_TOKEN = '([^']+)'/)?.[1];
    console.log('   Token embedded:', token ? 'YES (len=' + token.length + ')' : 'NO');
  }

  console.log('\n=== Admin Login Flow ===');

  // Step 1: Load admin login page
  const adminLoginPage = await request('GET', '/admin/login');
  console.log('1. Admin login page loaded:', adminLoginPage.status);

  // Step 2: Submit login form
  const adminLoginResp = await request('POST', '/api/auth/admin-login-web', {
    email: 'admin@attendance.local',
    password: 'admin123',
  });
  const adminCookie = adminLoginResp.setCookie;
  console.log('2. Login submitted:', adminLoginResp.status);
  console.log('   Redirect to:', adminLoginResp.location);
  console.log('   Cookie set:', adminCookie ? 'YES' : 'NO');

  // Step 3: Follow redirect to dashboard
  if (adminLoginResp.location) {
    const adminDashboard = await request('GET', adminLoginResp.location, null, adminCookie);
    console.log('3. Admin dashboard loaded:', adminDashboard.status);
    const title = adminDashboard.body.match(/<title>([^<]+)<\/title>/)?.[1];
    console.log('   Title:', title);
    const token = adminDashboard.body.match(/const AUTH_TOKEN = '([^']+)'/)?.[1];
    console.log('   Token embedded:', token ? 'YES (len=' + token.length + ')' : 'NO');
  }
})();
