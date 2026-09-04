const { User, AttendanceLog, Setting, Leave, Holiday, AuditLog } = require('../models');
const cache = require('../redis/cache');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Parser } = require('json2csv');
const { Op, fn, col, literal } = require('sequelize');
const {
  localDateStr,
  formatDateTime,
  formatTime,
  formatWeekday,
  formatMonthLabel,
  deadlineEpoch,
  zonedDayRange,
  computeShiftDate,
  addDaysToYmd,
} = require('../utils/date');
const { autoCloseStaleLogs } = require('../services/attendanceCleanup');

function calculateDuration(clockIn, clockOut) {
  const diffMs = new Date(clockOut) - new Date(clockIn);
  if (diffMs <= 0) return '0h 0m';
  const hours = Math.floor(diffMs / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

function combineDateAndTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return new Date(deadlineEpoch(dateStr, h, m));
}

function validateManualStatus(status) {
  return ['PRESENT', 'LATE', 'ABSENT'].includes(status) ? status : null;
}

// Overnight shifts (office end time <= office start time) run past midnight, so
// a clock-out wall time earlier than the clock-in wall time belongs to the
// following calendar day.
async function isOvernightShift() {
  const officeTimes = await (require('./leaveController')).getOfficeTimes();
  const [sH, sM] = officeTimes.start.split(':').map(Number);
  const [eH, eM] = officeTimes.end.split(':').map(Number);
  return eH * 60 + eM <= sH * 60 + sM;
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
    // A manually-bound device has no server-issued secret yet; the employee's
    // next clock-in from it will receive one.
    user.deviceSecretHash = null;
    await user.save();

    await cache.del(`bound_device:${user.id}`);
    await cache.set(`bound_device:${user.id}`, deviceToBind, 86400);
    await cache.set(`revoke_trust:${user.id}`, Date.now(), 86400);

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
    const { date, refresh } = req.query;
    if (date && isNaN(new Date(date).getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid date format. Use YYYY-MM-DD.' });
    }
    const today = new Date();
    const targetDate = date ? new Date(date) : today;
    const todayStr = localDateStr(targetDate);
    const { start: dayStart, end: dayEnd } = zonedDayRange(targetDate);

    // Ensure stale logs are closed before building the dashboard
    await autoCloseStaleLogs();

    const cacheKey = `daily_summary:${todayStr}`;
    let dailyLogs = refresh === 'true' ? null : await cache.get(cacheKey);

    // Get office time settings
    const startSetting = await Setting.findOne({ where: { key: 'office_start_time' } });
    const graceSetting = await Setting.findOne({ where: { key: 'grace_period_minutes' } });
    const officeStartTime = startSetting ? startSetting.value : '09:00';
    const graceMinutes = graceSetting ? parseInt(graceSetting.value) : 10;

    if (!dailyLogs) {
      // ponytail: include overnight shift from yesterday (active or closed today) so dashboard not empty after noon; full fix would be shift-aware todayStr
      const yesterdayStr = addDaysToYmd(todayStr, -1);
      const activeOvernightLogs = await AttendanceLog.findAll({
        where: {
          shiftDate: yesterdayStr,
          [Op.or]: [
            { clockOutTime: null },
            { clockOutTime: { [Op.gte]: dayStart, [Op.lte]: dayEnd } },
          ],
        },
        include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
        order: [['clockInTime', 'DESC']],
      });
      const todayLogs = await AttendanceLog.findAll({
        where: {
          // Attribute each log to the calendar day its clock-in happened on.
          // shiftDate is not included: for overnight shifts a 1 AM clock-in has
          // shiftDate = previous day, and OR-ing it back in would either hide
          // the log from today's view or (as before) double-count it on both
          // days. Every log has exactly one clock-in day.
          clockInTime: {
            [Op.gte]: dayStart,
            [Op.lte]: dayEnd,
          },
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
      // Merge active overnight from yesterday so dashboard not empty after 12pm, then sort by most recent clockIn on top
      const merged = [...activeOvernightLogs, ...todayLogs];
      const deduped = Array.from(new Map(merged.map(l => [l.id, l])).values());
      const logs = deduped.sort((a, b) => new Date(b.clockInTime) - new Date(a.clockInTime));

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
        const uid = log.user.id;
        const partialLeave = partialByUser[uid] || null;

        const clockInTime = log.clockInTime ? new Date(log.clockInTime) : null;
        const snapStart = log.officeStartSnapshot || officeStartTime;
        const [startHour, startMin] = snapStart.split(':').map(Number);
        let isLate = false;
        let lateMinutes = 0;
        if (clockInTime) {
          const snapEndHour = log.officeEndSnapshot ? parseInt(log.officeEndSnapshot.split(':')[0], 10) : null;
          const shiftDate = log.shiftDate || computeShiftDate(clockInTime, snapEndHour);
          const deadline = new Date(deadlineEpoch(shiftDate, startHour, startMin + graceMinutes));
          isLate = clockInTime > deadline;
          lateMinutes = isLate ? Math.floor((clockInTime - deadline) / 60000) : 0;
        }

        let status = log.status;
        if (log.manualStatus === 'PRESENT') {
          status = 'VERIFIED';
          isLate = false;
          lateMinutes = 0;
        } else if (log.manualStatus === 'LATE') {
          status = status === 'ABSENT' ? 'VERIFIED' : status;
          isLate = true;
          lateMinutes = 0;
        } else if (log.manualStatus === 'ABSENT') {
          status = 'ABSENT';
          isLate = false;
          lateMinutes = 0;
        }

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
          status,
          is_late: isLate,
          late_minutes: lateMinutes,
          partial_leave: partialLeave
            ? {
                type: partialLeave.leaveType,
                label: 'Partial Leave',
                from: partialLeave.partialFrom,
                to: partialLeave.partialTo,
              }
            : null,
          shift_date: log.shiftDate,
          manual_status: log.manualStatus,
          is_manual: log.isManual,
          is_auto_closed: log.isAutoClosed,
          edit_reason: log.editReason,
          edited_by: log.editedBy,
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
    user.deviceSecretHash = null;
    await user.save();

    // Close any active attendance logs so the employee can clock in/out
    // with a new device after re-registration. Use shift end time when overdue.
    const openLogs = await AttendanceLog.findAll({
      where: {
        userId: user.id,
        clockOutTime: null,
        isManual: false,
      },
    });
    const { shiftEndEpoch } = require('../utils/date');
    const officeTimes = await require('./leaveController').getOfficeTimes();
    for (const log of openLogs) {
      const shiftDate = log.shiftDate || require('../utils/date').computeShiftDate(new Date(log.clockInTime));
      const shiftEnd = new Date(shiftEndEpoch(shiftDate, officeTimes.start, officeTimes.end));
      const now = new Date();
      // If overnight shift still active, keep it open for new device to clock out; otherwise close at shift end
      if (shiftEnd > now) continue;
      log.clockOutTime = shiftEnd;
      log.isAutoClosed = true;
      log.notes = log.notes ? `${log.notes}; Device reset auto-close` : 'Device reset auto-close';
      await log.save();
    }

    await cache.del(`bound_device:${user.id}`);
    await cache.set(`revoke_trust:${user.id}`, Date.now(), 86400);

    return res.json({
      success: true,
      message: `Device binding reset for ${user.name}.`,
      previous_device_id: previousDevice,
      closed_logs: openLogs.length,
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

    if (office_end_time !== undefined) {
      const newEndHour = parseInt(office_end_time.split(':')[0], 10);
      const activeLogs = await AttendanceLog.findAll({ where: { clockOutTime: null, isManual: false } });
      for (const log of activeLogs) {
        const newShiftDate = computeShiftDate(new Date(log.clockInTime), newEndHour);
        if (newShiftDate !== log.shiftDate) {
          const oldDate = log.shiftDate;
          log.shiftDate = newShiftDate;
          await log.save();
          if (oldDate) await cache.del(`daily_summary:${oldDate}`);
          await cache.del(`daily_summary:${newShiftDate}`);
        }
      }
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

async function addManualPunch(req, res) {
  try {
    const { user_id, shift_date, clock_in, clock_out, status, reason } = req.body;

    if (!user_id || !shift_date) {
      return res.status(400).json({
        success: false,
        message: 'user_id and shift_date are required.',
      });
    }

    const manualStatus = validateManualStatus(status);
    if (!manualStatus) {
      return res.status(400).json({
        success: false,
        message: 'status must be one of PRESENT, LATE, ABSENT.',
      });
    }

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({
        success: false,
        message: 'A reason for the change is required.',
      });
    }

    const user = await User.findByPk(user_id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(shift_date)) {
      return res.status(400).json({ success: false, message: 'Invalid shift_date. Use YYYY-MM-DD.' });
    }

    let clockInTime = combineDateAndTime(shift_date, clock_in);
    let clockOutTime = combineDateAndTime(shift_date, clock_out);
    if (clockInTime && clockOutTime && clockOutTime < clockInTime) {
      if (await isOvernightShift()) {
        clockOutTime = combineDateAndTime(addDaysToYmd(shift_date, 1), clock_out);
      } else {
        return res.status(400).json({
          success: false,
          message: 'Clock-out must be after clock-in.',
        });
      }
    }

    if (manualStatus === 'ABSENT') {
      clockInTime = null;
      clockOutTime = null;
    } else if (!clockInTime || !clockOutTime) {
      return res.status(400).json({
        success: false,
        message: 'clock_in and clock_out are required for PRESENT or LATE punches.',
      });
    }

    const lockKey = `punch_lock:${user_id}:${shift_date}`;
    let acquired = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await cache.setnx(lockKey, 1, 5)) {
        acquired = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    if (!acquired) {
      return res.status(503).json({
        success: false,
        message: 'This record is being updated. Please try again.',
      });
    }

    try {
      const existing = await AttendanceLog.findOne({
        where: { userId: user_id, shiftDate: shift_date },
      });

      const officeTimesForPunch = await (require('./leaveController')).getOfficeTimes();
      const fields = {
        clockInTime,
        clockOutTime,
        manualStatus,
        editReason: String(reason).trim(),
        editedBy: req.user.name || req.user.email || 'Admin',
        editedAt: new Date(),
        officeStartSnapshot: officeTimesForPunch.start,
        officeEndSnapshot: officeTimesForPunch.end,
      };

      let log;
      if (existing) {
        existing.set(fields);
        existing.status = manualStatus === 'ABSENT' ? 'ABSENT' : 'VERIFIED';
        log = await existing.save();
      } else {
        log = await AttendanceLog.create({
          userId: user_id,
          shiftDate: shift_date,
          ipAddress: 'MANUAL',
          deviceIdUsed: 'MANUAL',
          status: manualStatus === 'ABSENT' ? 'ABSENT' : 'VERIFIED',
          isManual: true,
          ...fields,
        });
      }

      await cache.del(`daily_summary:${shift_date}`);

      return res.status(existing ? 200 : 201).json({
        success: true,
        message: existing ? 'Attendance record updated.' : 'Manual punch recorded.',
        data: {
          id: log.id,
          user_id,
          shift_date,
          manual_status: log.manualStatus,
          edit_reason: log.editReason,
          edited_by: log.editedBy,
        },
      });
    } finally {
      await cache.del(lockKey);
    }
  } catch (err) {
    console.error('Add manual punch error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while recording the manual punch.',
    });
  }
}

async function editAttendanceLog(req, res) {
  try {
    const { logId } = req.params;
    const { clock_in, clock_out, status, reason } = req.body;

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({
        success: false,
        message: 'A reason for the change is required.',
      });
    }

    if (status === undefined) {
      return res.status(400).json({
        success: false,
        message: 'status is required.',
      });
    }

    const manualStatus = status === 'AUTO' ? null : validateManualStatus(status);
    if (status !== 'AUTO' && !manualStatus) {
      return res.status(400).json({
        success: false,
        message: 'status must be one of PRESENT, LATE, ABSENT, or AUTO.',
      });
    }

    const log = await AttendanceLog.findByPk(logId);
    if (!log) {
      return res.status(404).json({ success: false, message: 'Attendance log not found.' });
    }

    const baseDate = log.shiftDate || localDateStr(log.clockInTime || new Date());
    const previousDate = log.shiftDate || (log.clockInTime ? localDateStr(log.clockInTime) : null);

    if (Object.prototype.hasOwnProperty.call(req.body, 'clock_in')) {
      log.clockInTime = combineDateAndTime(baseDate, clock_in);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'clock_out')) {
      log.clockOutTime = combineDateAndTime(baseDate, clock_out);
    }

    if (log.clockInTime && log.clockOutTime && log.clockOutTime < log.clockInTime) {
      if (await isOvernightShift()) {
        log.clockOutTime = combineDateAndTime(addDaysToYmd(baseDate, 1), req.body.clock_out);
      } else {
        return res.status(400).json({
          success: false,
          message: 'Clock-out must be after clock-in.',
        });
      }
    }

    if (manualStatus === 'ABSENT') {
      log.clockInTime = null;
      log.clockOutTime = null;
    } else if ((manualStatus === 'PRESENT' || manualStatus === 'LATE') && (!log.clockInTime || !log.clockOutTime)) {
      return res.status(400).json({
        success: false,
        message: 'Clock-in and clock-out times are required for PRESENT or LATE corrections.',
      });
    }

    log.manualStatus = manualStatus;
    if (manualStatus === 'ABSENT') {
      log.status = 'ABSENT';
    } else if (manualStatus === 'PRESENT' || manualStatus === 'LATE') {
      log.status = 'VERIFIED';
    }
    log.editReason = String(reason).trim();
    log.editedBy = req.user.name || req.user.email || 'Admin';
    log.editedAt = new Date();

    await log.save();

    if (baseDate) await cache.del(`daily_summary:${baseDate}`);
    if (previousDate && previousDate !== baseDate) await cache.del(`daily_summary:${previousDate}`);

    return res.json({
      success: true,
      message: 'Attendance record updated.',
      data: {
        id: log.id,
        manual_status: log.manualStatus,
        edit_reason: log.editReason,
        edited_by: log.editedBy,
      },
    });
  } catch (err) {
    console.error('Edit attendance log error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while updating the attendance record.',
    });
  }
}

async function deleteAttendanceLog(req, res) {
  try {
    const { logId } = req.params;

    const log = await AttendanceLog.findByPk(logId);
    if (!log) {
      return res.status(404).json({ success: false, message: 'Attendance log not found.' });
    }

    const date = log.shiftDate || (log.clockInTime ? localDateStr(log.clockInTime) : null);
    const { sequelize } = require('../models');
    await sequelize.transaction(async (t) => {
      await require('../models').AuditLog.create({
        adminId: req.user.id,
        action: 'DELETE_ATTENDANCE_LOG',
        targetUserId: log.userId,
        details: JSON.stringify({ log_id: log.id, shift_date: log.shiftDate, clock_in: log.clockInTime }),
      }, { transaction: t });
      await log.destroy({ transaction: t });
    });
    if (date) await cache.del(`daily_summary:${date}`);

    return res.json({ success: true, message: 'Attendance record deleted.' });
  } catch (err) {
    console.error('Delete attendance log error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while deleting the attendance record.',
    });
  }
}

async function exportCsv(req, res) {
  try {
    const { startDate, endDate } = req.query;
    const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
    if ((startDate && !ymdRe.test(startDate)) || (endDate && !ymdRe.test(endDate))) {
      return res.status(400).json({ success: false, message: 'Invalid date. Use YYYY-MM-DD.' });
    }

    const where = {};
    const legacyClockInWhere = {};
    let shiftDateRange = null;

    if (startDate && endDate) {
      shiftDateRange = { [Op.gte]: startDate, [Op.lte]: endDate };
      legacyClockInWhere.clockInTime = {
        [Op.gte]: new Date(startDate),
        // Inclusive end date in UTC.
        [Op.lt]: new Date(addDaysToYmd(endDate, 1)),
      };
    } else if (startDate) {
      shiftDateRange = { [Op.gte]: startDate };
      legacyClockInWhere.clockInTime = { [Op.gte]: new Date(startDate) };
    } else if (endDate) {
      shiftDateRange = { [Op.lte]: endDate };
      legacyClockInWhere.clockInTime = {
        [Op.lt]: new Date(addDaysToYmd(endDate, 1)),
      };
    }

    if (shiftDateRange) {
      where[Op.or] = [
        { shiftDate: shiftDateRange },
        { shiftDate: null, ...legacyClockInWhere },
      ];
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
      order: [['shiftDate', 'ASC'], ['clockInTime', 'ASC']],
    });

    // Get office time settings and calculate late status
    const startSetting = await Setting.findOne({ where: { key: 'office_start_time' } });
    const graceSetting = await Setting.findOne({ where: { key: 'grace_period_minutes' } });
    const officeStartTime = startSetting ? startSetting.value : '09:00';
    const graceMinutes = graceSetting ? parseInt(graceSetting.value) : 10;
    const [startH, startM] = officeStartTime.split(':').map(Number);

    const csvData = logs.map((log) => {
      const date = log.shiftDate || (log.clockInTime ? localDateStr(log.clockInTime) : '');
      let late = 'No';
      if (log.clockInTime && date) {
        const snapStart = log.officeStartSnapshot || officeStartTime;
        const [snapH, snapM] = snapStart.split(':').map(Number);
        const clockInEpoch = new Date(log.clockInTime).getTime();
        const deadline = deadlineEpoch(date, snapH, snapM + graceMinutes);
        if (clockInEpoch > deadline) {
          const lateMin = Math.floor((clockInEpoch - deadline) / 60000);
          late = `Yes (${lateMin} min)`;
        }
      }

      return {
        date,
        employee_name: log.user?.name || 'Unknown',
        employee_email: log.user?.email || 'Unknown',
        clock_in_time: log.clockInTime ? formatDateTime(log.clockInTime) : '',
        clock_out_time: log.clockOutTime ? formatDateTime(log.clockOutTime) : '',
        work_duration: log.clockOutTime
          ? calculateDuration(log.clockInTime, log.clockOutTime)
          : '',
        ip_address: log.ipAddress,
        device_id: log.deviceIdUsed,
        status: log.manualStatus || log.status,
        late,
      };
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

    const officeTimes = await (require('./leaveController')).getOfficeTimes();
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
        status: 'Approved',
        [Op.or]: [
          { startDate: { [Op.lte]: monthEndStr }, endDate: { [Op.gte]: monthStartStr } },
        ],
      },
      order: [['startDate', 'ASC']],
    });

    const partialLeaves = leaves.filter(l => l.leaveType === 'partial');
    const fullDayLeaves = leaves.filter(l => l.leaveType !== 'partial');

    const holidays = await Holiday.findAll({
      where: { date: { [Op.gte]: monthStartStr, [Op.lte]: monthEndStr } },
    });
    const holidayDates = new Set(holidays.map(h => h.date));

    const totalWorkdays = countWeekdays(monthStart, monthEnd, holidayDates);

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
      if (holidayDates.has(dateStr)) continue;

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

        if (clockIn) {
          const shiftDate = dayLog.shiftDate || localDateStr(new Date(clockIn));
          const snapStart = dayLog.officeStartSnapshot || officeStart;
          const [snapH, snapM] = snapStart.split(':').map(Number);
          const deadline = new Date(deadlineEpoch(shiftDate, snapH, snapM + graceMinutes));
          if (new Date(clockIn) > deadline) {
            isLate = true;
            lateMin = Math.floor((new Date(clockIn) - deadline) / 60000);
          }
        }

        if (clockIn && clockOut) {
          duration = calculateDuration(clockIn, clockOut);
          totalWorkMinutes += (new Date(clockOut) - new Date(clockIn)) / 60000;
        }

        if (dayLog.manualStatus === 'PRESENT') {
          isLate = false;
          lateMin = 0;
          status = 'VERIFIED';
        } else if (dayLog.manualStatus === 'LATE') {
          isLate = false;
          lateMin = 0;
          status = 'LATE';
        } else if (dayLog.manualStatus === 'ABSENT') {
          isLate = false;
          lateMin = 0;
          status = 'ABSENT';
        }

        if (status === 'LATE') {
          late++;
          totalLateMinutes += lateMin;
        } else if (status === 'VERIFIED') {
          present++;
        } else if (status === 'ABSENT') {
          absent++;
        }
      } else {
        absent++;
      }

      if (dayPartial) partialLeaveDays++;

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

function countWeekdays(start, end, holidayDates) {
  let count = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      if (holidayDates && holidayDates.has(localDateStr(d))) continue;
      count++;
    }
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

    if (user.role === 'superadmin') {
      return res.status(400).json({
        success: false,
        message: 'Super Admin accounts cannot be deleted.',
      });
    }

    const { sequelize } = require('../models');
    await sequelize.transaction(async (t) => {
      await AttendanceLog.destroy({ where: { userId }, transaction: t });
      await Leave.destroy({ where: { userId }, transaction: t });
      await user.destroy({ transaction: t });
      await require('../models').AuditLog.create({
        adminId: req.user.id,
        action: 'DELETE_USER',
        targetUserId: userId,
        details: JSON.stringify({ email: user.email, role: user.role }),
      }, { transaction: t });
    });
    await cache.del(`bound_device:${userId}`);

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

    await autoCloseStaleLogs();

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
        status: 'Approved',
        [Op.or]: [
          { startDate: { [Op.lte]: monthEndStr }, endDate: { [Op.gte]: monthStartStr } },
        ],
      },
      order: [['startDate', 'ASC']],
    });

    const partialLeaves = leaves.filter(l => l.leaveType === 'partial');
    const fullDayLeaves = leaves.filter(l => l.leaveType !== 'partial');

    const holidays = await Holiday.findAll({
      where: { date: { [Op.gte]: monthStartStr, [Op.lte]: monthEndStr } },
    });
    const holidayDates = new Set(holidays.map(h => h.date));

    const totalWorkdays = countWeekdays(monthStart, monthEnd, holidayDates);

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
      let sickLeaveDays = 0;
      let paidLeaveDays = 0;
      let unpaidLeaveDays = 0;
      let totalWorkMinutes = 0;

      for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
        const dateStr = localDateStr(d);
        const dayOfWeek = d.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;
        if (holidayDates.has(dateStr)) continue;

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
          if (dayLeave.leaveType === 'sick') sickLeaveDays++;
          else if (dayLeave.leaveType === 'paid') paidLeaveDays++;
          else if (dayLeave.leaveType === 'unpaid') unpaidLeaveDays++;
        } else if (dayLog) {
          const clockIn = dayLog.clockInTime ? new Date(dayLog.clockInTime) : null;
          const clockOut = dayLog.clockOutTime;
          kpiTotalShifts++;

          if (dayLog.manualStatus === 'ABSENT') {
            absentCount++;
          } else if (dayLog.manualStatus === 'LATE') {
            lateCount++;
            kpiTotalLate++;
          } else if (dayLog.manualStatus === 'PRESENT') {
            present++;
            kpiTotalOnTime++;
          } else if (clockIn) {
            const shiftDate = dayLog.shiftDate || localDateStr(clockIn);
            const snapStart = dayLog.officeStartSnapshot || officeStartTime;
            const [snapH, snapM] = snapStart.split(':').map(Number);
            const deadline = new Date(deadlineEpoch(shiftDate, snapH, snapM + graceMinutes));
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
        sick_leaves: sickLeaveDays,
        paid_leaves: paidLeaveDays,
        unpaid_leaves: unpaidLeaveDays,
        partial_leaves: partialLeaveCount,
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
          { shiftDate: { [Op.gte]: monthStartStr, [Op.lte]: monthEndStr } },
          { shiftDate: null, clockInTime: { [Op.gte]: monthStart, [Op.lte]: monthEnd } },
          { status: 'ON_LEAVE', createdAt: { [Op.gte]: monthStart, [Op.lte]: monthEnd } },
        ],
      },
      order: [['clockInTime', 'ASC']],
    });

    const leaves = await Leave.findAll({
      where: {
        userId: { [Op.in]: employees.map(e => e.id) },
        status: 'Approved',
        [Op.or]: [
          { startDate: { [Op.lte]: monthEndStr }, endDate: { [Op.gte]: monthStartStr } },
        ],
      },
      order: [['startDate', 'ASC']],
    });

const partialLeaves = leaves.filter(l => l.leaveType === 'partial');
    const fullDayLeaves = leaves.filter(l => l.leaveType !== 'partial');

    const holidays = await Holiday.findAll({
      where: { date: { [Op.gte]: monthStartStr, [Op.lte]: monthEndStr } },
    });
    const holidayDates = new Set(holidays.map(h => h.date));

    const totalWorkdays = countWeekdays(monthStart, monthEnd, holidayDates);

    const csvData = employees.map(emp => {
      const empLogs = logs.filter(l => l.userId === emp.id);
      const empFullLeaves = fullDayLeaves.filter(l => l.userId === emp.id);
      const empPartialLeaves = partialLeaves.filter(l => l.userId === emp.id);

      let present = 0;
      let lateCount = 0;
      let onLeaveCount = 0;
      let absentCount = 0;
      let partialLeaveCount = 0;
      let sickLeaveDays = 0;
      let paidLeaveDays = 0;
      let unpaidLeaveDays = 0;
      let totalWorkMinutes = 0;

      for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
        const dateStr = localDateStr(d);
        const dayOfWeek = d.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;
        if (holidayDates.has(dateStr)) continue;

        const dayLog = empLogs.find(l => {
          if (l.shiftDate) return l.shiftDate === dateStr;
          if (!l.clockInTime) return false;
          return localDateStr(l.clockInTime) === dateStr;
        });

        const dayLeave = empFullLeaves.find(l => dateStr >= l.startDate && dateStr <= l.endDate);
        const dayPartial = empPartialLeaves.find(l => dateStr >= l.startDate && dateStr <= l.endDate);

        if (dayLeave) {
          onLeaveCount++;
          if (dayLeave.leaveType === 'sick') sickLeaveDays++;
          else if (dayLeave.leaveType === 'paid') paidLeaveDays++;
          else if (dayLeave.leaveType === 'unpaid') unpaidLeaveDays++;
        } else if (dayLog) {
          const clockIn = dayLog.clockInTime ? new Date(dayLog.clockInTime) : null;
          const clockOut = dayLog.clockOutTime;

          if (dayLog.manualStatus === 'ABSENT') {
            absentCount++;
          } else if (dayLog.manualStatus === 'LATE') {
            lateCount++;
          } else if (dayLog.manualStatus === 'PRESENT') {
            present++;
          } else if (clockIn) {
            const snapStart = dayLog.officeStartSnapshot || officeStartTime;
            const [snapH, snapM] = snapStart.split(':').map(Number);
            const deadline = new Date(deadlineEpoch(dateStr, snapH, snapM + graceMinutes));
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
        employee_name: emp.name || 'Unknown',
        employee_email: emp.email || 'Unknown',
        total_workdays: totalWorkdays,
        days_present: present + lateCount,
        total_hours: `${totalHours}h ${totalMins}m`,
        on_time_days: present,
        late_days: lateCount,
        sick_leave: sickLeaveDays,
        paid_leave: paidLeaveDays,
        unpaid_leave: unpaidLeaveDays,
        partial_leave: partialLeaveCount,
        absent_days: absentCount,
      };
    });

    const fields = [
      { label: 'Employee Name', value: 'employee_name' },
      { label: 'Email Address', value: 'employee_email' },
      { label: 'Total Workdays', value: 'total_workdays' },
      { label: 'Days Present', value: 'days_present' },
      { label: 'Total Hours', value: 'total_hours' },
      { label: 'On-Time Days', value: 'on_time_days' },
      { label: 'Late Days', value: 'late_days' },
      { label: 'Sick Leave', value: 'sick_leave' },
      { label: 'Paid Leave', value: 'paid_leave' },
      { label: 'Unpaid Leave', value: 'unpaid_leave' },
      { label: 'Partial Leave', value: 'partial_leave' },
      { label: 'Absent Days', value: 'absent_days' },
    ];
    const parser = new Parser({ fields, delimiter: ',', quote: '"' });
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

function isDhakaWeekend(dateStr) {
  const noon = new Date(deadlineEpoch(dateStr, 12, 0));
  const wd = formatWeekday(noon);
  return wd === 'Saturday' || wd === 'Sunday';
}

function leaveLabel(type) {
  if (type === 'partial') return 'Partial Leave';
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} Leave`;
}

async function buildDailyReportData(dateStr) {
  await autoCloseStaleLogs();

  const targetDate = dateStr ? new Date(dateStr) : new Date();
  const todayStr = localDateStr(targetDate);
  const { start: dayStart, end: dayEnd } = zonedDayRange(targetDate);

  const officeTimes = await (require('./leaveController')).getOfficeTimes();
  const officeStartTime = officeTimes.start;
  const [startH, startM] = officeStartTime.split(':').map(Number);
  const graceSetting = await Setting.findOne({ where: { key: 'grace_period_minutes' } });
  const graceMinutes = graceSetting ? parseInt(graceSetting.value) : 10;

  const employees = await User.findAll({
    where: { role: 'employee' },
    attributes: ['id', 'name', 'email'],
    order: [['name', 'ASC']],
  });

  const logs = await AttendanceLog.findAll({
    where: {
      userId: { [Op.in]: employees.map(e => e.id) },
      // Attribute each log to its clock-in calendar day (see adminDashboard).
      clockInTime: { [Op.gte]: dayStart, [Op.lte]: dayEnd },
    },
    order: [['clockInTime', 'ASC']],
  });

  const leaves = await Leave.findAll({
    where: {
      userId: { [Op.in]: employees.map(e => e.id) },
      status: 'Approved',
      startDate: { [Op.lte]: todayStr },
      endDate: { [Op.gte]: todayStr },
    },
  });

  const holidays = await Holiday.findAll({ where: { date: todayStr } });
  const isHoliday = holidays.length > 0;
  const isWeekend = isDhakaWeekend(todayStr);

  const logByUser = new Map(logs.map(l => [l.userId, l]));
  const leaveByUser = new Map();
  leaves.forEach(l => { if (!leaveByUser.has(l.userId)) leaveByUser.set(l.userId, l); });

  const rows = employees.map(emp => {
    const log = logByUser.get(emp.id);
    const leave = leaveByUser.get(emp.id);

    let status = 'ABSENT';
    let leaveType = null;
    let clockIn = null;
    let clockOut = null;
    let duration = null;
    let isLate = false;
    let lateMinutes = 0;

    if (isHoliday) {
      status = 'HOLIDAY';
    } else if (isWeekend) {
      status = 'WEEKEND';
    } else if (leave) {
      status = leave.leaveType === 'partial' ? 'PARTIAL_LEAVE' : 'ON_LEAVE';
      leaveType = leave.leaveType;
    } else if (log) {
      clockIn = log.clockInTime;
      clockOut = log.clockOutTime;
      if (clockIn && clockOut) duration = calculateDuration(clockIn, clockOut);

      if (log.manualStatus === 'PRESENT') {
        status = 'VERIFIED';
      } else if (log.manualStatus === 'LATE') {
        status = 'VERIFIED';
        isLate = true;
      } else if (log.manualStatus === 'ABSENT') {
        status = 'ABSENT';
      } else {
        status = log.status === 'REJECTED' ? 'REJECTED' : 'VERIFIED';
        if (clockIn) {
          const clockInDate = new Date(clockIn);
          const snapEndHour = log.officeEndSnapshot ? parseInt(log.officeEndSnapshot.split(':')[0], 10) : null;
          const shiftDate = log.shiftDate || computeShiftDate(clockInDate, snapEndHour);
          const snapStart = log.officeStartSnapshot || officeStartTime;
          const [snapH, snapM] = snapStart.split(':').map(Number);
          const logDeadline = new Date(deadlineEpoch(shiftDate, snapH, snapM + graceMinutes));
          isLate = clockInDate > logDeadline;
          lateMinutes = isLate ? Math.floor((clockInDate - logDeadline) / 60000) : 0;
        }
      }
    }

    return {
      id: emp.id,
      name: emp.name,
      email: emp.email,
      status,
      leave_type: leaveType,
      leave_label: leaveType ? leaveLabel(leaveType) : null,
      clock_in_time: clockIn,
      clock_out_time: clockOut,
      duration,
      is_late: isLate,
      late_minutes: lateMinutes,
      is_auto_closed: log ? log.isAutoClosed : false,
    };
  });

  const kpi = {
    present: rows.filter(r => r.status === 'VERIFIED' && !r.is_late).length,
    late: rows.filter(r => r.is_late).length,
    absent: rows.filter(r => r.status === 'ABSENT').length,
    on_leave: rows.filter(r => r.status === 'ON_LEAVE').length,
    partial_leave: rows.filter(r => r.status === 'PARTIAL_LEAVE').length,
    holiday: rows.filter(r => r.status === 'HOLIDAY').length,
    weekend: rows.filter(r => r.status === 'WEEKEND').length,
  };

  return { todayStr, rows, kpi, officeStartTime };
}

async function getDailyReport(req, res) {
  try {
    const { date } = req.query;
    const data = await buildDailyReportData(date);
    return res.json({ success: true, data: { ...data, date: data.todayStr } });
  } catch (err) {
    console.error('Get daily report error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

async function exportDailyReportCsv(req, res) {
  try {
    const { date } = req.query;
    const { todayStr, rows } = await buildDailyReportData(date);

    const csvData = rows.map(r => ({
      Employee: r.name,
      Email: r.email,
      Status: r.status,
      'Leave Type': r.leave_label || '',
      'Clock In': r.clock_in_time ? formatTime(r.clock_in_time) : '',
      'Clock Out': r.clock_out_time ? formatTime(r.clock_out_time) : '',
      Duration: r.duration || '',
      Late: r.is_late ? `${r.late_minutes}m` : 'No',
    }));

    const csv = new Parser().parse(csvData);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="daily_report_${todayStr}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('Export daily report CSV error:', err);
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
  getDailyReport,
  exportDailyReportCsv,
  addManualPunch,
  editAttendanceLog,
  deleteAttendanceLog,
  resetUserPassword,
  getHolidays,
  createHoliday,
  deleteHoliday,
  getAuditLogs,
};

async function getAuditLogs(req, res) {
  try {
    const { limit } = req.query;
    const max = Math.min(parseInt(limit) || 50, 200);

    const logs = await AuditLog.findAll({
      order: [['createdAt', 'DESC']],
      limit: max,
      include: [
        {
          model: User,
          as: 'admin',
          attributes: ['id', 'name', 'email'],
          required: false,
        },
        {
          model: User,
          as: 'targetUser',
          attributes: ['id', 'name', 'email'],
          required: false,
        },
      ],
    });

    return res.json({
      success: true,
      data: logs.map((l) => ({
        id: l.id,
        admin_id: l.adminId,
        admin: l.admin ? { id: l.admin.id, name: l.admin.name, email: l.admin.email } : null,
        target_user_id: l.targetUserId,
        target: l.targetUser ? { id: l.targetUser.id, name: l.targetUser.name, email: l.targetUser.email } : null,
        action: l.action,
        details: (() => { try { return JSON.parse(l.details); } catch { return l.details; } })(),
        created_at: l.createdAt,
      })),
    });
  } catch (err) {
    console.error('Get audit logs error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

async function getHolidays(req, res) {
  try {
    const holidays = await Holiday.findAll({
      order: [['date', 'ASC']],
    });
    return res.json({
      success: true,
      data: holidays.map(h => ({
        id: h.id,
        date: h.date,
        name: h.name,
      })),
    });
  } catch (err) {
    console.error('Get holidays error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

async function createHoliday(req, res) {
  try {
    const { date, name } = req.body || {};

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ success: false, message: 'A valid holiday date (YYYY-MM-DD) is required.' });
    }

    const holidayName = name ? String(name).trim() : '';
    if (!holidayName) {
      return res.status(400).json({ success: false, message: 'A holiday name is required.' });
    }

    const existing = await Holiday.findOne({ where: { date } });
    if (existing) {
      existing.name = holidayName;
      await existing.save();
      return res.status(200).json({
        success: true,
        message: 'Holiday updated successfully.',
        data: { id: existing.id, date: existing.date, name: existing.name },
      });
    }

    const holiday = await Holiday.create({ date, name: holidayName });
    return res.status(201).json({
      success: true,
      message: 'Holiday added successfully.',
      data: { id: holiday.id, date: holiday.date, name: holiday.name },
    });
  } catch (err) {
    console.error('Create holiday error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

async function deleteHoliday(req, res) {
  try {
    const { holidayId } = req.params;
    const holiday = await Holiday.findByPk(holidayId);
    if (!holiday) {
      return res.status(404).json({ success: false, message: 'Holiday not found.' });
    }
    await holiday.destroy();
    return res.status(200).json({ success: true, message: 'Holiday deleted successfully.' });
  } catch (err) {
    console.error('Delete holiday error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

async function resetUserPassword(req, res) {
  try {
    const { userId } = req.params;
    const { password } = req.body || {};

    const target = await User.findByPk(userId);

    if (!target) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    if (target.role === 'admin' || target.role === 'superadmin') {
      return res.status(400).json({
        success: false,
        message: 'Admin passwords cannot be reset from this panel.',
      });
    }

    let tempPassword = password ? String(password).trim() : '';

    if (tempPassword && tempPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Custom password must be at least 8 characters long.',
      });
    }

    if (!tempPassword) {
      tempPassword = crypto
        .randomBytes(9)
        .toString('base64')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 12);
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    target.password = await bcrypt.hash(tempPassword, saltRounds);
    target.mustChangePassword = true;
    target.passwordChangedAt = new Date();
    await target.save();

    return res.json({
      success: true,
      message:
        'Password reset. The employee must change it on their next login.',
      temporary_password: tempPassword,
      must_change_password: true,
    });
  } catch (err) {
    console.error('Reset user password error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while resetting the password.',
    });
  }
}
