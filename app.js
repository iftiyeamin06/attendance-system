require('dotenv').config();

process.env.TZ = process.env.ATTENDANCE_TIME_ZONE || 'Asia/Dhaka';

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { sequelize, User, Setting } = require('./models');
const cache = require('./redis/cache');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const shouldTrustProxy = process.env.TRUST_PROXY === 'true' || isProduction;

if (shouldTrustProxy) {
  app.set('trust proxy', 1);
}

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
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
  if (user && user.role === 'admin') return '/admin/dashboard';
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
  req.user = req.session.user;
  next();
}

function requireAdminWeb(req, res, next) {
  if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
    return res.redirect('/login');
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
  });
});

app.get('/employee/leave', requireWebAuth, async (req, res) => {
  res.render('employee/leave', {
    user: req.session.user,
    token: req.session.token,
    title: 'Leave Requests',
  });
});

app.get('/employee/settings', requireWebAuth, async (req, res) => {
  res.render('employee/settings', {
    user: req.session.user,
    token: req.session.token,
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
    };
    req.session.save();

    res.redirect(user.role === 'admin' ? '/admin/dashboard' : '/employee/dashboard');
  } catch (err) {
    res.render('auth/login', { error: 'An error occurred.' });
  }
});

app.post('/api/auth/admin-login-web', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email, role: 'admin' } });

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
    };
    req.session.save();

    res.redirect(user.role === 'admin' ? '/admin/dashboard' : '/employee/dashboard');
  } catch (err) {
    res.render('auth/login', { error: 'An error occurred.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found.',
  });
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
