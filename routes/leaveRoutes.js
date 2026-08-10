const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/auth');
const leaveController = require('../controllers/leaveController');

router.use(authMiddleware);

router.get('/', leaveController.getMyLeaveRequests);
router.post('/', leaveController.submitLeaveRequest);

module.exports = router;