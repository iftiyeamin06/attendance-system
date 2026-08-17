require('dotenv').config();
const { sequelize, User, AttendanceLog, Setting } = require('../models');
const bcrypt = require('bcryptjs');

async function seed() {
  try {
    await sequelize.sync({ force: false });
    console.log('Database synced.\n');

    // Create employees
    const employees = [
      { name: 'ifti Yeamin', email: 'iftiyeamin06@gmail.com', password: 'ifti123' },
      { name: 'Rahim Ahmed', email: 'rahim@company.com', password: 'rahim123' },
      { name: 'Sara Khan', email: 'sara@company.com', password: 'sara123' },
      { name: 'Tanvir Hossain', email: 'tanvir@company.com', password: 'tanvir123' },
      { name: 'Nusrat Jahan', email: 'nusrat@company.com', password: 'nusrat123' },
    ];

    const saltRounds = 12;
    const createdUsers = [];

    for (const emp of employees) {
      let user = await User.findOne({ where: { email: emp.email } });
      if (!user) {
        user = await User.create({
          name: emp.name,
          email: emp.email,
          password: await bcrypt.hash(emp.password, saltRounds),
          role: 'employee',
        });
        console.log(`Created: ${emp.name} (${emp.email})`);
      } else {
        console.log(`Exists:  ${emp.name} (${emp.email})`);
      }
      createdUsers.push(user);
    }

    // Generate attendance logs for the past 30 days
    const now = new Date();
    const logsToCreate = [];

    for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
      const date = new Date(now);
      date.setDate(date.getDate() - dayOffset);
      date.setHours(0, 0, 0, 0);

      // Skip future days
      if (date > now) continue;

      // Skip weekends (Saturday=6, Sunday=0)
      const dayOfWeek = date.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) continue;

      for (const user of createdUsers) {
        // Random chance to skip a day (sick day, holiday, etc.)
        if (Math.random() < 0.1) continue; // 10% chance to skip any given day

        // Random clock-in time (8:00 AM - 10:30 AM)
        const clockInHour = 8 + Math.floor(Math.random() * 2.5);
        const clockInMinute = Math.floor(Math.random() * 60);
        const clockIn = new Date(date);
        clockIn.setHours(clockInHour, clockInMinute, 0, 0);

        // Skip if clock-in is in the future
        if (clockIn > now) continue;

        // Random clock-out time (5:00 PM - 7:00 PM), or null (still clocked in)
        let clockOut = null;
        const isClockedOut = Math.random() > 0.15; // 85% chance clocked out
        if (isClockedOut) {
          const clockOutHour = 17 + Math.floor(Math.random() * 2);
          const clockOutMinute = Math.floor(Math.random() * 60);
          clockOut = new Date(date);
          clockOut.setHours(clockOutHour, clockOutMinute, 0, 0);
          // Skip if clock-out is in the future
          if (clockOut > now) clockOut = null;
        }

        // Random IPs
        const ips = ['::1', '127.0.0.1', '192.168.1.105', '192.168.1.112'];
        const ip = ips[Math.floor(Math.random() * ips.length)];

        // Random device
        const devices = [
          `device_${user.id.substring(0, 8)}_${Date.now()}`,
          'device_seed_iphone',
          'device_seed_android',
        ];
        const device = devices[0]; // Use seed device

        // Status (90% VERIFIED, 10% REJECTED)
        const status = Math.random() > 0.1 ? 'VERIFIED' : 'REJECTED';

        logsToCreate.push({
          userId: user.id,
          clockInTime: clockIn,
          clockOutTime: clockOut,
          ipAddress: ip,
          deviceIdUsed: device,
          status: status,
        });
      }
    }

    // Insert logs
    if (logsToCreate.length > 0) {
      await AttendanceLog.bulkCreate(logsToCreate);
      console.log(`\nCreated ${logsToCreate.length} attendance logs.`);
    } else {
      console.log('\nNo logs to create.');
    }

    // Set office IP
    let setting = await Setting.findOne({ where: { key: 'office_public_ip' } });
    if (!setting) {
      await Setting.create({ key: 'office_public_ip', value: '127.0.0.1' });
      console.log('Created office IP setting: 127.0.0.1');
    } else {
      console.log(`Office IP: ${setting.value}`);
    }

    // Print summary
    console.log('\n--- Summary ---');
    const allUsers = await User.findAll({ where: { role: 'employee' } });
    for (const u of allUsers) {
      const count = await AttendanceLog.count({ where: { userId: u.id } });
      console.log(`${u.name}: ${count} records`);
    }

    console.log('\nDone! Login credentials:');
    console.log('Admin: admin@attendance.local / admin123');
    employees.forEach(e => console.log(`Employee: ${e.email} / ${e.password}`));

    process.exit(0);
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  }
}

seed();
