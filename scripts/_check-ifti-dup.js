require('dotenv').config();
const { sequelize, User, AttendanceLog } = require('../models');
(async () => {
  const users = await User.findAll({
    where: { name: 'ifti' },
    attributes: ['id', 'name', 'email', 'role', 'boundDeviceId']
  });
  console.log('Users named "ifti":');
  users.forEach(u => console.log(`  ${u.email} (${u.role}) id=${u.id} device=${u.boundDeviceId}`));
  
  // Check logs for each
  for (const u of users) {
    const logs = await AttendanceLog.findAll({
      where: { userId: u.id, shiftDate: '2026-08-25' },
      attributes: ['id', 'shiftDate', 'clockInTime', 'clockOutTime', 'status', 'ipAddress', 'deviceIdUsed']
    });
    console.log(`\nLogs for ${u.email} on 2026-08-25:`);
    logs.forEach(l => console.log(`  ${l.id} ${l.status} in=${l.clockInTime} out=${l.clockOutTime} ip=${l.ipAddress} device=${l.deviceIdUsed}`));
  }
  
  await sequelize.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });