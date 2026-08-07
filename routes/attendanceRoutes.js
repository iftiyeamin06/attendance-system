const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/auth');
const { ipValidationMiddleware } = require('../middleware/ipValidation');
const deviceValidation = require('../middleware/deviceValidation');
const attendanceController = require('../controllers/attendanceController');

router.use(authMiddleware);

router.post('/clock-in', ipValidationMiddleware, deviceValidation, attendanceController.clockIn);
router.post('/clock-out', ipValidationMiddleware, deviceValidation, attendanceController.clockOut);
router.get('/today', attendanceController.getTodayStatus);
router.get('/logs', attendanceController.getAttendanceLogs);
router.get('/office-ip', attendanceController.getOfficeIp);

module.exports = router;
