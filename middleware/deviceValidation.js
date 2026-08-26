const crypto = require('crypto');
const cache = require('../redis/cache');
const { getTrustFromRequest, setTrustOnResponse, clearTrustOnResponse } = require('./deviceTrust');

const REVOKE_TTL = 86400;

function hashDeviceSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

function verifyDeviceSecret(secret, storedHash) {
  if (!secret || !storedHash) return false;
  const a = Buffer.from(hashDeviceSecret(secret));
  const b = Buffer.from(String(storedHash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function generateDeviceSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

async function isTrustRevoked(userId, trust) {
  const revokedAt = await cache.get(`revoke_trust:${userId}`);
  if (!revokedAt) return false;
  if (trust && trust.iat) {
    const iatMs = new Date(trust.iat * 1000);
    if (iatMs >= new Date(revokedAt)) return false;
  }
  return true;
}

async function deviceValidationMiddleware(req, res, next) {
  const deviceUuid = req.headers['x-device-uuid'];
  const presentedSecret = req.headers['x-device-secret'];

  if (!deviceUuid) {
    console.error(
      `[device-validation] Missing X-Device-UUID header for user ${req.user?.id || req.user?.email || 'unknown'}. ` +
      'The frontend must send a device identifier with every clock-in/clock-out request.'
    );
    return res.status(403).json({
      success: false,
      message: 'Missing device identifier. Send X-Device-UUID header.',
      error_code: 'DEVICE_UUID_REQUIRED',
    });
  }

  const user = req.user;
  let trust = getTrustFromRequest(req);
  let trustActive = trust && !(await isTrustRevoked(user.id, trust));

  if (trustActive && trust.sub !== user.id) {
    // The browser still holds a device_trust cookie from a different account
    // (e.g., testing/switching accounts on one browser). The current user IS
    // authenticated via their valid session/JWT, so clear the stale cookie and
    // continue — the device will be (re)bound to the account actually using it.
    console.warn(
      `[device-validation] Clearing stale device_trust cookie for ${user.email} ` +
      `(token was bound to ${trust.sub}).`
    );
    clearTrustOnResponse(res);
    trust = null;
    trustActive = false;
  }

  // A valid trust cookie whose device claim matches the presented device is
  // proof that this browser was previously bound to this account+device, so the
  // device secret is not required for that request.
  if (trustActive && trust.dev === deviceUuid) {
    req.deviceValidationResult = {
      valid: true,
      trustLevel: 'trusted',
      deviceId: deviceUuid,
    };
    return next();
  }

  if (!user.boundDeviceId) {
    const revoked = await cache.get(`revoke_trust:${user.id}`);
    if (revoked) {
      await cache.del(`revoke_trust:${user.id}`);
    }

    // First-time binding: the server issues a secret instead of trusting the
    // client-chosen device UUID. The raw secret is returned exactly once so the
    // browser can present it on subsequent requests.
    const secret = generateDeviceSecret();
    user.boundDeviceId = deviceUuid;
    user.deviceSecretHash = hashDeviceSecret(secret);
    await user.save();
    await cache.set(`bound_device:${user.id}`, deviceUuid, 86400);
    setTrustOnResponse(res, user.id, deviceUuid);

    req.deviceValidationResult = {
      valid: true,
      trustLevel: 'auto_bound',
      deviceId: deviceUuid,
      deviceSecret: secret,
    };
    return next();
  }

  const cachedBoundDevice = await cache.get(`bound_device:${user.id}`);

  let boundDeviceId;
  if (cachedBoundDevice !== null) {
    boundDeviceId = cachedBoundDevice;
  } else {
    boundDeviceId = user.boundDeviceId;
    await cache.set(`bound_device:${user.id}`, boundDeviceId, 86400);
  }

  if (deviceUuid !== boundDeviceId) {
    if (trustActive) {
      return res.status(403).json({
        success: false,
        message: 'Device trust token does not match this device. Please re-register your device.',
        error_code: 'DEVICE_TRUST_MISMATCH',
        device_id: deviceUuid,
        registered_device_id: boundDeviceId,
      });
    }

    await cache.del(`bound_device:${user.id}`);
    return res.status(403).json({
      success: false,
      message:
        'Unregistered Device. You can only clock in from your registered smartphone.',
      error_code: 'UNREGISTERED_DEVICE',
    });
  }

  // The device matches the bound device but no trust cookie covers it. Require
  // the server-issued device secret unless the binding predates the secret
  // scheme (in which case a secret is issued on first successful use).
  if (!user.deviceSecretHash) {
    const secret = generateDeviceSecret();
    user.deviceSecretHash = hashDeviceSecret(secret);
    await user.save();
    setTrustOnResponse(res, user.id, deviceUuid);
    req.deviceValidationResult = {
      valid: true,
      trustLevel: 'recovered',
      reason: 'LEGACY_DEVICE_SECRET_ISSUED',
      deviceId: deviceUuid,
      registeredDeviceId: boundDeviceId,
      deviceSecret: secret,
    };
    return next();
  }

  if (!verifyDeviceSecret(presentedSecret, user.deviceSecretHash)) {
    console.warn(
      `[device-validation] Device secret mismatch for ${user.email} (device ${deviceUuid}).`
    );
    return res.status(403).json({
      success: false,
      message: 'This device is not recognized. Please use the registered device.',
      error_code: 'DEVICE_SECRET_MISMATCH',
    });
  }

  setTrustOnResponse(res, user.id, deviceUuid);
  req.deviceValidationResult = {
    valid: true,
    trustLevel: 'recovered',
    reason: 'TRUST_COOKIE_REISSUED',
    deviceId: deviceUuid,
    registeredDeviceId: boundDeviceId,
  };
  next();
}

module.exports = deviceValidationMiddleware;
module.exports.hashDeviceSecret = hashDeviceSecret;
module.exports.verifyDeviceSecret = verifyDeviceSecret;
module.exports.generateDeviceSecret = generateDeviceSecret;