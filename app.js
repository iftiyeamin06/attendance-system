require('dotenv').config();

process.env.TZ = process.env.ATTENDANCE_TIME_ZONE || 'Asia/Dhaka';

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { sequelize, User, Setting } = require('./models');
const { getPgPool } = require('./config/database');
const cache = require('./redis/cache');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const shouldTrustProxy = process.env.TRUST_PROXY === 'true' || isProduction;

if (shouldTrustProxy) {
  app.set('trust proxy', 1);
}

// Security headers. CSP is configured to allow the CDNs the views rely on
// (Tailwind Play CDN, Google Fonts, Font Awesome) plus inline scripts/styles.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'unsafe-eval'",
          'https://cdn.tailwindcss.com',
          'https://cdnjs.cloudflare.com',
        ],
        scriptSrcAttr: ["'self'", "'unsafe-inline'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
          'https://cdnjs.cloudflare.com',
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  })
);

// Restrict CORS to the configured origins. Same-origin requests (the web app)
// need no CORS headers; set ALLOWED_ORIGINS for any cross-origin API clients.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : false,
    credentials: true,
  })
);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Persistent session store backed by PostgreSQL so sessions survive restarts,
// scale across instances, and expire cleanly (instead of the in-memory store).
const sessionStore = new PgSession({
  pool: getPgPool(),
  tableName: 'sessions',
  createTableIfMissing: true,
});

app.use(
  session({
    store: sessionStore,
    secret: process.env.JWT_SECRET || 'attendance_session_secret',
    resave: false,
    saveUninitialized: false,
    proxy: shouldTrustProxy,
    cookie: {
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

// Brute-force protection. Applied in production only so tests/local are unaffected.
if (isProduction) {
  app.use(
    '/api',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      legacyHeaders: false,
      message: { success: false, message: 'Too many requests, please try again later.' },
    })
  );
  app.use(
    '/api/auth',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 20,
      legacyHeaders: false,
      message: { success: false, message: 'Too many login attempts, please try again later.' },
    })
  );
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const authRoutes = require('./routes/authRoutes');
const deviceRoutes = require('./routes/deviceRoutes');
const attendanceRoutes = require('./routes/attendanceRoutes');
const adminRoutes = require('./routes/adminRoutes');
const leaveRoutes = require('./routes/leaveRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/device', deviceRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/leaves', leaveRoutes);

function homePathFor(user) {
  if (user && user.mustChangePassword) return '/change-password';
  if (user && (user.role === 'admin' || user.role === 'superadmin')) return '/admin/dashboard';
  if (user && user.role === 'employee') return '/employee/dashboard';
  return '/login';
}

app.get('/', (req, res) => {
  res.redirect(homePathFor(req.session.user));
});

app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect(homePathFor(req.session.user));
  }
  res.render('auth/login', { error: null });
});

app.get('/admin/login', (req, res) => {
  res.redirect('/login');
});

app.get('/employee/login', (req, res) => {
  res.redirect('/login');
});

function requireWebAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  if (req.session.user.mustChangePassword && req.path !== '/change-password') {
    return res.redirect('/change-password');
  }
  req.user = req.session.user;
  next();
}

function requireAdminWeb(req, res, next) {
  if (
    !req.session ||
    !req.session.user ||
    (req.session.user.role !== 'admin' && req.session.user.role !== 'superadmin')
  ) {
    return res.redirect('/login');
  }
  if (req.session.user.mustChangePassword && req.path !== '/change-password') {
    return res.redirect('/change-password');
  }
  req.user = req.session.user;
  next();
}

app.get('/admin/dashboard', requireAdminWeb, async (req, res) => {
  res.render('admin/dashboard', {
    user: req.session.user,
    token: req.session.token,
    title: 'Dashboard',
  });
});

app.get('/admin/employees', requireAdminWeb, async (req, res) => {
  res.render('admin/employees', {
    user: req.session.user,
    token: req.session.token,
    title: 'Employees',
  });
});

app.get('/admin/leaves', requireAdminWeb, async (req, res) => {
  res.render('admin/leaves', {
    user: req.session.user,
    token: req.session.token,
    title: 'Leaves',
  });
});

app.get('/admin/report', requireAdminWeb, async (req, res) => {
  res.render('admin/report', {
    user: req.session.user,
    token: req.session.token,
    title: 'Monthly Report',
  });
});

app.get('/admin/settings', requireAdminWeb, async (req, res) => {
  res.render('admin/settings', {
    user: req.session.user,
    token: req.session.token,
    title: 'Settings',
  });
});

app.get('/employee/dashboard', requireWebAuth, async (req, res) => {
  res.render('employee/dashboard', {
    user: req.session.user,
    token: req.session.token,
    deviceId: req.user?.boundDeviceId || req.session?.deviceId || '',
    page: 'dashboard',
  });
});

app.get('/employee/leave', requireWebAuth, async (req, res) => {
  res.render('employee/leave', {
    user: req.session.user,
    token: req.session.token,
    title: 'Leave Requests',
    page: 'leave',
  });
});

app.get('/employee/settings', requireWebAuth, async (req, res) => {
  res.render('employee/settings', {
    user: req.session.user,
    token: req.session.token,
    page: 'settings',
  });
});

app.get('/change-password', requireWebAuth, (req, res) => {
  res.render('auth/change-password', {
    user: req.session.user,
    token: req.session.token,
    title: 'Change Password',
    page: 'change-password',
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.post('/api/auth/login-web', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email } });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.render('auth/login', { error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    req.session.token = token;
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      boundDeviceId: user.boundDeviceId,
      mustChangePassword: !!user.mustChangePassword,
    };
    req.session.save();

    res.redirect(
      user.mustChangePassword
        ? '/change-password'
        : user.role === 'admin' || user.role === 'superadmin'
          ? '/admin/dashboard'
          : '/employee/dashboard'
    );
  } catch (err) {
    res.render('auth/login', { error: 'An error occurred.' });
  }
});

app.post('/api/auth/admin-login-web', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({
      where: {
        email,
        role: ['admin', 'superadmin'],
      },
    });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.render('auth/login', { error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    req.session.token = token;
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      boundDeviceId: user.boundDeviceId,
      mustChangePassword: !!user.mustChangePassword,
    };
    req.session.save();

    res.redirect(
      user.mustChangePassword
        ? '/change-password'
        : user.role === 'admin' || user.role === 'superadmin'
          ? '/admin/dashboard'
          : '/employee/dashboard'
    );
  } catch (err) {
    res.render('auth/login', { error: 'An error occurred.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      success: false,
      message: 'Route not found.',
    });
  }

  return res.status(404).send('Page not found.');
});

async function startServer() {
  try {
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET is required.');
    }

    await sequelize.authenticate();
    console.log('Database connected.');

    await sequelize.sync({ force: false });
    console.log('Database synced.');

    // sequelize.sync() does not add new columns to existing tables. Apply the
    // device-secret column idempotently so existing deployments (including the
    // production database) pick it up on their next start.
    try {
      await sequelize.query(
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS device_secret_hash VARCHAR(255)'
      );
      await sequelize.query(
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE'
      );
      await sequelize.query(
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ'
      );
      await sequelize.query(
        `ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'superadmin'`
      );

      // Ensure a default Super Admin exists for system setup (idempotent).
      const superAdmin = await User.findOne({
        where: { email: 'superadmin@attendance.local' },
      });
      if (!superAdmin) {
        await User.create({
          name: 'System Super Admin',
          email: 'superadmin@attendance.local',
          password: await bcrypt.hash(
            process.env.SUPERADMIN_PASSWORD || 'Superadmin#2026',
            parseInt(process.env.BCRYPT_ROUNDS) || 12
          ),
          role: 'superadmin',
        });
        console.log(
          'Super Admin created: superadmin@attendance.local / ' +
            (process.env.SUPERADMIN_PASSWORD || 'Superadmin#2026')
        );
      }

      console.log('Database migrations applied.');
    } catch (migErr) {
      console.warn('Migration warning (non-fatal):', migErr.message);
    }

    // The Postgres session store auto-creates its "sessions" table on first use
    // (createTableIfMissing: true).

    console.log('[cache] Initializing Redis...');
    await cache.init();

    app.listen(PORT, () => {
      console.log(`Attendance System running on http://localhost:${PORT}`);
      console.log(`Office Public IP: ${process.env.OFFICE_PUBLIC_IP || 'not set'}`);
      console.log(`Timezone: ${process.env.ATTENDANCE_TIME_ZONE || 'Asia/Dhaka'}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
