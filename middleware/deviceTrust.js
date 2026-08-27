const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'device_trust';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function secret() {
  return process.env.DEVICE_TRUST_SECRET || process.env.JWT_SECRET || 'attendance_device_secret';
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function signTrust(userId, deviceUuid) {
  return jwt.sign({ sub: userId, dev: deviceUuid }, secret(), { expiresIn: '30d' });
}

function verifyTrust(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return jwt.verify(value, secret());
  } catch (err) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(/;\s*/).forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      out[decodeURIComponent(pair.slice(0, idx).trim())] = decodeURIComponent(pair.slice(idx + 1));
    }
  });
  return out;
}

function getTrustFromRequest(req) {
  return verifyTrust(parseCookies(req)[COOKIE_NAME]);
}

function setTrustOnResponse(res, userId, deviceUuid) {
  res.cookie(COOKIE_NAME, signTrust(userId, deviceUuid), {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

function clearTrustOnResponse(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

module.exports = {
  COOKIE_NAME,
  getTrustFromRequest,
  setTrustOnResponse,
  clearTrustOnResponse,
};