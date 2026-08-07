const http = require('http');

function fetchPage(path) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: 3000, path, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            title: body.match(/<title>([^<]+)<\/title>/)?.[1] || 'NOT FOUND',
            formAction: body.match(/action="([^"]+)"/)?.[1] || 'NOT FOUND',
            demo: body.match(/Demo: ([^<\n]+)/)?.[1] || 'NOT FOUND',
          });
        });
      }
    );
    req.end();
  });
}

(async () => {
  const emp = await fetchPage('/login');
  const admin = await fetchPage('/admin/login');

  console.log('Employee login page:');
  console.log('  Status:', emp.status);
  console.log('  Title:', emp.title);
  console.log('  Form action:', emp.formAction);
  console.log('  Demo:', emp.demo);

  console.log('\nAdmin login page:');
  console.log('  Status:', admin.status);
  console.log('  Title:', admin.title);
  console.log('  Form action:', admin.formAction);
  console.log('  Demo:', admin.demo);
})();
