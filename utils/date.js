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
// Return the UTC epoch (ms) of a shift's end wall-clock time for a given
// shiftDate string. For overnight shifts (end <= start) the shift ends on the
// following calendar day, otherwise on the shiftDate itself.
function shiftEndEpoch(shiftDateStr, startTime, endTime, timeZone = ATTENDANCE_TIME_ZONE) {
  const [startHour, startMinute] = startTime.split(':').map(Number);
  const [endHour, endMinute] = endTime.split(':').map(Number);
  const endMs = endHour * 60 + endMinute;
  const startMs = startHour * 60 + startMinute;
  const overnight = endMs <= startMs;
  const endDate = overnight ? addDaysToYmd(shiftDateStr, 1) : shiftDateStr;
  return deadlineEpoch(endDate, endHour, endMinute, 0, timeZone);
}

function addDaysToYmd(ymd, days) {
  const [Y, M, D] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(Y, M - 1, D + days));
  return formatYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function deadlineEpoch(shiftDateStr, hour, minute, second = 0, timeZone = ATTENDANCE_TIME_ZONE) {
  const [Y, M, D] = shiftDateStr.split('-').map(Number);
  const probe = new Date(Date.UTC(Y, M - 1, D, 12, 0, 0));
  const parts = getZonedDateParts(probe, timeZone);
  const wallMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMs = wallMs - probe.getTime();
  return Date.UTC(Y, M - 1, D, hour, minute, second) - offsetMs;
}

// Return the [start, end] UTC Date range covering the entire calendar day in the
// attendance time zone that contains the given date. This is timezone-aware,
// unlike new Date(date).setHours(0,0,0,0) which uses the process-local timezone.
function zonedDayRange(date, timeZone = ATTENDANCE_TIME_ZONE) {
  const { year, month, day } = getZonedDateParts(date, timeZone);
  const dateStr = formatYmd(year, month, day);
  const start = new Date(deadlineEpoch(dateStr, 0, 0, 0, timeZone));
  const end = new Date(deadlineEpoch(dateStr, 23, 59, 59, timeZone) + 999);
  return { start, end };
}

function computeShiftDate(date, officeEndHour, officeStartHour) {
  const { year, month, day, hour } = getZonedDateParts(date);
  const shifted = new Date(Date.UTC(year, month - 1, day));
  // ponytail: default 12 keeps legacy tests green; pass officeEndHour for overnight-aware cutoff
  const endH = officeEndHour != null ? Number(officeEndHour) : 12;
  const startH = officeStartHour != null ? Number(officeStartHour) : 9;
  const overnight = endH * 60 <= startH * 60;
  if (overnight) {
    if (hour < endH) shifted.setUTCDate(shifted.getUTCDate() - 1);
  } else {
    if (hour < 12) shifted.setUTCDate(shifted.getUTCDate() - 1);
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
  shiftEndEpoch,
  zonedDayRange,
  addDaysToYmd,
};
