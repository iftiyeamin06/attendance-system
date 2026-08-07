const http = require('http');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
dotenv.config();
const { User, AttendanceLog } = require('../models');

function getJSON(path, token) {
  return new Promise((resolve) => {
    const r = http.request({ host: 'localhost', port: 3000, path, method: 'GET', headers: { Authorization: 'Bearer ' + token } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ raw: b }); } });
    });
    r.on('error', (e) => resolve({ err: e.message })); r.end();
  });
}

(async () => {
  const emp = await User.findOne({ where: { role: 'employee' } });
  const token = jwt.sign({ id: emp.id, email: emp.email, role: emp.role }, process.env.JWT_SECRET);
  const res = await getJSON('/api/attendance/today', token);
  console.log('today status:', JSON.stringify(res, null, 2));
  const logs = await AttendanceLog.findAll({ where: { userId: emp.id }, order: [['clockInTime', 'DESC']], limit: 3 });
  console.log('\nlogs:', logs.map(l => `shift=${l.shiftDate} in=${l.clockInTime} out=${l.clockOutTime} status=${l.status}`));
})();