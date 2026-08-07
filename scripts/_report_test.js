const http = require('http');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
dotenv.config();
const { User, AttendanceLog, Leave } = require('../models');

function getJSON(path, token) {
  return new Promise((resolve) => {
    const r = http.request({ host: 'localhost', port: 3000, path, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { resolve({ status: res.statusCode, body: b }); } });
    });
    r.on('error', (e) => resolve({ status: -1, err: e.message })); r.end();
  });
}

(async () => {
  const admin = await User.findOne({ where: { role: 'admin' } });
  const token = jwt.sign({ id: admin.id, email: admin.email, role: admin.role }, process.env.JWT_SECRET);
  const now = new Date();
  const month = now.getMonth() + 1, year = now.getFullYear();
  const res = await getJSON(`/api/admin/report/summary?month=${month}&year=${year}`, token);
  console.log('status', res.status);
  if (res.status === 200) {
    console.log('kpi:', JSON.stringify(res.body.data.kpi));
    console.log('emp count:', res.body.data.employees.length);
    console.log('sample rows:', res.body.data.employees.map(e => `${e.name} DW=${e.total_days_worked} H=${e.total_hours_worked} OT=${e.on_time_days} L=${e.late_days} LV=${e.leave_days} A=${e.absent_days}`));
  } else {
    console.log(JSON.stringify(res.body));
  }
  const logsCount = await AttendanceLog.count();
  const leaves = await Leave.count();
  console.log('attendance logs:', logsCount, 'leaves:', leaves);
})();