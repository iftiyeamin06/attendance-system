const { AttendanceLog, AuditLog } = require('../models');
const { Op } = require('sequelize');
const { localDateStr, computeShiftDate, shiftEndEpoch } = require('../utils/date');
const { getOfficeTimes } = require('../controllers/leaveController');

const AUTO_CLOSE_NOTE = 'Auto-closed by system due to missing clock-out';

/**
 * Find and close all stale open attendance logs whose shiftDate is before
 * today. Each log is closed at its official shift end time. Returns the
 * number of logs that were closed.
 */
async function autoCloseStaleLogs() {
  const todayStr = localDateStr(new Date());
  const officeTimes = await getOfficeTimes();

  const staleLogs = await AttendanceLog.findAll({
    where: {
      clockOutTime: null,
      shiftDate: { [Op.lt]: todayStr },
      isManual: { [Op.ne]: true },
    },
    order: [['clockInTime', 'ASC']],
  });

  if (staleLogs.length === 0) return 0;

  let closed = 0;

  for (const log of staleLogs) {
    const shiftDate = log.shiftDate || computeShiftDate(new Date(log.clockInTime));
    const shiftEndMs = shiftEndEpoch(shiftDate, officeTimes.start, officeTimes.end);
    const shiftEnd = new Date(shiftEndMs);
    const now = new Date();

    // For overnight shifts (e.g. 20:00-05:00), the shift end may be on the
    // next calendar day. If the shift hasn't ended yet, skip this log — it's
    // an active overnight shift, not a stale leftover.
    if (shiftEnd > now) continue;

    // Close at the official shift end time.
    log.clockOutTime = shiftEnd;
    log.isAutoClosed = true;
    log.notes = AUTO_CLOSE_NOTE;
    await log.save();

    // Audit trail
    await AuditLog.create({
      adminId: null,
      action: 'AUTO_CLOSE_STALE_LOG',
      targetUserId: log.userId,
      details: JSON.stringify({
        log_id: log.id,
        shift_date: shiftDate,
        clock_in_time: log.clockInTime,
        clock_out_time: log.clockOutTime,
        reason: AUTO_CLOSE_NOTE,
      }),
    });

    closed++;
  }

  return closed;
}

module.exports = { autoCloseStaleLogs, AUTO_CLOSE_NOTE };
