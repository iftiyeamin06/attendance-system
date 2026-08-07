const { User, AttendanceLog, Setting, Leave } = require('../models');
const cache = require('../redis/cache');
const { extractClientIp } = require('../middleware/ipValidation');
const { getOfficeTimes } = require('./leaveController');
const { Op } = require('sequelize');
const { localDateStr, computeShiftDate, deadlineEpoch } = require('../utils/date');

async function clockIn(req, res) {
  try {
    const user = req.user;
    const deviceUuid = req.headers['x-device-uuid'];

    const clientIp = extractClientIp(req);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayStr = localDateStr(today);

    const shiftDate = computeShiftDate(new Date());

    const leaveCheck = await AttendanceLog.findOne({
      where: {
        userId: user.id,
        status: 'ON_LEAVE',
        createdAt: {
          [Op.gte]: new Date(today.getTime() - 24 * 60 * 60 * 1000)
        }
      },
    });

    if (leaveCheck) {
      const logDate = localDateStr(leaveCheck.createdAt);
      if (logDate === todayStr) {
        return res.status(400).json({
          success: false,
          message: 'You are currently marked as On Leave today.',
        });
      }
    }

    const activeLog = await AttendanceLog.findOne({
      where: {
        userId: user.id,
        status: 'VERIFIED',
        clockOutTime: null,
      },
      order: [['clockInTime', 'DESC']],
    });

    if (activeLog) {
      return res.status(409).json({
        success: false,
        message: 'You already have an active clock-in. Please clock out before starting a new shift.',
        log_id: activeLog.id,
        clock_in_time: activeLog.clockInTime,
        shift_date: activeLog.shiftDate,
      });
    }

    const log = await AttendanceLog.create({
      userId: user.id,
      clockInTime: new Date(),
      shiftDate,
      ipAddress: clientIp,
      deviceIdUsed: deviceUuid,
      status: 'VERIFIED',
    });

    await cache.del(`daily_summary:${localDateStr(today)}`);

    return res.status(200).json({
      success: true,
      message: 'Clock-in recorded successfully.',
      data: {
        log_id: log.id,
        clock_in_time: log.clockInTime,
        ip_address: log.ipAddress,
        device_id: log.deviceIdUsed,
      },
    });
  } catch (err) {
    console.error('Clock-in error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred during clock-in.',
    });
  }
}

async function clockOut(req, res) {
  try {
    const user = req.user;
    const deviceUuid = req.headers['x-device-uuid'];
    const clientIp = extractClientIp(req);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let log = await AttendanceLog.findOne({
      where: {
        userId: user.id,
        status: 'VERIFIED',
        clockOutTime: null,
      },
      order: [['clockInTime', 'DESC']],
    });

    if (!log) {
      return res.status(400).json({
        success: false,
        message: 'No active clock-in found.',
      });
    }

    if (log.deviceIdUsed !== deviceUuid) {
      return res.status(403).json({
        success: false,
        message: 'Unregistered Device. You can only clock out from your registered smartphone.',
        error_code: 'UNREGISTERED_DEVICE',
      });
    }

    log.clockOutTime = new Date();
    await log.save();

    await cache.del(`daily_summary:${shiftDateFor(log)}`);

    const workedMs = new Date(log.clockOutTime) - new Date(log.clockInTime);
    const workedMinutes = Math.floor(workedMs / 60000);

    const totalMinutes = workedMinutes;
    const totalHours = Math.floor(totalMinutes / 60);
    const totalMins = totalMinutes % 60;

    return res.json({
      success: true,
      message: 'Clock-out recorded successfully.',
      data: {
        log_id: log.id,
        clock_in_time: log.clockInTime,
        clock_out_time: log.clockOutTime,
        shift_date: log.shiftDate,
        work_duration: calculateDuration(log.clockInTime, log.clockOutTime),
        total_worked: `${totalHours}h ${totalMins}m`,
      },
    });
  } catch (err) {
    console.error('Clock-out error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred during clock-out.',
    });
  }
}

function shiftDateFor(log) {
  if (log.shiftDate) return log.shiftDate;
  const d = new Date(log.clockInTime || new Date());
  return computeShiftDate(d);
}

function calculateDuration(clockIn, clockOut) {
  const diffMs = new Date(clockOut) - new Date(clockIn);
  const hours = Math.floor(diffMs / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

async function getTodayStatus(req, res) {
  try {
    const user = req.user;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayStr = localDateStr(today);

    const onLeaveLog = await AttendanceLog.findOne({
      where: {
        userId: user.id,
        status: 'ON_LEAVE',
      },
      order: [['createdAt', 'DESC']],
    });

    const isOnLeave = onLeaveLog && localDateStr(onLeaveLog.createdAt) === todayStr;

    const activeLog = isOnLeave ? onLeaveLog : await AttendanceLog.findOne({
      where: {
        userId: user.id,
        status: 'VERIFIED',
        clockOutTime: null,
      },
      order: [['clockInTime', 'DESC']],
    });

    const log = activeLog || await AttendanceLog.findOne({
      where: {
        userId: user.id,
        [Op.or]: [
          { shiftDate: todayStr },
          {
            clockInTime: {
              [Op.gte]: today,
              [Op.lte]: new Date(today.getTime() + 24 * 60 * 60 * 1000 - 1),
            },
          },
        ],
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
    const deadline = new Date(deadlineEpoch(localDateStr(new Date(clockIn)), startHour, startMin + graceMinutes));
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
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);
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
