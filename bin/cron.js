/**
 * Background cleanup scheduler for stale attendance logs.
 * Runs autoCloseStaleLogs() every hour.  The function itself only acts on
 * logs whose shiftDate < today, so the hourly cadence is safe and
 * lightweight (most runs will find zero stale logs and return immediately).
 *
 * Usage: required by app.js at startup — no separate process needed.
 */

const { autoCloseStaleLogs } = require('../services/attendanceCleanup');

const INTERVAL_MS = 60 * 60 * 1000; // every hour

let timer = null;
let running = false;

async function sweep() {
  if (running) return;
  running = true;
  try {
    const closed = await autoCloseStaleLogs();
    if (closed > 0) {
      console.log(`[cron] Auto-closed ${closed} stale attendance log(s).`);
    }
  } catch (err) {
    console.error('[cron] Auto-close sweep error:', err);
  } finally {
    running = false;
  }
}

function startCron() {
  // Run once immediately on startup, then every hour.
  sweep();
  timer = setInterval(sweep, INTERVAL_MS);
  console.log('[cron] Attendance cleanup scheduler started (hourly).');
}

function stopCron() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startCron, stopCron };
