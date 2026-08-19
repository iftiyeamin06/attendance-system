require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { sequelize, User, AttendanceLog, Leave, Holiday, Setting } = require('../models');
const cache = require('../redis/cache');
const { localDateStr, deadlineEpoch, addDaysToYmd, computeShiftDate, formatWeekday } = require('../utils/date');

const SEED_USERS = [
  { name: 'ifti Yeamin', email: 'iftiyeamin06@gmail.com' },
  { name: 'Rahim Ahmed', email: 'rahim@company.com' },
  { name: 'Sara Khan', email: 'sara@company.com' },
  { name: 'Tanvir Hossain', email: 'tanvir@company.com' },
  { name: 'Nusrat Jahan', email: 'nusrat@company.com' },
];

const PASSWORD = 'pass123';
const OFFICE_IP = '127.0.0.1';
const DAYS = 30;

function dhakaWeekday(dateStr) {
  return formatWeekday(new Date(deadlineEpoch(dateStr, 12, 0)));
}

function isWeekend(dateStr) {
  const wd = dhakaWeekday(dateStr);
  return wd === 'Saturday' || wd === 'Sunday';
}

function randomClockIn(dateStr) {
  const roll = Math.random();
  let base;
  if (roll < 0.7) base = 19 * 60 + 45 + Math.floor(Math.random() * 21);
  else if (roll < 0.95) base = 20 * 60 + 20 + Math.floor(Math.random() * 70);
  else base = 21 * 60 + 40 + Math.floor(Math.random() * 50);
  return new Date(deadlineEpoch(dateStr, Math.floor(base / 60), base % 60));
}

function randomClockOut(dateStr) {
  const nextDay = addDaysToYmd(dateStr, 1);
  const roll = Math.random();
  let base;
  if (roll < 0.85) base = 4 * 60 + 40 + Math.floor(Math.random() * 40);
  else base = 5 * 60 + 30 + Math.floor(Math.random() * 60);
  return new Date(deadlineEpoch(nextDay, Math.floor(base / 60), base % 60));
}

async function seedDemo() {
  try {
    await sequelize.sync({ force: false });
    console.log('Database synced.\n');

    const todayStr = localDateStr(new Date());
    const windowStart = addDaysToYmd(todayStr, -DAYS);
    const dayStrings = [];
    for (let offset = DAYS; offset >= 1; offset--) {
      dayStrings.push(addDaysToYmd(todayStr, -offset));
    }

    const weekdays = dayStrings.filter((d) => !isWeekend(d));

    const admin = await User.findOne({ where: { role: 'admin' } });
    const adminId = admin ? admin.id : null;

    const holiday1 = weekdays[Math.floor(weekdays.length * 0.25)];
    const holiday2 = weekdays[Math.floor(weekdays.length * 0.65)];
    const holidayDates = [...new Set([holiday1, holiday2].filter(Boolean))];

    const users = [];
    for (const spec of SEED_USERS) {
      let user = await User.findOne({ where: { email: spec.email } });
      if (!user) {
        user = await User.create({
          name: spec.name,
          email: spec.email,
          password: await bcrypt.hash(PASSWORD, 12),
          role: 'employee',
        });
        console.log(`Created: ${spec.name} (${spec.email})`);
      } else {
        user.password = await bcrypt.hash(PASSWORD, 12);
        user.boundDeviceId = null;
        user.deviceSecretHash = null;
        await user.save();
        console.log(`Reset:   ${spec.name} (${spec.email}) password to "${PASSWORD}", device cleared`);
      }
      users.push(user);
    }

    const userIds = users.map((u) => u.id);

    await AttendanceLog.destroy({
      where: {
        userId: { [Op.in]: userIds },
        clockInTime: { [Op.lt]: new Date(deadlineEpoch(todayStr, 0, 0)) },
      },
    });
    await Leave.destroy({
      where: {
        userId: { [Op.in]: userIds },
        startDate: { [Op.gte]: windowStart, [Op.lte]: todayStr },
      },
    });
    await Holiday.destroy({
      where: { date: { [Op.gte]: windowStart, [Op.lte]: todayStr } },
    });

    const logs = [];
    const leaves = [];

    for (const dayStr of dayStrings) {
      if (isWeekend(dayStr)) continue;
      const isHoliday = holidayDates.includes(dayStr);

      if (isHoliday) {
        await Holiday.create({ date: dayStr, name: 'National Holiday' });
        continue;
      }

      for (const user of users) {
        const roll = Math.random();
        if (roll < 0.03 && adminId) {
          leaves.push({
            userId: user.id,
            startDate: dayStr,
            endDate: dayStr,
            leaveType: Math.random() < 0.5 ? 'paid' : 'sick',
            notes: 'Seeded demo leave',
            status: 'Approved',
            createdBy: adminId,
          });
          continue;
        }
        if (roll < 0.13) continue;

        const clockIn = randomClockIn(dayStr);
        const clockOut = randomClockOut(dayStr);
        logs.push({
          userId: user.id,
          clockInTime: clockIn,
          clockOutTime: clockOut,
          shiftDate: computeShiftDate(clockIn),
          ipAddress: OFFICE_IP,
          deviceIdUsed: `device_seed_${user.id.substring(0, 8)}`,
          status: 'VERIFIED',
        });
      }
    }

    if (leaves.length) await Leave.bulkCreate(leaves);
    if (logs.length) await AttendanceLog.bulkCreate(logs);

    let officeIp = await Setting.findOne({ where: { key: 'office_public_ip' } });
    if (!officeIp) {
      await Setting.create({ key: 'office_public_ip', value: OFFICE_IP });
      console.log(`\nOffice IP setting created: ${OFFICE_IP}`);
    } else {
      console.log(`\nOffice IP setting: ${officeIp.value}`);
    }

    for (const user of users) {
      try {
        await cache.del(`bound_device:${user.id}`);
        await cache.del(`revoke_trust:${user.id}`);
      } catch {}
    }
    for (const dayStr of [...dayStrings, todayStr]) {
      try {
        await cache.del(`daily_summary:${dayStr}`);
      } catch {}
    }

    console.log(`\nCreated ${logs.length} attendance logs and ${leaves.length} approved leaves across ${users.length} users over the past ${DAYS} days.`);
    console.log(`Holidays seeded: ${holidayDates.join(', ')}`);
    console.log('Weekends (Sat/Sun) skipped. Overnight shift (20:00 - 05:00) applied.');

    console.log('\n--- Per-user summary ---');
    for (const u of users) {
      const count = await AttendanceLog.count({ where: { userId: u.id } });
      const leaveCount = await Leave.count({ where: { userId: u.id, status: 'Approved' } });
      console.log(`${u.name} (${u.email}): ${count} logs, ${leaveCount} approved leaves`);
    }

    console.log('\nLogin credentials (all reset to):');
    console.log('Admin:    admin@attendance.local / pass123');
    SEED_USERS.forEach((e) => console.log(`Employee: ${e.email} / ${PASSWORD}`));

    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('Seed demo error:', err);
    process.exit(1);
  }
}

seedDemo();