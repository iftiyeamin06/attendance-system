const { Leave, User, AttendanceLog, Setting } = require('../models');
const { Op } = require('sequelize');

function detectPartialLeaveType(fromTime, toTime, officeStartTime, officeEndTime) {
  const fromMinutes = timeToMinutes(fromTime);
  const toMinutes = timeToMinutes(toTime);
  const startMinutes = timeToMinutes(officeStartTime);
  const endMinutes = timeToMinutes(officeEndTime);

  const leaveDuration = toMinutes - fromMinutes;

  if (fromMinutes === startMinutes) {
    return {
      type: 'late_arrival',
      label: 'Late Arrival Leave',
      hint: `Adjusted expected clock-in to ${toTime}. No late penalty if clocked in before ${toTime}.`,
      duration: leaveDuration / 60,
    };
  }

  if (toMinutes === endMinutes) {
    return {
      type: 'early_departure',
      label: 'Early Departure Leave',
      hint: `${leaveDuration / 60}h removed from the day's work time.`,
      duration: leaveDuration / 60,
    };
  }

  return {
    type: 'mid_shift',
    label: 'Mid-Shift Leave',
    hint: `${leaveDuration / 60}h removed from the day's work time.`,
    duration: leaveDuration / 60,
  };
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

async function getOfficeTimes() {
  const startSetting = await Setting.findOne({ where: { key: 'office_start_time' } });
  const endSetting = await Setting.findOne({ where: { key: 'office_end_time' } });
  return {
    start: startSetting ? startSetting.value : '09:00',
    end: endSetting ? endSetting.value : '17:00',
  };
}

async function createLeave(req, res) {
  try {
    const { user_id, start_date, end_date, leave_type, notes, partial_hours, partial_from, partial_to } = req.body;

    if (!user_id || !start_date || !end_date || !leave_type) {
      return res.status(400).json({
        success: false,
        message: 'user_id, start_date, end_date, and leave_type are required.',
      });
    }

    if (leave_type === 'partial' && (!partial_from || !partial_to)) {
      return res.status(400).json({
        success: false,
        message: 'partial_from and partial_to are required for partial leaves.',
      });
    }

    const user = await User.findByPk(user_id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }

    let hours = partial_hours;
    if (leave_type === 'partial' && !hours) {
      const fromParts = partial_from.split(':').map(Number);
      const toParts = partial_to.split(':').map(Number);
      hours = (toParts[0] * 60 + toParts[1] - fromParts[0] * 60 - fromParts[1]) / 60;
    }

    const leave = await Leave.create({
      userId: user_id,
      startDate: start_date,
      endDate: end_date,
      leaveType: leave_type,
      partialHours: leave_type === 'partial' ? hours : null,
      partialFrom: leave_type === 'partial' ? partial_from : null,
      partialTo: leave_type === 'partial' ? partial_to : null,
      notes: notes || null,
      status: 'Approved',
      createdBy: req.user.id,
    });

    if (leave_type !== 'partial') {
      await syncLeaveToAttendance(leave);
    }

    return res.status(201).json({
      success: true,
      message: 'Leave marked successfully.',
      data: {
        id: leave.id,
        user_id: leave.userId,
        employee_name: user.name,
        start_date: leave.startDate,
        end_date: leave.endDate,
        leave_type: leave.leaveType,
        partial_hours: leave.partialHours,
        partial_from: leave.partialFrom,
        partial_to: leave.partialTo,
        notes: leave.notes,
        status: leave.status,
      },
    });
  } catch (err) {
    console.error('Create leave error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

async function deleteLeave(req, res) {
  try {
    const { leaveId } = req.params;

    const leave = await Leave.findByPk(leaveId);
    if (!leave) {
      return res.status(404).json({ success: false, message: 'Leave not found.' });
    }

    if (leave.leaveType !== 'partial') {
      const start = new Date(leave.startDate);
      const end = new Date(leave.endDate);
      end.setHours(23, 59, 59, 999);

      await AttendanceLog.destroy({
        where: {
          userId: leave.userId,
          status: 'ON_LEAVE',
          createdAt: { [Op.gte]: start, [Op.lte]: end },
        },
      });
    }

    await leave.destroy();

    return res.json({ success: true, message: 'Leave removed successfully.' });
  } catch (err) {
    console.error('Delete leave error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

async function getLeaves(req, res) {
  try {
    const { userId } = req.query;
    const where = {};
    if (userId) where.userId = userId;

    const leaves = await Leave.findAll({
      where,
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
      order: [['startDate', 'DESC']],
    });

    const officeTimes = await getOfficeTimes();

    return res.json({
      success: true,
      data: leaves.map((l) => {
        let partialInfo = null;
        if (l.leaveType === 'partial') {
          partialInfo = detectPartialLeaveType(l.partialFrom, l.partialTo, officeTimes.start, officeTimes.end);
        }
        return {
          id: l.id,
          user_id: l.userId,
          employee_name: l.user?.name || 'Unknown',
          employee_email: l.user?.email || 'Unknown',
          start_date: l.startDate,
          end_date: l.endDate,
          leave_type: l.leaveType,
          partial_hours: l.partialHours,
          partial_from: l.partialFrom,
          partial_to: l.partialTo,
          partial_label: partialInfo?.label || null,
          notes: l.notes,
          admin_remarks: l.adminRemarks,
          status: l.status || 'Pending',
        };
      }),
    });
  } catch (err) {
    console.error('Get leaves error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

async function submitLeaveRequest(req, res) {
  try {
    const { start_date, end_date, leave_type, notes, partial_hours, partial_from, partial_to } = req.body;

    if (!start_date || !end_date || !leave_type) {
      return res.status(400).json({
        success: false,
        message: 'start_date, end_date, and leave_type are required.',
      });
    }

    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    if (leave_type === 'partial' && (!partial_from || !partial_to)) {
      return res.status(400).json({
        success: false,
        message: 'partial_from and partial_to are required for partial leaves.',
      });
    }

    let hours = partial_hours;
    if (leave_type === 'partial' && !hours) {
      const fromParts = partial_from.split(':').map(Number);
      const toParts = partial_to.split(':').map(Number);
      hours = (toParts[0] * 60 + toParts[1] - fromParts[0] * 60 - fromParts[1]) / 60;
    }

    const leave = await Leave.create({
      userId: user.id,
      startDate: start_date,
      endDate: end_date,
      leaveType: leave_type,
      partialHours: leave_type === 'partial' ? hours : null,
      partialFrom: leave_type === 'partial' ? partial_from : null,
      partialTo: leave_type === 'partial' ? partial_to : null,
      notes: notes || null,
      status: 'Pending',
      createdBy: user.id,
    });

    return res.status(201).json({
      success: true,
      message: 'Leave request submitted. Waiting for admin approval.',
      data: {
        id: leave.id,
        user_id: leave.userId,
        start_date: leave.startDate,
        end_date: leave.endDate,
        leave_type: leave.leaveType,
        partial_hours: leave.partialHours,
        partial_from: leave.partialFrom,
        partial_to: leave.partialTo,
        notes: leave.notes,
        status: leave.status,
      },
    });
  } catch (err) {
    console.error('Submit leave request error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred while submitting the request.' });
  }
}

async function getMyLeaveRequests(req, res) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    const leaves = await Leave.findAll({
      where: { userId: user.id },
      order: [['createdAt', 'DESC']],
    });

    const officeTimes = await getOfficeTimes();

    return res.json({
      success: true,
      data: leaves.map((l) => {
        let partialInfo = null;
        if (l.leaveType === 'partial') {
          partialInfo = detectPartialLeaveType(l.partialFrom, l.partialTo, officeTimes.start, officeTimes.end);
        }
        return {
          id: l.id,
          start_date: l.startDate,
          end_date: l.endDate,
          leave_type: l.leaveType,
          partial_hours: l.partialHours,
          partial_from: l.partialFrom,
          partial_to: l.partialTo,
          partial_label: partialInfo?.label || null,
          notes: l.notes,
          admin_remarks: l.adminRemarks,
          status: l.status || 'Pending',
          created_at: l.createdAt,
        };
      }),
    });
  } catch (err) {
    console.error('Get my leave requests error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

async function getPendingLeaveNotifications(req, res) {
  try {
    const leaves = await Leave.findAll({
      where: { status: 'Pending' },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
      order: [['createdAt', 'ASC']],
      limit: 15,
    });

    return res.json({
      success: true,
      data: leaves.map((l) => ({
        id: l.id,
        employee_name: l.user?.name || 'Unknown',
        employee_email: l.user?.email || 'Unknown',
        start_date: l.startDate,
        end_date: l.endDate,
        leave_type: l.leaveType,
        partial_hours: l.partialHours,
        partial_from: l.partialFrom,
        partial_to: l.partialTo,
        notes: l.notes,
        status: l.status,
      })),
    });
  } catch (err) {
    console.error('Pending leave notifications error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

async function updateLeaveStatus(req, res) {
  try {
    const { leaveId } = req.params;
    const { status, remark } = req.body;

    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'status must be "Approved" or "Rejected".',
      });
    }

    const leave = await Leave.findByPk(leaveId);
    if (!leave) {
      return res.status(404).json({ success: false, message: 'Leave request not found.' });
    }

    const previousStatus = leave.status;
    leave.status = status;
    leave.adminRemarks = remark && String(remark).trim() ? String(remark).trim() : null;
    await leave.save();

    if (leave.leaveType !== 'partial') {
      if (status === 'Approved') {
        await syncLeaveToAttendance(leave);
      } else if (previousStatus === 'Approved' && status === 'Rejected') {
        const start = new Date(leave.startDate + 'T00:00:00');
        const end = new Date(leave.endDate + 'T23:59:59.999');
        await AttendanceLog.destroy({
          where: {
            userId: leave.userId,
            status: 'ON_LEAVE',
            clockInTime: { [Op.gte]: start, [Op.lte]: end },
          },
        });
      }
    }

    return res.json({
      success: true,
      message: `Leave request ${status}.`,
      data: {
        id: leave.id,
        status: leave.status,
      },
    });
  } catch (err) {
    console.error('Update leave status error:', err);
    return res.status(500).json({ success: false, message: 'An error occurred.' });
  }
}

async function syncLeaveToAttendance(leave) {
  const start = new Date(leave.startDate + 'T00:00:00');
  const end = new Date(leave.endDate + 'T00:00:00');

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${day}`;
    const dayStart = new Date(`${dateStr}T00:00:00`);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(`${dateStr}T23:59:59.999`);
    dayEnd.setHours(23, 59, 59, 999);

    const existing = await AttendanceLog.findOne({
      where: {
        userId: leave.userId,
        clockInTime: { [Op.gte]: dayStart, [Op.lte]: dayEnd },
      },
    });

    if (!existing) {
      await AttendanceLog.create({
        userId: leave.userId,
        clockInTime: null,
        ipAddress: 'N/A',
        deviceIdUsed: 'N/A',
        status: 'ON_LEAVE',
      });
    }
  }
}

module.exports = { createLeave, deleteLeave, getLeaves, submitLeaveRequest, getMyLeaveRequests, getPendingLeaveNotifications, updateLeaveStatus, syncLeaveToAttendance, detectPartialLeaveType, getOfficeTimes, timeToMinutes };
