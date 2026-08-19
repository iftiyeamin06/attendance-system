const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { User, PasswordReset } = require('../models');
const { sendResetEmail } = require('../utils/mailer');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.',
      });
    }

    const user = await User.findOne({ where: { email } });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials.',
      });
    }

    const passwordValid = await bcrypt.compare(password, user.password);

    if (!passwordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials.',
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    return res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        boundDeviceId: user.boundDeviceId,
        must_change_password: !!user.mustChangePassword,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred during login.',
    });
  }
}

async function registerEmployee(req, res) {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required.',
      });
    }

    const existingUser = await User.findOne({ where: { email } });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'User with this email already exists.',
      });
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      // Role is always 'employee' here; admins are created via /api/admin/admins.
      role: 'employee',
    });

    return res.status(201).json({
      success: true,
      message: 'Employee registered successfully.',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred during registration.',
    });
  }
}

async function changePassword(req, res) {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required.',
      });
    }

    if (new_password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long.',
      });
    }

    const user = await User.findByPk(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    const passwordValid = await bcrypt.compare(current_password, user.password);

    if (!passwordValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect.',
      });
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    user.password = await bcrypt.hash(new_password, saltRounds);
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date();
    await user.save();

    if (req.session && req.session.user) {
      req.session.user.mustChangePassword = false;
    }

    return res.json({
      success: true,
      message: 'Password changed successfully.',
    });
  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while changing the password.',
    });
  }
}

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

async function requestPasswordReset(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required.',
      });
    }

    const user = await User.findOne({ where: { email } });

    if (!user) {
      return res.json({
        success: true,
        message:
          'If that email exists, a password reset link has been sent to your inbox.',
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await PasswordReset.update(
      { usedAt: new Date() },
      { where: { userId: user.id, usedAt: null } }
    );

    await PasswordReset.create({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
    });

    const resetUrl = `${req.protocol}://${req.get('host')}/reset-password?token=${token}`;

    // Deliver the reset link out-of-band.
    // Trigger email sending in the background so network/SMTP latency never blocks the HTTP response.
    sendResetEmail(user.email, resetUrl).catch((err) => {
      console.error('[mailer] Background reset email error:', err);
    });

    const isProduction =
      process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';

    // Production guardrail: reset_token / reset_url must never reach the
    // client payload on production / Render. Always return the generic message.
    if (isProduction) {
      return res.json({
        success: true,
        message:
          'If that email exists, a password reset link has been sent to your inbox.',
      });
    }

    // Direct loopback detection for local test suite only
    const isLoopback = isLoopbackIp(req.socket.remoteAddress || req.ip);

    return res.json(
      isLoopback
        ? {
            success: true,
            message:
              'If that email exists, a password reset link has been sent to your inbox.',
            reset_token: token,
            reset_url: `/reset-password?token=${token}`,
            expires_in_minutes: 15,
          }
        : {
            success: true,
            message:
              'If that email exists, a password reset link has been sent to your inbox.',
          }
    );
  } catch (err) {
    console.error('Request password reset error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while requesting a password reset.',
    });
  }
}

async function resetPassword(req, res) {
  try {
    const { token, new_password } = req.body;

    if (!token || !new_password) {
      return res.status(400).json({
        success: false,
        message: 'Token and new password are required.',
      });
    }

    if (new_password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long.',
      });
    }

    const record = await PasswordReset.findOne({
      where: { tokenHash: hashToken(token) },
    });

    if (!record || record.usedAt) {
      return res.status(400).json({
        success: false,
        message: 'Reset link is invalid or has already been used.',
      });
    }

    if (new Date(record.expiresAt).getTime() < Date.now()) {
      return res.status(400).json({
        success: false,
        message: 'Reset link has expired. Please request a new one.',
      });
    }

    const user = await User.findByPk(record.userId);

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Reset link is invalid.',
      });
    }

    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    user.password = await bcrypt.hash(new_password, saltRounds);
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date();
    await user.save();

    record.usedAt = new Date();
    await record.save();

    return res.json({
      success: true,
      message: 'Password reset successful. You can now sign in.',
    });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while resetting the password.',
    });
  }
}

module.exports = {
  login,
  registerEmployee,
  changePassword,
  requestPasswordReset,
  resetPassword,
};
