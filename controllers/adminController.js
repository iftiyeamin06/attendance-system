const { User, AttendanceLog, Setting, Leave } = require('../models');
const cache = require('../redis/cache');
const bcrypt = require('bcryptjs');
const { Parser } = require('json2csv');
const { Op, fn, col, literal } = require('sequelize');
const {
  localDateStr,
  formatDateTime,
  formatTime,
  formatWeekday,
  formatMonthLabel,
  deadlineEpoch,
} = require('../utils/date');

function calculateDuration(clockIn, clockOut) {
  const diffMs = new Date(clockOut) - new Date(clockIn);
  const hours = Math.floor(diffMs / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

async function addAdmin(req, res) {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required.',
      });
    }

    const existing = await User.findOne({ where: { email } });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'A user with this email already exists.',
      });
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role: 'admin',
    });

    return res.status(201).json({
      success: true,
      message: 'Admin created successfully.',
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Add admin error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while creating the admin.',
    });
  }
}

async function addEmployee(req, res) {
  try {
    const { name, email, password, device_id } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required.',
      });
    }

    const existing = await User.findOne({ where: { email } });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'A user with this email already exists.',
      });
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role: 'employee',
      boundDeviceId: device_id || null,
    });

    if (user.boundDeviceId) {
      await cache.set(`bound_device:${user.id}`, user.boundDeviceId, 86400);
    }

    return res.status(201).json({
      success: true,
      message: 'Employee created successfully.',
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        bound_device_id: user.boundDeviceId,
      },
    });
  } catch (err) {
    console.error('Add employee error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while creating the employee.',
    });
  }
}

async function bindDevice(req, res) {
  try {
    const { userId } = req.params;
    const { device_id } = req.body;

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    let deviceToBind = null;
    let source = 'manual';

    if (device_id && String(device_id).trim()) {
      deviceToBind = String(device_id).trim();
    } else {
      const activeLog = await AttendanceLog.findOne({
        where: {
          userId: user.id,
          status: 'VERIFIED',
          clockOutTime: null,
        },
        order: [['clockInTime', 'DESC']],
      });

      if (activeLog && activeLog.deviceIdUsed) {
        deviceToBind = activeLog.deviceIdUsed;
        source = 'active_session';
      }
    }

    if (!deviceToBind) {
      return res.status(400).json({
        success: false,
        message:
          'No device to bind. Either provide a device_id, or use Reset & Allow Auto-Bind so the employee\u2019s next clock-in binds automatically.',
        data: { source: null },
      });
    }

    const previousDevice = user.boundDeviceId;
    user.boundDeviceId = deviceToBind;
    await user.save();

    await cache.del(`bound_device:${user.id}`);
    await cache.set(`bound_device:${user.id}`, deviceToBind, 86400);

    return res.json({
      success: true,
      message:
        source === 'active_session'
          ? `Device bound from active session of ${user.name}.`
          : `Device bound to ${user.name}.`,
      data: {
        previous_device_id: previousDevice,
        bound_device_id: deviceToBind,
        source,
      },
    });
  } catch (err) {
    console.error('Bind device error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while binding the device.',
    });
  }
}

async function getUserDeviceBinding(req, res) {
  try {
    const { userId } = req.params;

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    const activeLog = await AttendanceLog.findOne({
      where: {
        userId: user.id,
        status: 'VERIFIED',
        clockOutTime: null,
      },
      order: [['clockInTime', 'DESC']],
    });

    const cachedBound = await cache.get(`bound_device:${user.id}`);

    return res.json({
      success: true,
      data: {
        user_id: user.id,
        name: user.name,
        email: user.email,
        bound_device_id: user.boundDeviceId || null,
        cached_bound_device_id: cachedBound !== null ? cachedBound : null,
        has_active_session: !!activeLog,
        active_session_device_id: activeLog ? activeLog.deviceIdUsed || null : null,
        active_session_clock_in_time: activeLog ? activeLog.clockInTime : null,
      },
    });
  } catch (err) {
    console.error('Get user device binding error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred retrieving the device binding.',
    });
  }
}

async function adminDashboard(req, res) {
  try {
    const { date } = req.query;
    const today = new Date();
    const targetDate = date ? new Date(date) : today;
    const todayStr = localDateStr(targetDate);
    const dayStart = new Date(targetDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setHours(23, 59, 59, 999);

    const cacheKey = `daily_summary:${todayStr}`;
    let dailyLogs = await cache.get(cacheKey);

    // Get office time settings
    const startSetting = await Setting.findOne({ where: { key: 'office_start_time' } });
    const graceSetting = await Setting.findOne({ where: { key: 'grace_period_minutes' } });
    const officeStartTime = startSetting ? startSetting.value : '09:00';
    const graceMinutes = graceSetting ? parseInt(graceSetting.value) : 10;

    if (!dailyLogs) {
      const logs = await AttendanceLog.findAll({
        where: {
          [Op.or]: [
            {
              clockInTime: {
                [Op.gte]: dayStart,
                [Op.lte]: dayEnd,
              },
            },
            { shiftDate: todayStr },
          ],
        },
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['id', 'name', 'email'],
          },
        ],
        order: [['clockInTime', 'DESC']],
      });

      const logIds = logs.map(l => l.id);
      const partialLeaves = await require('../models').Leave.findAll({
        where: {
          leaveType: 'partial',
          startDate: { [Op.lte]: todayStr },
          endDate: { [Op.gte]: todayStr },
        },
        include: [{ model: User, as: 'user', attributes: ['id'] }],
      });

      const partialByUser = {};
      partialLeaves.forEach(pl => {
        partialByUser[pl.userId] = pl;
      });

      dailyLogs = logs.map((log) => {
        const clockIn = new Date(log.clockInTime);
        const uid = log.user.id;
        const partialLeave = partialByUser[uid] || null;

        const [startHour, startMin] = officeStartTime.split(':').map(Number);
        const logDate = localDateStr(new Date(clockIn));
        const deadline = new Date(deadlineEpoch(logDate, startHour, startMin + graceMinutes));
        const isLate = clockIn > deadline;

        return {
          id: log.id,
          user: {
            id: log.user.id,
            name: log.user.name,
            email: log.user.email,
          },
          clock_in_time: log.clockInTime,
          clock_out_time: log.clockOutTime,
          ip_address: log.ipAddress,
          device_id: log.deviceIdUsed,
          status: log.status,
          is_late: isLate,
          late_minutes: isLate ? Math.floor((clockIn - deadline) / 60000) : 0,
          partial_leave: partialLeave
            ? {
                type: partialLeave.leaveType,
                label: 'Partial Leave',
                from: partialLeave.partialFrom,
                to: partialLeave.partialTo,
              }
            : null,
        };
      });

      await cache.set(`daily_summary:${todayStr}`, dailyLogs, 300);
    }

    const allUsers = await User.findAll({
      where: { role: 'employee' },
      attributes: ['id', 'name', 'email', 'boundDeviceId'],
    });

    const employees = allUsers.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      has_bound_device: !!u.boundDeviceId,
      bound_device_id: u.boundDeviceId || null,
    }));

    let officeIp = await cache.getOfficeIP();
    if (!officeIp) {
      const setting = await Setting.findOne({ where: { key: 'office_public_ip' } });
      officeIp = setting ? setting.value : process.env.OFFICE_PUBLIC_IP;
    }

    return res.json({
      success: true,
      data: {
        today: todayStr,
        office_ip: officeIp,
        office_start_time: officeStartTime,
        grace_period_minutes: graceMinutes,
        attendance_today: dailyLogs,
        employees: employees,
      },
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred.',
    });
  }
}

async function getAllUsers(req, res) {
  try {
    const users = await User.findAll({
      attributes: ['id', 'name', 'email', 'role', 'boundDeviceId', 'createdAt', 'updatedAt'],
    });

    const employees = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      bound_device_id: u.boundDeviceId || null,
      created_at: u.createdAt,
      updated_at: u.updatedAt,
    }));

    return res.json({
      success: true,
      data: employees,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'An error occurred.',
    });
  }
}

async function resetDevice(req, res) {
  try {
    const { userId } = req.params;

    const user = await User.findByPk(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    const previousDevice = user.boundDeviceId;
    user.boundDeviceId = null;
    await user.save();

    await cache.del(`bound_device:${user.id}`);

    return res.json({
      success: true,
      message: `Device binding reset for ${user.name}.`,
      previous_device_id: previousDevice,
    });
  } catch (err) {
    console.error('Device reset error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while resetting device.',
    });
  }
}

async function updateOfficeIp(req, res) {
  try {
    const { office_public_ip } = req.body;

    if (!office_public_ip) {
      return res.status(400).json({
        success: false,
        message: 'office_public_ip is required.',
      });
    }

    const [setting, created] = await Setting.upsert({
      key: 'office_public_ip',
      value: office_public_ip,
    });

    await cache.setOfficeIP(office_public_ip);

    return res.json({
      success: true,
      message: 'Office IP updated successfully.',
      data: {
        office_public_ip: setting.value,
      },
    });
  } catch (err) {
    console.error('IP update error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while updating IP.',
    });
  }
}

async function updateOfficeTime(req, res) {
  try {
    const { office_start_time, office_end_time, grace_period_minutes } = req.body;

    if (office_start_time !== undefined) {
      await Setting.upsert({ key: 'office_start_time', value: office_start_time });
    }
    if (office_end_time !== undefined) {
      await Setting.upsert({ key: 'office_end_time', value: office_end_time });
    }
    if (grace_period_minutes !== undefined) {
      await Setting.upsert({ key: 'grace_period_minutes', value: String(grace_period_minutes) });
    }

    return res.json({
      success: true,
      message: 'Office time settings updated successfully.',
    });
  } catch (err) {
    console.error('Office time update error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while updating office time.',
    });
  }
}

async function getOfficeTime(req, res) {
  try {
    const startSetting = await Setting.findOne({ where: { key: 'office_start_time' } });
    const endSetting = await Setting.findOne({ where: { key: 'office_end_time' } });
    const graceSetting = await Setting.findOne({ where: { key: 'grace_period_minutes' } });

    return res.json({
      success: true,
      data: {
        office_start_time: startSetting ? startSetting.value : '09:00',
        office_end_time: endSetting ? endSetting.value : '17:00',
        grace_period_minutes: graceSetting ? parseInt(graceSetting.value) : 10,
      },
    });
  } catch (err) {
    console.error('Get office time error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred.',
    });
  }
}

async function exportCsv(req, res) {
  try {
    const { startDate, endDate } = req.query;

    const where = {};

    if (startDate && endDate) {
      where.clockInTime = {
        [Op.gte]: new Date(startDate),
        [Op.lte]: new Date(endDate),
      };
    } else if (startDate) {
      where.clockInTime = {
        [Op.gte]: new Date(startDate),
      };
    }

    const logs = await AttendanceLog.findAll({
      where,
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['name', 'email'],
        },
      ],
      order: [['clockInTime', 'DESC']],
    });

    const csvData = logs.map((log) => {
      // Calculate late status
      const clockIn = new Date(log.clockInTime);
      const logDate = new Date(clockIn);
      logDate.setHours(0, 0, 0, 0);
      
      const startSetting = logs.length > 0 ? null : null; // Will fetch once below
      const clockInHour = clockIn.getHours();
      const clockInMinute = clockIn.getMinutes();
      
      return {
        date: log.clockInTime ? localDateStr(log.clockInTime) : '',
        employee_name: log.user?.name || 'Unknown',
        employee_email: log.user?.email || 'Unknown',
        clock_in_time: log.clockInTime ? formatDateTime(log.clockInTime) : '',
        clock_out_time: log.clockOutTime ? formatDateTime(log.clockOutTime) : '',
        work_duration: log.clockOutTime
          ? calculateDuration(log.clockInTime, log.clockOutTime)
          : '',
        ip_address: log.ipAddress,
        device_id: log.deviceIdUsed,
        status: log.status,
        late: 'No', // Will be calculated below
      };
    });

    // Get office time settings and recalculate late status
    const startSetting = await Setting.findOne({ where: { key: 'office_start_time' } });
    const graceSetting = await Setting.findOne({ where: { key: 'grace_period_minutes' } });
    const officeStartTime = startSetting ? startSetting.value : '09:00';
    const graceMinutes = graceSetting ? parseInt(graceSetting.value) : 10;
    const [startH, startM] = officeStartTime.split(':').map(Number);

    csvData.forEach((row) => {
      if (row.clock_in_time) {
        const clockIn = new Date(row.clock_in_time);
        const deadline = new Date(clockIn);
        deadline.setHours(startH, startM + graceMinutes, 0, 0);
        if (clockIn > deadline) {
          const lateMin = Math.floor((clockIn - deadline) / 60000);
          row.late = `Yes (${lateMin} min)`;
        }
      }
    });

    const parser = new Parser({
      fields: [
        'date',
        'employee_name',
        'employee_email',
        'clock_in_time',
        'clock_out_time',
        'work_duration',
        'ip_address',
        'device_id',
        'status',
        'late',
      ],
    });
    const csv = parser.parse(csvData);

    const filename = `attendance_export_${localDateStr(new Date())}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('CSV export error:', err.message, err.stack);
    return res.status(500).json({
      success: false,
      message: 'An error occurred during export.',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
}

async function getEmployeeMonthlySummary(req, res) {
  try {
    const { userId } = req.params;
    const { month, year } = req.query;

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }

    const now = new Date();
    const targetMonth = month ? parseInt(month) - 1 : now.getMonth();
    const targetYear = year ? parseInt(year) : now.getFullYear();

    const monthStart = new Date(targetYear, targetMonth, 1);
    const monthEnd = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59, 999);
    const monthStartStr = localDateStr(monthStart);
    const monthEndStr = localDateStr(monthEnd);

    const officeTimes = await (require('./leaveController_fixed')).getOfficeTimes();
    const officeStartTime = officeTimes.start;

    const startSetting = await Setting.findOne({ where: { key: 'office_start_time' } });
    const graceSetting = await Setting.findOne({ where: { key: 'grace_period_minutes' } });
    const officeStart = startSetting ? startSetting.value : '09:00';
    const graceMinutes = graceSetting ? parseInt(graceSetting.value) : 10;
    const [startH, startM] = officeStart.split(':').map(Number);

    const logs = await AttendanceLog.findAll({
      where: {
        userId,
        [Op.or]: [
          { clockInTime: { [Op.gte]: monthStart, [Op.lte]: monthEnd } },
          { status: 'ON_LEAVE', createdAt: { [Op.gte]: monthStart, [Op.lte]: monthEnd } },
        ],
      },
      order: [['clockInTime', 'ASC']],
    });

    const leaves = await Leave.findAll({
      where: {
        userId,
        [Op.or]: [
          { startDate: { [Op.lte]: monthEndStr }, endDate: { [Op.gte]: monthStartStr } },
        ],
      },
      order: [['startDate', 'ASC']],
    });

    const partialLeaves = leaves.filter(l => l.leaveType === 'partial');
    const fullDayLeaves = leaves.filter(l => l.leaveType !== 'partial');

    const totalWorkdays = countWeekdays(monthStart, monthEnd);

    let present = 0;
    let late = 0;
    let onLeave = 0;
    let absent = 0;
    let partialLeaveDays = 0;
    let totalWorkMinutes = 0;
    let totalLateMinutes = 0;

    const dailyBreakdown = [];

    for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
      const dateStr = localDateStr(d);
      const dayOfWeek = d.getDay();

      if (dayOfWeek === 0 || dayOfWeek === 6) continue;

      const dayLog = logs.find(l => {
        if (l.shiftDate) return l.shiftDate === dateStr;
        if (!l.clockInTime) return false;
        const logDate = localDateStr(l.clockInTime);
        return logDate === dateStr;
      });

      const dayLeave = fullDayLeaves.find(l => dateStr >= l.startDate && dateStr <= l.endDate);
      const dayPartial = partialLeaves.find(l => dateStr >= l.startDate && dateStr <= l.endDate);

      let status = 'ABSENT';
      let clockIn = null;
      let clockOut = null;
      let duration = null;
      let isLate = false;
      let lateMin = 0;
      let leaveType = null;

      if (dayLeave) {
        status = 'ON_LEAVE';
        leaveType = dayLeave.leaveType;
        onLeave++;
      } else if (dayLog) {
        clockIn = dayLog.clockInTime;
        clockOut = dayLog.clockOutTime;
        status = dayLog.status;

        if (dayPartial) {
          partialLeaveDays++;
        }

        if (clockIn) {
          const shiftDate = dayLog.shiftDate || localDateStr(new Date(clockIn));
          const deadline = new Date(deadlineEpoch(shiftDate, startH, startM + graceMinutes));
          if (new Date(clockIn) > deadline) {
            isLate = true;
            lateMin = Math.floor((new Date(clockIn) - deadline) / 60000);
          }
        }

        if (clockIn && clockOut) {
          duration = calculateDuration(clockIn, clockOut);
          totalWorkMinutes += (new Date(clockOut) - new Date(clockIn)) / 60000;
        }

        if (isLate) {
          status = 'LATE';
          late++;
          totalLateMinutes += lateMin;
        } else if (status === 'VERIFIED') {
          present++;
        }
      } else {
        absent++;
      }

      dailyBreakdown.push({
        date: dateStr,
        day: formatWeekday(d).slice(0, 3),
        status,
        clock_in: clockIn ? formatTime(clockIn) : null,
        clock_out: clockOut ? formatTime(clockOut) : null,
        duration,
        is_late: isLate,
        late_minutes: lateMin,
        leave_type: leaveType,
      });
    }

    const totalHoursWorked = Math.floor(totalWorkMinutes / 60);
    const totalMinsWorked = Math.round(totalWorkMinutes % 60);

    const monthLabel = formatMonthLabel(monthStart);

    return res.json({
      success: true,
      data: {
        employee: {
          id: user.id,
          name: user.name,
          email: user.email,
          bound_device_id: user.boundDeviceId,
          joined: user.createdAt,
        },
        period: monthLabel,
        month: targetMonth + 1,
        year: targetYear,
        summary: {
          total_workdays: totalWorkdays,
          present,
          late,
          on_leave: onLeave,
          partial_leave_days: partialLeaveDays,
          absent,
          total_hours_worked: `${totalHoursWorked}h ${totalMinsWorked}m`,
          total_work_minutes: totalWorkMinutes,
          total_late_minutes: totalLateMinutes,
          attendance_rate: totalWorkdays > 0 ? Math.round(((present + late + onLeave) / totalWorkdays) * 100) : 0,
        },
        daily_breakdown: dailyBreakdown,
      },
    });
  } catch (err) {
    console.error('Employee monthly summary error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

function countWeekdays(start, end) {
  let count = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

async function deleteUser(req, res) {
  try {
    const { userId } = req.params;

    if (req.user && req.user.id === userId) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own admin account.',
      });
    }

    const user = await User.findByPk(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    await cache.del(`bound_device:${userId}`);
    await AttendanceLog.destroy({ where: { userId } });
    await Leave.destroy({ where: { userId } });
    await user.destroy();

    return res.status(200).json({
      success: true,
      message: `${user.role === 'admin' ? 'Admin' : 'Employee'} deleted successfully.`,
    });
  } catch (err) {
    console.error('Delete user error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while deleting the user.',
    });
  }
}

async function getAllEmployeesMonthlySummary(req, res) {
  try {
    const { month, year } = req.query;

    const now = new Date();
    const targetMonth = month ? parseInt(month) - 1 : now.getMonth();
    const targetYear = year ? parseInt(year) : now.getFullYear();

    const monthStart = new Date(targetYear, targetMonth, 1);
    const monthEnd = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59, 999);
    const monthStartStr = localDateStr(monthStart);
    const monthEndStr = localDateStr(monthEnd);

    const officeTimes = await (require('./leaveController')).getOfficeTimes();
    const officeStartTime = officeTimes.start;
    const [startH, startM] = officeStartTime.split(':').map(Number);
    const graceSetting = await Setting.findOne({ where: { key: 'grace_period_minutes' } });
    const graceMinutes = graceSetting ? parseInt(graceSetting.value) : 10;

    // Fetch all employees (exclude admins from report)
    const employees = await User.findAll({
      where: { role: 'employee' },
      attributes: ['id', 'name', 'email', 'role'],
      order: [['name', 'ASC']],
    });

    // Fetch all attendance logs for the month in one query
    const logs = await AttendanceLog.findAll({
      where: {
        userId: {
          [Op.in]: employees.map(e => e.id),
        },
        [Op.or]: [
          { clockInTime: { [Op.gte]: monthStart, [Op.lte]: monthEnd } },
          { status: 'ON_LEAVE', createdAt: { [Op.gte]: monthStart, [Op.lte]: monthEnd } },
        ],
      },
      order: [['clockInTime', 'ASC']],
    });

    // Fetch all leaves for the month in one query
    const leaves = await Leave.findAll({
      where: {
        userId: {
          [Op.in]: employees.map(e => e.id),
        },
        [Op.or]: [
          { startDate: { [Op.lte]: monthEndStr }, endDate: { [Op.gte]: monthStartStr } },
        ],
      },
      order: [['startDate', 'ASC']],
    });

    const partialLeaves = leaves.filter(l => l.leaveType === 'partial');
    const fullDayLeaves = leaves.filter(l => l.leaveType !== 'partial');

    const totalWorkdays = countWeekdays(monthStart, monthEnd);

    let kpiTotalShifts = 0;
    let kpiTotalOnTime = 0;
    let kpiTotalLate = 0;
    let kpiTotalLeaves = 0;

    const employeeRows = employees.map(emp => {
      const empLogs = logs.filter(l => l.userId === emp.id);
      const empFullLeaves = fullDayLeaves.filter(l => l.userId === emp.id);
      const empPartialLeaves = partialLeaves.filter(l => l.userId === emp.id);

      let present = 0;
      let lateCount = 0;
      let onLeaveCount = 0;
      let absentCount = 0;
      let partialLeaveCount = 0;
      let totalWorkMinutes = 0;

      for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
        const dateStr = localDateStr(d);
        const dayOfWeek = d.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;

        const dayLog = empLogs.find(l => {
          if (l.shiftDate) return l.shiftDate === dateStr;
          if (!l.clockInTime) return false;
          return localDateStr(l.clockInTime) === dateStr;
        });

        const dayLeave = empFullLeaves.find(l => dateStr >= l.startDate && dateStr <= l.endDate);
        const dayPartial = empPartialLeaves.find(l => dateStr >= l.startDate && dateStr <= l.endDate);

        if (dayLeave) {
          onLeaveCount++;
          kpiTotalLeaves++;
        } else if (dayLog) {
          const clockIn = new Date(dayLog.clockInTime);
          const clockOut = dayLog.clockOutTime;
          kpiTotalShifts++;

          if (clockIn) {
            const shiftDate = dayLog.shiftDate || localDateStr(clockIn);
            const deadline = new Date(deadlineEpoch(shiftDate, startH, startM + graceMinutes));
            const isLate = clockIn > deadline;
            if (isLate) {
              lateCount++;
              kpiTotalLate++;
            } else {
              present++;
              kpiTotalOnTime++;
            }
          }

          if (clockIn && clockOut) {
            totalWorkMinutes += (new Date(clockOut) - new Date(clockIn)) / 60000;
          }
        } else {
          absentCount++;
        }

        if (dayPartial) {
          partialLeaveCount++;
          kpiTotalLeaves++;
        }
      }

      const totalHours = Math.floor(totalWorkMinutes / 60);
      const totalMins = Math.round(totalWorkMinutes % 60);

      return {
        id: emp.id,
        name: emp.name,
        email: emp.email,
        role: emp.role,
        total_days_worked: present + lateCount,
        total_hours_worked: `${totalHours}h ${totalMins}m`,
        on_time_days: present,
        late_days: lateCount,
        leave_days: onLeaveCount + partialLeaveCount,
        absent_days: absentCount,
        total_workdays: totalWorkdays,
      };
    });

    const monthLabel = formatMonthLabel(monthStart);

    return res.json({
      success: true,
      data: {
        period: monthLabel,
        month: targetMonth + 1,
        year: targetYear,
        total_workdays: totalWorkdays,
        kpi: {
          total_shifts: kpiTotalShifts,
          total_on_time: kpiTotalOnTime,
          total_late: kpiTotalLate,
          total_leaves: kpiTotalLeaves,
        },
        employees: employeeRows,
      },
    });
  } catch (err) {
    console.error('Get all employees monthly summary error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

async function exportMonthlyReportCsv(req, res) {
  try {
    const { month, year } = req.query;

    const now = new Date();
    const targetMonth = month ? parseInt(month) - 1 : now.getMonth();
    const targetYear = year ? parseInt(year) : now.getFullYear();

    const monthStart = new Date(targetYear, targetMonth, 1);
    const monthEnd = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59, 999);
    const monthStartStr = localDateStr(monthStart);
    const monthEndStr = localDateStr(monthEnd);

    const officeTimes = await (require('./leaveController')).getOfficeTimes();
    const officeStartTime = officeTimes.start;
    const [startH, startM] = officeStartTime.split(':').map(Number);
    const graceSetting = await Setting.findOne({ where: { key: 'grace_period_minutes' } });
    const graceMinutes = graceSetting ? parseInt(graceSetting.value) : 10;

    const employees = await User.findAll({
      where: { role: 'employee' },
      attributes: ['id', 'name', 'email', 'role'],
      order: [['name', 'ASC']],
    });

    const logs = await AttendanceLog.findAll({
      where: {
        userId: { [Op.in]: employees.map(e => e.id) },
        [Op.or]: [
          { clockInTime: { [Op.gte]: monthStart, [Op.lte]: monthEnd } },
          { status: 'ON_LEAVE', createdAt: { [Op.gte]: monthStart, [Op.lte]: monthEnd } },
        ],
      },
      order: [['clockInTime', 'ASC']],
    });

    const leaves = await Leave.findAll({
      where: {
        userId: { [Op.in]: employees.map(e => e.id) },
        [Op.or]: [
          { startDate: { [Op.lte]: monthEndStr }, endDate: { [Op.gte]: monthStartStr } },
        ],
      },
      order: [['startDate', 'ASC']],
    });

    const partialLeaves = leaves.filter(l => l.leaveType === 'partial');
    const fullDayLeaves = leaves.filter(l => l.leaveType !== 'partial');
    const totalWorkdays = countWeekdays(monthStart, monthEnd);

    const csvData = employees.map(emp => {
      const empLogs = logs.filter(l => l.userId === emp.id);
      const empFullLeaves = fullDayLeaves.filter(l => l.userId === emp.id);
      const empPartialLeaves = partialLeaves.filter(l => l.userId === emp.id);

      let present = 0;
      let lateCount = 0;
      let onLeaveCount = 0;
      let absentCount = 0;
      let partialLeaveCount = 0;
      let totalWorkMinutes = 0;

      for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
        const dateStr = localDateStr(d);
        const dayOfWeek = d.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;

        const dayLog = empLogs.find(l => {
          if (l.shiftDate) return l.shiftDate === dateStr;
          if (!l.clockInTime) return false;
          return localDateStr(l.clockInTime) === dateStr;
        });

        const dayLeave = empFullLeaves.find(l => dateStr >= l.startDate && dateStr <= l.endDate);
        const dayPartial = empPartialLeaves.find(l => dateStr >= l.startDate && dateStr <= l.endDate);

        if (dayLeave) {
          onLeaveCount++;
        } else if (dayLog) {
          const clockIn = new Date(dayLog.clockInTime);
          const clockOut = dayLog.clockOutTime;

          if (clockIn) {
            const deadline = new Date(d);
            deadline.setHours(startH, startM + graceMinutes, 0, 0);
            if (clockIn > deadline) {
              lateCount++;
            } else {
              present++;
            }
          }

          if (clockIn && clockOut) {
            totalWorkMinutes += (new Date(clockOut) - new Date(clockIn)) / 60000;
          }
        } else {
          absentCount++;
        }

        if (dayPartial) {
          partialLeaveCount++;
        }
      }

      const totalHours = Math.floor(totalWorkMinutes / 60);
      const totalMins = Math.round(totalWorkMinutes % 60);

      return {
        employee_name: emp.name,
        employee_email: emp.email,
        total_days_worked: present + lateCount,
        total_hours_worked: `${totalHours}h ${totalMins}m`,
        on_time_days: present,
        late_days: lateCount,
        leave_days: onLeaveCount + partialLeaveCount,
        absent_days: absentCount,
        total_workdays: totalWorkdays,
      };
    });

    const fields = ['employee_name', 'employee_email', 'total_days_worked', 'total_hours_worked', 'on_time_days', 'late_days', 'leave_days', 'absent_days', 'total_workdays'];
    const parser = new Parser({ fields });
    const csv = parser.parse(csvData);

    const monthLabel = formatMonthLabel(monthStart);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="monthly_report_${monthLabel.replace(/\s+/g, '_')}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Export monthly report CSV error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

module.exports = {
  adminDashboard,
  getAllUsers,
  addEmployee,
  addAdmin,
  bindDevice,
  getUserDeviceBinding,
  resetDevice,
  updateOfficeIp,
  updateOfficeTime,
  getOfficeTime,
  exportCsv,
  getEmployeeMonthlySummary,
  deleteUser,
  getAllEmployeesMonthlySummary,
  exportMonthlyReportCsv,
};
