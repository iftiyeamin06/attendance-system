const { sequelize, User, Setting } = require('../models');
const bcrypt = require('bcryptjs');

async function resetDatabase() {
  try {
    await sequelize.authenticate();
    await sequelize.sync({ force: true });
    console.log('Database reset.');

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const adminPassword = await bcrypt.hash('admin123', saltRounds);
    const employeePassword = await bcrypt.hash('employee123', saltRounds);

    await User.create({
      name: 'System Administrator',
      email: 'admin@attendance.local',
      password: adminPassword,
      role: 'admin',
    });

    await User.create({
      name: 'Test Employee',
      email: 'employee@attendance.local',
      password: employeePassword,
      role: 'employee',
    });

    await Setting.findOrCreate({
      where: { key: 'office_public_ip' },
      defaults: { value: process.env.OFFICE_PUBLIC_IP || '192.168.1.100' },
    });

    console.log('Test users created:');
    console.log('  Admin: admin@attendance.local / admin123');
    console.log('  Employee: employee@attendance.local / employee123');

    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('Setup error:', err);
    process.exit(1);
  }
}

resetDatabase();
