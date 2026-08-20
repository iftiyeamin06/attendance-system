const assert = require('assert');
const {
  cloudflareClientIp,
  candidateIps,
  extractClientIp,
} = require('../middleware/ipValidation');

function mockReq(socketIp, headers = {}, opts = {}) {
  const { trustProxy = true, ip } = opts;
  const req = {
    headers,
    socket: { remoteAddress: socketIp },
    connection: { remoteAddress: socketIp },
    app: { get: (k) => (k === 'trust proxy' ? trustProxy : undefined) },
  };
  req.ip = ip !== undefined ? ip : socketIp;
  return req;
}

const CF = { 'cf-ray': 'abc123-SEA', 'cf-connecting-ip': '103.54.39.106' };

function run() {
  let passed = 0;
  let failed = 0;
  function t(name, fn) {
    try {
      fn();
      passed++;
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      failed++;
      console.log(`  [FAIL] ${name} -> ${err.message}`);
    }
  }

  console.log('\n--- ipValidation unit tests ---\n');

  t('Render internal proxy peer trusts CF-Connecting-IP', () => {
    assert.strictEqual(cloudflareClientIp(mockReq('10.24.6.111', CF)), '103.54.39.106');
  });

  t('Cloudflare edge peer trusts CF-Connecting-IP', () => {
    assert.strictEqual(cloudflareClientIp(mockReq('104.16.0.1', CF)), '103.54.39.106');
  });

  t('No cf-ray header -> null', () => {
    assert.strictEqual(cloudflareClientIp(mockReq('10.24.6.111', { 'cf-connecting-ip': '103.54.39.106' })), null);
  });

  t('Public non-CF peer (direct origin bypass) cannot spoof', () => {
    assert.strictEqual(cloudflareClientIp(mockReq('203.0.113.5', CF)), null);
  });

  t('Private CF-Connecting-IP is rejected', () => {
    assert.strictEqual(
      cloudflareClientIp(mockReq('10.24.6.111', { 'cf-ray': 'x-SEA', 'cf-connecting-ip': '192.168.1.5' })),
      null
    );
  });

  t('true-client-ip fallback works', () => {
    assert.strictEqual(
      cloudflareClientIp(mockReq('10.24.6.111', { 'cf-ray': 'x-SEA', 'true-client-ip': '103.54.39.106' })),
      '103.54.39.106'
    );
  });

  t('IPv6 internal proxy peer works', () => {
    assert.strictEqual(cloudflareClientIp(mockReq('fc00::1', CF)), '103.54.39.106');
  });

  t('candidateIps puts real client first on Render topology', () => {
    const ips = candidateIps(mockReq('10.24.6.111', CF, { ip: '10.24.6.111' }));
    assert.strictEqual(ips[0], '103.54.39.106');
  });

  t('extractClientIp returns real client through Render proxy', () => {
    assert.strictEqual(extractClientIp(mockReq('10.24.6.111', CF, { ip: '10.24.6.111' })), '103.54.39.106');
  });

  console.log(`\nSummary: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

run();
