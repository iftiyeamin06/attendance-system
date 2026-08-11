const { AuditLog } = require('../models');

const SENSITIVE_KEYS = ['password', 'temp_password', 'temporary_password', 'reset_token', 'token', 'authorization', 'bound_device_id', 'device_uuid'];

function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_KEYS.includes(key.toLowerCase())) {
      out[key] = '***';
      continue;
    }
    const v = obj[key];
    out[key] = (v && typeof v === 'object') ? sanitizeObject(v) : v;
  }
  return out;
}

function resolveTargetUserId(req) {
  const candidates = [
    req.params && req.params.userId,
    req.params && req.params.leaveId,
    req.params && req.params.holidayId,
    req.params && req.params.logId,
    req.body && req.body.user_id,
    req.body && req.body.userId,
  ];
  const found = candidates.find((c) => typeof c === 'string' && c.length > 0);
  return found || null;
}

function auditMiddleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  res.on('finish', () => {
    try {
      const routePath = req.route ? req.baseUrl + req.route.path : req.baseUrl + req.path;
      const action = `${req.method} ${routePath}`;
      const details = JSON.stringify({
        status: res.statusCode,
        params: sanitizeObject(req.params),
        body: sanitizeObject(req.body),
        ip: req.ip,
      });

      AuditLog.create({
        adminId: (req.user && req.user.id) || null,
        action,
        targetUserId: resolveTargetUserId(req),
        details,
      }).catch((err) => console.error('Audit log insert error:', err));
    } catch (err) {
      console.error('Audit log capture error:', err);
    }
  });

  next();
}

module.exports = auditMiddleware;