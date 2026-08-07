function adminMiddleware(req, res, next) {
  const user = req.user;

  if (!user || user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Forbidden. Admin access required.',
    });
  }

  next();
}

module.exports = adminMiddleware;
