const ATTENDANCE_TIME_ZONE = process.env.ATTENDANCE_TIME_ZONE || 'Asia/Dhaka';

function getZonedDateParts(date, timeZone = ATTENDANCE_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(date));

  const mapped = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      mapped[part.type] = part.value;
    }
  }

  return {
    year: Number(mapped.year),
    month: Number(mapped.month),
    day: Number(mapped.day),
    hour: Number(mapped.hour),
    minute: Number(mapped.minute),
    second: Number(mapped.second),
  };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatYmd(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function localDateStr(date) {
  const { year, month, day } = getZonedDateParts(date);
  return formatYmd(year, month, day);
}

function formatDateTime(date, timeZone = ATTENDANCE_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(date));
}

function formatTime(date, timeZone = ATTENDANCE_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(date));
}

function formatWeekday(date, timeZone = ATTENDANCE_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
  }).format(new Date(date));
}

function formatMonthLabel(date, timeZone = ATTENDANCE_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'long',
    year: 'numeric',
  }).format(new Date(date));
}

function currentDateInputValue(timeZone = ATTENDANCE_TIME_ZONE) {
  const { year, month, day } = getZonedDateParts(new Date(), timeZone);
  return formatYmd(year, month, day);
}

// Return the UTC epoch (ms) representing the given shiftDate string (YYYY-MM-DD
// in the attendance time zone) at the given local wall-clock hour:minute.
// This is a timezone-aware replacement for Date.UTC(...) which would otherwise
// misinterpret the shift date as UTC.
function deadlineEpoch(shiftDateStr, hour, minute, timeZone = ATTENDANCE_TIME_ZONE) {
  const [Y, M, D] = shiftDateStr.split('-').map(Number);
  const probe = new Date(Date.UTC(Y, M - 1, D, 12, 0, 0));
  const parts = getZonedDateParts(probe, timeZone);
  const wallMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMs = wallMs - probe.getTime();
  return Date.UTC(Y, M - 1, D, hour, minute, 0) - offsetMs;
}

function computeShiftDate(date) {
  const { year, month, day, hour } = getZonedDateParts(date);
  const shifted = new Date(Date.UTC(year, month - 1, day));

  // Shifts starting before noon are the previous day. For 9 PM-5 AM shifts,
  // any clock-in before noon belongs to today's (previous) shift.
  if (hour < 12) {
    shifted.setUTCDate(shifted.getUTCDate() - 1);
  }

  return formatYmd(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

module.exports = {
  ATTENDANCE_TIME_ZONE,
  getZonedDateParts,
  localDateStr,
  formatDateTime,
  formatTime,
  formatWeekday,
  formatMonthLabel,
  currentDateInputValue,
  computeShiftDate,
  deadlineEpoch,
};
