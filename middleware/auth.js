const jwt = require('jsonwebtoken');
const { User } = require('../models');

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized. Bearer token required.',
    });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. User not found.',
      });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired. Please log in again.',
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Unauthorized. Invalid token.',
    });
  }
}

function superAdminMiddleware(req, res, next) {
  const user = req.user;

  if (!user || user.role !== 'superadmin') {
    return res.status(403).json({
      success: false,
      message: 'Forbidden. Super Admin access required.',
    });
  }

  next();
}

module.exports = authMiddleware;
module.exports.superAdminMiddleware = superAdminMiddleware;
