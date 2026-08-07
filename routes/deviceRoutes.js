const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/auth');
const deviceController = require('../controllers/deviceController');

router.get('/my-ip', deviceController.myIp);

router.use(authMiddleware);

router.post('/register', deviceController.registerDevice);
router.get('/status', deviceController.checkDeviceStatus);

module.exports = router;
