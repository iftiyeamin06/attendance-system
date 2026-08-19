const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const adminMiddleware = require('../middleware/admin');

router.post('/login', authController.login);
router.post('/register', authMiddleware, adminMiddleware, authController.registerEmployee);
router.post('/change-password', authMiddleware, authController.changePassword);
router.post('/forgot-password', authController.requestPasswordReset);
router.post('/reset-password', authController.resetPassword);

module.exports = router;
