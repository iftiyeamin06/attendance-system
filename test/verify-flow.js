const http = require('http');
const querystring = require('querystring');

async function request(method, path, body, headers = {}) {
  const data = body ? querystring.stringify(body) : null;
  const allHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...headers,
  };
  if (data) allHeaders['Content-Length'] = Buffer.byteLength(data);

  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: 3000, path, method, headers: allHeaders },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            cookie: res.headers['set-cookie']?.[0]?.split(';')[0],
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
  console.log('=== Step 1: GET /login ===');
  const loginPage = await request('GET', '/login');
  console.log('Status:', loginPage.status);
  const formAction = loginPage.body.match(/action="([^"]+)"/)?.[1];
  console.log('Form posts to:', formAction);
  const demo = loginPage.body.match(/Demo: ([^<\n]+)/)?.[1];
  console.log('Demo credentials:', demo);

  console.log('\n=== Step 2: POST /api/auth/login-web ===');
  const loginResp = await request('POST', '/api/auth/login-web', {
    email: 'employee@attendance.local',
    password: 'employee123',
  });
  console.log('Status:', loginResp.status);
  console.log('Redirect Location:', loginResp.location);
  console.log('Session cookie set:', loginResp.cookie ? 'YES' : 'NO');

  console.log('\n=== Step 3: GET /employee/dashboard ===');
  const dashboard = await request('GET', '/employee/dashboard', null, {
    Cookie: loginResp.cookie,
  });
  console.log('Status:', dashboard.status);
  const title = dashboard.body.match(/<title>([^<]+)<\/title>/)?.[1];
  console.log('Page title:', title);
  const h1 = dashboard.body.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1];
  console.log('H1:', h1);

  console.log('\n=== Step 4: GET /admin/dashboard (with employee session) ===');
  const adminDash = await request('GET', '/admin/dashboard', null, {
    Cookie: loginResp.cookie,
  });
  console.log('Status:', adminDash.status);
  const adminTitle = adminDash.body.match(/<title>([^<]+)<\/title>/)?.[1];
  console.log('Page title:', adminTitle);
  console.log('Redirect Location:', adminDash.location);

  process.exit(0);
})();
