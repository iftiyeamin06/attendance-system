const cache = require('../redis/cache');
const { getTrustFromRequest, setTrustOnResponse } = require('./deviceTrust');

const REVOKE_TTL = 86400;

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
  const trust = getTrustFromRequest(req);
  const trustActive = trust && !(await isTrustRevoked(user.id, trust));

  if (trustActive && trust.sub !== user.id) {
    return res.status(403).json({
      success: false,
      message: 'Device trust token is linked to a different account. Please log in and register your own device.',
      error_code: 'DEVICE_TRUST_CROSS_ACCOUNT',
    });
  }

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
      return res.status(403).json({
        success: false,
        message: 'Your device was reset by an administrator. Please register your device again.',
        error_code: 'DEVICE_TRUST_REVOKED',
      });
    }

    user.boundDeviceId = deviceUuid;
    await user.save();
    await cache.set(`bound_device:${user.id}`, deviceUuid, 86400);
    setTrustOnResponse(res, user.id, deviceUuid);

    req.deviceValidationResult = {
      valid: true,
      trustLevel: 'auto_bound',
      deviceId: deviceUuid,
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
    req.deviceValidationResult = {
      valid: false,
      reason: 'UNREGISTERED_DEVICE',
      deviceId: deviceUuid,
      registeredDeviceId: boundDeviceId,
    };
    return res.status(403).json({
      success: false,
      message:
        'Unregistered Device. You can only clock in from your registered smartphone.',
      error_code: 'UNREGISTERED_DEVICE',
    });
  }

  if (trustActive) {
    if (trust.dev === deviceUuid) {
      req.deviceValidationResult = {
        valid: true,
        trustLevel: 'trusted',
        deviceId: deviceUuid,
        registeredDeviceId: boundDeviceId,
      };
      return next();
    }

    setTrustOnResponse(res, user.id, deviceUuid);
    req.deviceValidationResult = {
      valid: true,
      trustLevel: 'recovered',
      reason: 'DEVICE_REBOUND_COOKIE_STALE',
      deviceId: deviceUuid,
      registeredDeviceId: boundDeviceId,
    };
    return next();
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