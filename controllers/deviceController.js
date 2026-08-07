const { User } = require('../models');
const cache = require('../redis/cache');

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

    if (user.boundDeviceId) {
      return res.status(400).json({
        success: false,
        message: 'Device already registered to this account.',
        bound_device_id: user.boundDeviceId,
      });
    }

    user.boundDeviceId = device_uuid;
    await user.save();

    await cache.set(`bound_device:${user.id}`, device_uuid, 86400);

    return res.json({
      success: true,
      message: 'Device registered successfully.',
      data: {
        user_id: user.id,
        bound_device_id: device_uuid,
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

module.exports = { registerDevice, checkDeviceStatus };
