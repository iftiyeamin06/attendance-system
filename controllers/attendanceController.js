const { User, AttendanceLog, Setting, Leave } = require('../models');
const cache = require('../redis/cache');
const { extractClientIp } = require('../middleware/ipValidation');
const { getOfficeTimes } = require('./leaveController');
const { Op } = require('sequelize');
const { localDateStr, computeShiftDate, deadlineEpoch, shiftEndEpoch, zonedDayRange } = require('../utils/date');

async function clockIn(req, res) {
  const { sequelize } = require('../models');
  try {
    const user = req.user;
    const deviceUuid = req.headers['x-device-uuid'];
    const clientIp = extractClientIp(req);
    const todayStr = localDateStr(new Date());
    const shiftDate = computeShiftDate(new Date());

    const todayLeave = await Leave.findOne({
      where: {
        userId: user.id,
        leaveType: { [Op.ne]: 'partial' },
        status: 'Approved',
        startDate: { [Op.lte]: todayStr },
        endDate: { [Op.gte]: todayStr },
      },
    });
    if (todayLeave) {
      return res.status(400).json({ success: false, message: 'You are currently marked as On Leave today.' });
    }

    // Serialize clock-in per user to prevent duplicate logs on double-tap / concurrent requests
    const result = await sequelize.transaction(async (t) => {
      const activeLog = await AttendanceLog.findOne({
        where: { userId: user.id, status: 'VERIFIED', clockOutTime: null, isManual: { [Op.ne]: true } },
        order: [['clockInTime', 'DESC']],
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      let autoClosedLog = null;
      if (activeLog) {
        const activeShift = activeLog.shiftDate || computeShiftDate(new Date(activeLog.clockInTime));
        if (activeShift === shiftDate) {
          const err = new Error('ALREADY_CLOCKED_IN');
          err.code = 'ALREADY_CLOCKED_IN';
          err.log = activeLog;
          throw err;
        }
        const officeTimes = await getOfficeTimes();
        const [startH, startM] = officeTimes.start.split(':').map(Number);
        const [endH, endM] = officeTimes.end.split(':').map(Number);
        const prevShiftEnd = Number.isInteger(endH) && Number.isInteger(endM) && Number.isInteger(startH) && Number.isInteger(startM)
          ? new Date(shiftEndEpoch(activeShift, officeTimes.start, officeTimes.end))
          : new Date();
        activeLog.clockOutTime = prevShiftEnd.getTime() < Date.now() ? prevShiftEnd : new Date();
        await activeLog.save({ transaction: t });
        autoClosedLog = activeLog;
        await cache.del(`daily_summary:${activeShift}`);
      }

      const log = await AttendanceLog.create({
        userId: user.id,
        clockInTime: new Date(),
        shiftDate,
        ipAddress: clientIp,
        deviceIdUsed: deviceUuid,
        status: 'VERIFIED',
      }, { transaction: t });

      return { log, autoClosedLog };
    });

    await cache.del(`daily_summary:${todayStr}`);

    return res.status(200).json({
      success: true,
      message: 'Clock-in recorded successfully.',
      data: {
        log_id: result.log.id,
        clock_in_time: result.log.clockInTime,
        ip_address: result.log.ipAddress,
        device_id: result.log.deviceIdUsed,
        device_secret: req.deviceValidationResult?.deviceSecret || null,
        device_trust: req.deviceValidationResult?.trustLevel || 'trusted',
        auto_closed_log: result.autoClosedLog ? { log_id: result.autoClosedLog.id, clock_in_time: result.autoClosedLog.clockInTime, clock_out_time: result.autoClosedLog.clockOutTime, shift_date: result.autoClosedLog.shiftDate } : null,
      },
    });
  } catch (err) {
    if (err.code === 'ALREADY_CLOCKED_IN') {
      return res.status(409).json({
        success: false,
        message: 'You already have an active clock-in. Please clock out before starting a new shift.',
        log_id: err.log.id,
        clock_in_time: err.log.clockInTime,
        shift_date: err.log.shiftDate,
      });
    }
    console.error('Clock-in error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred during clock-in.' });
  }
}

async function clockOut(req, res) {
  const { sequelize } = require('../models');
  try {
    const user = req.user;
    const deviceUuid = req.headers['x-device-uuid'];

    const result = await sequelize.transaction(async (t) => {
      const log = await AttendanceLog.findOne({
        where: { userId: user.id, status: 'VERIFIED', clockOutTime: null, isManual: { [Op.ne]: true } },
        order: [['clockInTime', 'DESC']],
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!log) {
        const err = new Error('NO_ACTIVE_LOG');
        err.code = 'NO_ACTIVE_LOG';
        throw err;
      }
      if (log.deviceIdUsed !== deviceUuid) {
        const trustCookie = req.trustCookie || null;
        if (trustCookie && trustCookie.dev === deviceUuid) {
          log.deviceIdUsed = deviceUuid;
        } else {
          const err = new Error('UNREGISTERED_DEVICE');
          err.code = 'UNREGISTERED_DEVICE';
          throw err;
        }
      }
      log.clockOutTime = new Date();
      await log.save({ transaction: t });
      return log;
    });
    const log = result;

    await cache.del(`daily_summary:${localDateStr(new Date(log.clockInTime))}`);

    // Calculate shift duration using office hours so overnight shifts
    // (e.g. 20:00-05:00) get the correct office-aligned duration.
    const officeTimes = await getOfficeTimes();
    const shiftDate = log.shiftDate || computeShiftDate(new Date(log.clockInTime));
    const shiftEndMs = shiftEndEpoch(shiftDate, officeTimes.start, officeTimes.end);
    const shiftEnd = new Date(shiftEndMs);
    const workedMs = new Date(log.clockOutTime) - new Date(log.clockInTime);

    const workedMinutes = Math.floor(workedMs / 60000);
    const totalHours = Math.floor(workedMinutes / 60);
    const totalMins = workedMinutes % 60;

    return res.json({
      success: true,
      message: 'Clock-out recorded successfully.',
      data: {
        log_id: log.id,
        clock_in_time: log.clockInTime,
        clock_out_time: log.clockOutTime,
        shift_date: shiftDate,
        shift_end: shiftEnd.toISOString(),
        work_duration: calculateDuration(log.clockInTime, log.clockOutTime),
        total_worked: `${totalHours}h ${totalMins}m`,
        device_secret: req.deviceValidationResult?.deviceSecret || null,
        device_trust: req.deviceValidationResult?.trustLevel || 'trusted',
      },
    });
  } catch (err) {
    if (err.code === 'NO_ACTIVE_LOG') {
      return res.status(400).json({ success: false, message: 'No active clock-in found.' });
    }
    if (err.code === 'UNREGISTERED_DEVICE') {
      return res.status(403).json({ success: false, message: 'Unregistered Device. You can only clock out from your registered smartphone.', error_code: 'UNREGISTERED_DEVICE' });
    }
    console.error('Clock-out error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred during clock-out.' });
  }
}

function calculateDuration(clockIn, clockOut) {
  const diffMs = new Date(clockOut) - new Date(clockIn);
  if (diffMs <= 0) return '0h 0m';
  const hours = Math.floor(diffMs / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

async function getTodayStatus(req, res) {
  try {
    const user = req.user;
    const todayStr = localDateStr(new Date());
    const targetShiftDate = computeShiftDate(new Date());

    const onLeaveLog = await AttendanceLog.findOne({
      where: {
        userId: user.id,
        status: 'ON_LEAVE',
      },
      order: [['createdAt', 'DESC']],
    });

    const todayLeave = await Leave.findOne({
      where: {
        userId: user.id,
        leaveType: { [Op.ne]: 'partial' },
        status: 'Approved',
        startDate: { [Op.lte]: todayStr },
        endDate: { [Op.gte]: todayStr },
      },
    });

    const isOnLeave = !!todayLeave;

    const activeLog = isOnLeave ? onLeaveLog : await AttendanceLog.findOne({
      where: {
        userId: user.id,
        status: 'VERIFIED',
        clockOutTime: null,
        isManual: { [Op.ne]: true },
      },
      order: [['clockInTime', 'DESC']],
    });

    const log = activeLog || await AttendanceLog.findOne({
      where: {
        userId: user.id,
        shiftDate: targetShiftDate,
      },
      order: [['clockInTime', 'DESC']],
    });

    const officeTimes = await getOfficeTimes();
    const officeStartTime = officeTimes.start;

    const graceSetting = await Setting.findOne({ where: { key: 'grace_period_minutes' } });
    const graceMinutes = graceSetting ? parseInt(graceSetting.value) : 10;

    const partialLeave = await Leave.findOne({
      where: {
        userId: user.id,
        leaveType: 'partial',
        startDate: { [Op.lte]: todayStr },
        endDate: { [Op.gte]: todayStr },
      },
    });

    const [startHour, startMin] = officeStartTime.split(':').map(Number);

    if (!log) {
      return res.json({
        success: true,
        status: 'NOT_CLOCKED_IN',
        clocked_in: false,
        on_leave: false,
        partial_leave: partialLeave
          ? {
              type: partialLeave.leaveType,
              label: 'Partial Leave',
              from: partialLeave.partialFrom,
              to: partialLeave.partialTo,
            }
          : null,
        message: 'You have not clocked in today.',
        office_start_time: officeStartTime,
        grace_period_minutes: graceMinutes,
      });
    }

    if (log.status === 'ON_LEAVE') {
      return res.json({
        success: true,
        clocked_in: false,
        on_leave: true,
        message: 'You are on leave today.',
        office_start_time: officeStartTime,
        grace_period_minutes: graceMinutes,
      });
    }

    const clockIn = new Date(log.clockInTime);
    const shiftDate = log.shiftDate || computeShiftDate(clockIn);
    const deadline = new Date(deadlineEpoch(shiftDate, startHour, startMin + graceMinutes));
    const isLate = clockIn > deadline;
    const lateMinutes = isLate ? Math.floor((clockIn - deadline) / 60000) : 0;

    return res.json({
      success: true,
      clocked_in: !log.clockOutTime,
      clocked_out: !!log.clockOutTime,
      on_leave: false,
      clock_in_time: log.clockInTime,
      clock_out_time: log.clockOutTime || null,
      work_duration: log.clockOutTime
        ? calculateDuration(log.clockInTime, log.clockOutTime)
        : null,
      partial_leave: partialLeave
        ? {
            type: partialLeave.leaveType,
            label: 'Partial Leave',
            from: partialLeave.partialFrom,
            to: partialLeave.partialTo,
          }
        : null,
      is_late: isLate,
      late_minutes: lateMinutes,
      office_start_time: officeStartTime,
      grace_period_minutes: graceMinutes,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'An error occurred.',
    });
  }
}

async function getAttendanceLogs(req, res) {
  try {
    const user = req.user;
    const { date } = req.query;

    const where = { userId: user.id };

    if (date) {
      if (isNaN(new Date(date).getTime())) return res.status(400).json({ success: false, message: 'Invalid date. Use YYYY-MM-DD.' });
      const { start: dayStart, end: dayEnd } = zonedDayRange(new Date(date));
      where.clockInTime = {
        [Op.gte]: dayStart,
        [Op.lte]: dayEnd,
      };
    }

    const logs = await AttendanceLog.findAll({
      where,
      order: [['clockInTime', 'DESC']],
    });

    return res.json({
      success: true,
      data: logs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'An error occurred.',
    });
  }
}

async function getOfficeIp(req, res) {
  try {
    let ip = await cache.getOfficeIP();

    if (!ip) {
      const setting = await Setting.findOne({ where: { key: 'office_public_ip' } });
      ip = setting ? setting.value : process.env.OFFICE_PUBLIC_IP;
    }

    return res.json({
      success: true,
      office_public_ip: ip,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'An error occurred.',
    });
  }
}

module.exports = {
  clockIn,
  clockOut,
  getTodayStatus,
  getAttendanceLogs,
  getOfficeIp,
  computeShiftDate,
  calculateDuration,
};
