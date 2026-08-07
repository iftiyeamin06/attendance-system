const cache = require('../redis/cache');

async function deviceValidationMiddleware(req, res, next) {
  const deviceUuid = req.headers['x-device-uuid'];

  if (!deviceUuid) {
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

    req.deviceValidationResult = {
      valid: true,
      reason: 'AUTO_BOUND',
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

  req.deviceValidationResult = {
    valid: true,
    deviceId: deviceUuid,
    registeredDeviceId: boundDeviceId,
  };
  next();
}

module.exports = deviceValidationMiddleware;
