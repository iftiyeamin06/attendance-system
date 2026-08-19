require('dotenv').config();
const { sequelize, User } = require('../models');
const cache = require('../redis/cache');

async function clearBoundDevices() {
  try {
    const emails = [
      'iftiyeamin06@gmail.com',
      'rahim@company.com',
      'sara@company.com',
      'tanvir@company.com',
      'nusrat@company.com',
    ];

    const users = await User.findAll({ where: { email: emails } });
    for (const user of users) {
      if (user.boundDeviceId) {
        await cache.del(`bound_device:${user.id}`);
        user.boundDeviceId = null;
        user.deviceSecretHash = null;
        await user.save();
        console.log(`Cleared bound device for ${user.email}`);
      } else {
        console.log(`No bound device for ${user.email}`);
      }
    }

    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('Error clearing bound devices:', err);
    process.exit(1);
  }
}

clearBoundDevices();