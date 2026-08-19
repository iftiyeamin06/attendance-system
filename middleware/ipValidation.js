const cache = require('../redis/cache');
const { Setting } = require('../models');

// Cloudflare's published edge IP ranges. The app verifies the direct peer is a
// Cloudflare edge before trusting CF-Connecting-IP, so a client that connects
// to the origin directly (bypassing Cloudflare) cannot spoof the office IP.
const CLOUDFLARE_IPV4_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_IPV6_RANGES = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

function normalizeIp(ip) {
  if (!ip) return ip;
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
}

function ipToBigInt(ip) {
  if (ip.includes(':')) {
    let parts;
    if (ip.includes('::')) {
      const [left, right] = ip.split('::');
      const l = left ? left.split(':') : [];
      const r = right ? right.split(':') : [];
      const missing = 8 - l.length - r.length;
      if (missing < 1) return null;
      parts = [...l, ...Array(missing).fill('0'), ...r];
    } else {
      parts = ip.split(':');
    }
    if (parts.length !== 8) return null;
    let v = 0n;
    for (const p of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      v = (v << 16n) | BigInt(parseInt(p, 16));
    }
    return v;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = parseInt(p, 10);
    if (n < 0 || n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function ipInCidr(ip, cidr) {
  const isV6 = cidr.includes(':');
  const idx = cidr.indexOf('/');
  const net = cidr.slice(0, idx);
  const bits = parseInt(cidr.slice(idx + 1), 10);
  const width = isV6 ? 128 : 32;
  if (bits < 0 || bits > width) return false;
  const addr = ipToBigInt(ip);
  const network = ipToBigInt(net);
  if (addr === null || network === null) return false;
  const mask = ((1n << BigInt(width)) - 1n) ^ ((1n << BigInt(width - bits)) - 1n);
  return (addr & mask) === (network & mask);
}

function isCloudflareEdgeIp(ip) {
  const n = normalizeIp(ip);
  if (!n) return false;
  if (n.includes(':')) return CLOUDFLARE_IPV6_RANGES.some((r) => ipInCidr(n, r));
  return CLOUDFLARE_IPV4_RANGES.some((r) => ipInCidr(n, r));
}

// Returns the real client IP from Cloudflare's CF-Connecting-IP header, but only
// when the request genuinely arrived through Cloudflare (cf-ray present AND the
// direct peer is a Cloudflare edge IP). Otherwise returns null so the caller
// falls back to the proxy-derived address.
function cloudflareClientIp(req) {
  if (!req.headers['cf-ray']) return null;
  const peer = normalizeIp(req.ip || req.socket?.remoteAddress || '');
  if (!peer || !isCloudflareEdgeIp(peer)) return null;
  const cfIp = req.headers['cf-connecting-ip'] || req.headers['true-client-ip'];
  if (!cfIp || typeof cfIp !== 'string') return null;
  return normalizeIp(cfIp.split(',')[0].trim());
}

// When a trusted reverse proxy is configured (e.g. production/Render with
// TRUST_PROXY=true), Express derives req.ip from the LAST X-Forwarded-For entry
// appended by the proxy, which a client cannot spoof. Reading
// req.headers['x-forwarded-for'] directly is unsafe: its FIRST entry is fully
// client-controlled, so it must not be used for the office-IP check or audit.
function usesTrustProxy(req) {
  return !!req.app.get('trust proxy');
}

async function ipValidationMiddleware(req, res, next) {
  let allowedIp;

  allowedIp = await cache.getOfficeIP();

  if (!allowedIp) {
    const setting = await Setting.findOne({ where: { key: 'office_public_ip' } });
    if (setting) {
      allowedIp = setting.value;
      await cache.setOfficeIP(allowedIp);
    }
  }

  if (!allowedIp) {
    allowedIp = process.env.OFFICE_PUBLIC_IP;
  }

  const allowedIps = [...new Set([allowedIp, process.env.OFFICE_PUBLIC_IP].filter(Boolean))]
    .map(normalizeIp);

  const detectedIps = candidateIps(req);

  const matched = detectedIps.some((ip) => allowedIps.includes(ip));

  if (!matched) {
    return res.status(403).json({
      success: false,
      message: 'Clock-in failed. Please connect to the Official Office Wi-Fi.',
      error_code: 'OFFICE_IP_MISMATCH',
      detected_ips: detectedIps,
      allowed_ips: allowedIps,
    });
  }

  req.ipValidationResult = { valid: true, clientIp: detectedIps[0], allowedIps };
  next();
}

function extractClientIp(req) {
  const cfClient = cloudflareClientIp(req);
  if (cfClient) return cfClient;

  if (usesTrustProxy(req)) {
    return normalizeIp(
      req.ip ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      req.connection?.socket?.remoteAddress ||
      'unknown'
    );
  }

  // No trusted proxy: the socket address is the direct client. X-Forwarded-For
  // is only a fallback for deployments sitting behind a proxy the app does not
  // trust (where it cannot be used as a security boundary anyway).
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (first) return normalizeIp(first);
  }
  return normalizeIp(
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.connection?.socket?.remoteAddress ||
    'unknown'
  );
}

function candidateIps(req) {
  const candidates = [];
  const cfClient = cloudflareClientIp(req);
  if (cfClient) candidates.push(cfClient);

  if (usesTrustProxy(req)) {
    const ip = extractClientIp(req);
    if (ip && ip !== 'unknown' && !candidates.includes(ip)) candidates.push(ip);
    return candidates;
  }

  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    forwarded.split(',').forEach((p) => {
      const ip = normalizeIp(p.trim());
      if (ip && ip !== 'unknown' && !candidates.includes(ip)) candidates.push(ip);
    });
  }
  const local = extractClientIp(req);
  if (local && !candidates.includes(local)) candidates.push(local);
  return candidates;
}

module.exports = { ipValidationMiddleware, extractClientIp, candidateIps, cloudflareClientIp };
