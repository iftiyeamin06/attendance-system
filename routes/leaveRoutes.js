const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const leaveController = require('../controllers/leaveController');

router.use(auth);

// Submit a leave request (employee)
router.post('/', leaveController.submitLeaveRequest);

// Get leaves for current user (or provide userId query if admin)
router.get('/', (req, res, next) => {
  if (!req.query.userId) req.query.userId = req.user.id;
  return leaveController.getLeaves(req, res, next);
});

module.exports = router;
