const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'device_trust';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function secret() {
  const s = process.env.DEVICE_TRUST_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('Missing DEVICE_TRUST_SECRET / JWT_SECRET — refusing to sign device_trust with hardcoded fallback');
  return s;
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
    secure: isProduction(),
    sameSite: isProduction() ? 'none' : 'lax',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

function clearTrustOnResponse(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: isProduction() ? 'none' : 'lax',
    path: '/',
  });
}

module.exports = {
  COOKIE_NAME,
  getTrustFromRequest,
  setTrustOnResponse,
  clearTrustOnResponse,
};