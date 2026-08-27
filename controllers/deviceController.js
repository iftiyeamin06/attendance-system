const { User } = require('../models');
const cache = require('../redis/cache');
const { setTrustOnResponse, getTrustFromRequest } = require('../middleware/deviceTrust');
const { generateDeviceSecret, hashDeviceSecret } = require('../middleware/deviceValidation');

async function registerDevice(req, res) {
  try {
    const { device_uuid, device_info } = req.body;
    const user = req.user;

    if (!device_uuid) {
      return res.status(400).json({
        success: false,
        message: 'Device UUID is required.',
      });
    }

    if (user.boundDeviceId && user.boundDeviceId === device_uuid) {
      return res.status(400).json({
        success: false,
        message: 'Device already registered to this account.',
        bound_device_id: user.boundDeviceId,
      });
    }

    if (user.boundDeviceId && user.boundDeviceId !== device_uuid) {
      const trust = getTrustFromRequest(req);
      if (!trust || trust.sub !== user.id) {
        return res.status(403).json({
          success: false,
          message: 'Cannot re-register device from an unauthorized browser. Please use the device you originally registered, or ask an admin to reset your device.',
          error_code: 'TRUST_COOKIE_REQUIRED',
        });
      }
    }

    const secret = generateDeviceSecret();
    user.boundDeviceId = device_uuid;
    user.deviceSecretHash = hashDeviceSecret(secret);
    await user.save();

    await cache.set(`bound_device:${user.id}`, device_uuid, 86400);
    await cache.del(`revoke_trust:${user.id}`);

    setTrustOnResponse(res, user.id, device_uuid);

    return res.json({
      success: true,
      message: 'Device registered successfully.',
      data: {
        user_id: user.id,
        bound_device_id: device_uuid,
        trust_level: 'trusted',
        device_secret: secret,
      },
    });
  } catch (err) {
    console.error('Device registration error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred during device registration.',
    });
  }
}

async function checkDeviceStatus(req, res) {
  try {
    const user = req.user;

    return res.json({
      success: true,
      data: {
        user_id: user.id,
        has_bound_device: !!user.boundDeviceId,
        bound_device_id: user.boundDeviceId || null,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'An error occurred.',
    });
  }
}

async function myIp(req, res) {
  try {
    const { extractClientIp, candidateIps } = require('../middleware/ipValidation');
    return res.json({
      success: true,
      detected_ip: extractClientIp(req),
      candidate_ips: candidateIps(req),
      configured_office_ip: process.env.OFFICE_PUBLIC_IP || null,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { registerDevice, checkDeviceStatus, myIp };
