const cache = require('../redis/cache');
const { Setting } = require('../models');

function normalizeIp(ip) {
  if (!ip) return ip;
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
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

  if (usesTrustProxy(req)) {
    const ip = extractClientIp(req);
    if (ip && ip !== 'unknown') candidates.push(ip);
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

module.exports = { ipValidationMiddleware, extractClientIp, candidateIps };
