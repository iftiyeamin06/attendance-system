const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');
const adminController = require('../controllers/adminController');
const leaveController = require('../controllers/leaveController');

router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/dashboard', adminController.adminDashboard);
router.get('/users', adminController.getAllUsers);
router.post('/users', adminController.addEmployee);
router.post('/admins', adminController.addAdmin);
router.post('/users/:userId/reset-device', adminController.resetDevice);
router.post('/users/:userId/bind-device', adminController.bindDevice);
router.get('/users/:userId/device-binding', adminController.getUserDeviceBinding);
router.delete('/users/:userId', adminController.deleteUser);
router.get('/employee/:userId/summary', adminController.getEmployeeMonthlySummary);
router.get('/report/summary', adminController.getAllEmployeesMonthlySummary);
router.get('/report/export', adminController.exportMonthlyReportCsv);
router.post('/settings/ip', adminController.updateOfficeIp);
router.post('/settings/office-time', adminController.updateOfficeTime);
router.get('/settings/office-time', adminController.getOfficeTime);
router.get('/export', adminController.exportCsv);
router.post('/leaves', leaveController.createLeave);
router.post('/leaves/:leaveId/status', leaveController.updateLeaveStatus);
router.delete('/leaves/:leaveId', leaveController.deleteLeave);
router.get('/leaves', leaveController.getLeaves);
router.get('/notifications/leaves', leaveController.getPendingLeaveNotifications);
router.post('/attendance/punch', adminController.addManualPunch);
router.put('/attendance/logs/:logId', adminController.editAttendanceLog);
router.delete('/attendance/logs/:logId', adminController.deleteAttendanceLog);

module.exports = router;
