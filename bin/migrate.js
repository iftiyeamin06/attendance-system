const { sequelize } = require('../models');
const { User, Setting, AttendanceLog } = require('../models');
const bcrypt = require('bcryptjs');

async function runMigrations() {
  try {
    await sequelize.authenticate();
    console.log('Database connected.');

    await sequelize.sync({ force: false });
    console.log('Database synced.');

    await Setting.findOrCreate({
      where: { key: 'office_public_ip' },
      defaults: { value: process.env.OFFICE_PUBLIC_IP || '192.168.1.100' },
    });

    const adminExists = await User.findOne({ where: { role: 'admin' } });
    if (!adminExists) {
      const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
      const hashedPassword = await bcrypt.hash('admin123', saltRounds);

      await User.create({
        name: 'System Administrator',
        email: 'admin@attendance.local',
        password: hashedPassword,
        role: 'admin',
      });
      console.log('Created default admin: admin@attendance.local / admin123');
    }

    const employeeExists = await User.findOne({ where: { role: 'employee' } });
    if (!employeeExists) {
      const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
      const hashedPassword = await bcrypt.hash('employee123', saltRounds);

      await User.create({
        name: 'Test Employee',
        email: 'employee@attendance.local',
        password: hashedPassword,
        role: 'employee',
      });
      console.log('Created default employee: employee@attendance.local / employee123');
    }

    console.log('Migration complete.');
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
}

runMigrations();
