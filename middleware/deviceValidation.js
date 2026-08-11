const cache = require('../redis/cache');
const { getTrustFromRequest, setTrustOnResponse } = require('./deviceTrust');

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

  if (!user.boundDeviceId) {
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

  const trust = getTrustFromRequest(req);

  if (trust) {
    if (trust.sub !== user.id) {
      return res.status(403).json({
        success: false,
        message: 'Device trust token is linked to a different account. Please log in and register your own device.',
        error_code: 'DEVICE_TRUST_CROSS_ACCOUNT',
      });
    }

    if (trust.dev === deviceUuid) {
      req.deviceValidationResult = {
        valid: true,
        trustLevel: 'trusted',
        deviceId: deviceUuid,
        registeredDeviceId: boundDeviceId,
      };
      return next();
    }

    if (deviceUuid === boundDeviceId) {
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

    return res.status(403).json({
      success: false,
      message: 'Device trust token does not match this device. Please re-register your device.',
      error_code: 'DEVICE_TRUST_MISMATCH',
      device_id: deviceUuid,
      registered_device_id: boundDeviceId,
    });
  }

  if (deviceUuid !== boundDeviceId) {
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