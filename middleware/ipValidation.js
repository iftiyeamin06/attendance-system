const cache = require('../redis/cache');
const { Setting } = require('../models');

function normalizeIp(ip) {
  if (!ip) return ip;
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return '127.0.0.1';
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
}

async function ipValidationMiddleware(req, res, next) {
  const rawClientIp = extractClientIp(req);
  const clientIp = normalizeIp(rawClientIp);

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

  const normalizedAllowedIp = normalizeIp(allowedIp);

  if (clientIp !== normalizedAllowedIp) {
    return res.status(403).json({
      success: false,
      message: 'Clock-in failed. Please connect to the Official Office Wi-Fi.',
      error_code: 'OFFICE_IP_MISMATCH',
    });
  }

  req.ipValidationResult = { valid: true, clientIp, allowedIp };
  next();
}

function extractClientIp(req) {
  return (
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.connection?.socket?.remoteAddress ||
    'unknown'
  );
}

module.exports = { ipValidationMiddleware, extractClientIp };
