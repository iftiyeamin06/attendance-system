# Attendance System

Single-Office Employee Attendance System with **Device Binding** + **IP Matching** - eliminating proxy check-ins and offsite clock-ins.

## Features

- **2-Layer Security Verification:**
  1. Office IP Matching - clocks only allowed from configured office IP
  2. Device Binding - each employee restricted to their registered physical device

- **Tech Stack:**
  - Node.js + Express API
  - Sequelize ORM with SQLite/PostgreSQL
  - Redis caching (with in-memory fallback)
  - JWT authentication
  - EJS templates for Admin & Employee UI
  - Tailwind CSS

## Quick Start

```bash
# Install dependencies
npm install

# Run migrations locally
npm run migrate

# Start the server
npm start

# Run tests
npm test
```

## Default Credentials

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@attendance.local | admin123 |
| Employee | employee@attendance.local | employee123 |

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login and receive JWT token

### Device Registration
- `POST /api/device/register` - Bind device to user account
- `GET /api/device/status` - Check device binding status

### Attendance
- `POST /api/attendance/clock-in` - Clock in (requires office IP + registered device)
- `POST /api/attendance/clock-out` - Clock out
- `GET /api/attendance/today` - Today's attendance status
- `GET /api/attendance/logs` - Attendance history

### Admin Panel
- `GET /api/admin/dashboard` - Attendance overview
- `GET /api/admin/users` - List all employees
- `POST /api/admin/users/:id/reset-device` - Reset device binding
- `POST /api/admin/settings/ip` - Update office IP
- `GET /api/admin/export` - Export CSV

## Configuration

Copy `.env.example` to `.env` and adjust settings:

```
PORT=3000
NODE_ENV=development
ATTENDANCE_TIME_ZONE=Asia/Dhaka
TZ=Asia/Dhaka
JWT_SECRET=your-secret-key
JWT_EXPIRES_IN=24h
TRUST_PROXY=false
OFFICE_PUBLIC_IP=your-office-public-ip
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql://postgres:your-password@db.your-project.supabase.co:5432/postgres
DATABASE_URL_POOLER=
SUPABASE_POOLER_URL=
USE_DATABASE_POOLER=false
DATABASE_SSL=true
DATABASE_POOL_MAX=5
DATABASE_POOL_MIN=0
DATABASE_POOL_ACQUIRE=30000
DATABASE_POOL_IDLE=10000
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_SECRET_KEY=your-secret-key
SUPABASE_JWKS_URL=https://your-project.supabase.co/auth/v1/.well-known/jwks.json
```

## Deploy To Supabase + Render

### 1. Create the Supabase database

1. Create a Supabase project.
2. Copy the Postgres connection string into `DATABASE_URL`.
3. If you use the Supabase pooler, set `DATABASE_URL_POOLER` too.
4. Set `USE_DATABASE_POOLER=true` if you want Render to use the pooler in production.
5. Keep `DATABASE_SSL=true` so the app uses SSL in production.

### 2. Prepare Render

1. Connect your GitHub repository to Render.
2. Use the included `render.yaml` blueprint or create a new Node web service.
3. Set these environment variables in Render:
  - `DATABASE_URL`
  - `DATABASE_URL_POOLER` if you use it
  - `SUPABASE_POOLER_URL` if you prefer that name
  - `USE_DATABASE_POOLER=true` if you want to force the pooler
  - `JWT_SECRET`
  - `OFFICE_PUBLIC_IP`
  - `SUPABASE_URL`
  - `SUPABASE_PUBLISHABLE_KEY`
  - `SUPABASE_SECRET_KEY`
  - `SUPABASE_JWKS_URL`
   - `ATTENDANCE_TIME_ZONE=Asia/Dhaka`
   - `TZ=Asia/Dhaka`
   - `TRUST_PROXY=true`
   - `NODE_ENV=production`
4. Set the start command to `npm run start:render`.
5. Add `/api/health` as the health check path.

### 3. Run migrations on first deploy

The Render start command runs `npm run migrate` before starting the server.
That creates the tables and default users in Supabase Postgres.

### 4. Timezone behavior

The app now formats all attendance dates and reports in `Asia/Dhaka` by default.
If you need a different timezone, change `ATTENDANCE_TIME_ZONE` and redeploy.

### 5. Secret safety

If any Supabase secret or database password was exposed outside your private environment, rotate it in Supabase and update Render immediately.

## Project Structure

```
attendance-system/
├── app.js              # Express server entry point
├── config/
│   └── database.js     # Sequelize config
├── models/
│   ├── index.js        # Sequelize initialization
│   ├── user.js         # User model
│   ├── setting.js      # Settings model
│   └── attendanceLog.js
├── controllers/
│   ├── authController.js
│   ├── deviceController.js
│   ├── attendanceController.js
│   └── adminController.js
├── middleware/
│   ├── auth.js         # JWT auth middleware
│   ├── admin.js        # Admin role check
│   ├── ipValidation.js # Office IP verification
│   └── deviceValidation.js
├── redis/
│   └── cache.js        # Redis cache with fallback
├── routes/
│   ├── authRoutes.js
│   ├── deviceRoutes.js
│   ├── attendanceRoutes.js
│   └── adminRoutes.js
├── views/
│   ├── auth/           # Login pages
│   ├── admin/          # Admin dashboard
│   └── employee/       # Employee UI
├── public/             # CSS, JS static assets
├── bin/migrate.js      # Database migration script
├── test/run-tests.js   # API test suite
└── docs/API.md         # Full API documentation
```
