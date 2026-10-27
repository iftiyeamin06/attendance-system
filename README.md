Employee Attendance Management System
A practical attendance tracking system built to solve a specific problem: preventing buddy-punching and off-site check-ins without requiring hardware tokens or GPS tracking.

Why This Exists
Most attendance systems either trust the client entirely (easy to spoof) or require dedicated hardware (expensive). This project takes a middle ground: device fingerprinting + IP allowlisting. An employee registers their browser/device once. After that, check-ins only succeed if the request comes from that same device and the office's public IP. No mobile app install, no location permissions — just a couple of HTTP headers and a stored hash.

Live Demo & Test Credentials
URL: https://attendance-system-rc2e.onrender.com

Role	Email	Password
Employee	test@gmail.com	pass123
Admin	superadmin@attendance.local	Superadmin#2026
Note: The free-tier Render instance spins down after 15 minutes of inactivity. A GitHub Action pings /api/health every 14 minutes to keep it warm, but the first load after a cold start may take 10–15 seconds.

Core Features
Device & IP Binding (The Anti-Spoof Layer)
First login: Employee logs in normally. The server generates a cryptographically random device_secret, hashes it with bcrypt, and stores the hash in the user record. The plaintext secret is returned once in the response body and stored in the browser's localStorage.
Subsequent requests: Every attendance API call (/api/attendance/clock-in, clock-out) must include the device_secret in a custom header (X-Device-Secret). The server re-hashes the provided secret and compares it to the stored hash.
IP validation: In parallel, the server extracts the client's public IP (via req.ip with trust proxy enabled for Render's load balancer) and compares it against the office_public_ip setting stored in the database (editable by admins).
Result: A request fails if either the device secret doesn't match or the IP isn't the office IP. Resetting a device binding requires admin action.
This isn't foolproof against a determined attacker with physical access to the employee's machine, but it raises the bar significantly above "share your password with a coworker."

Night-Shift-Aware Time Calculation
Shifts that cross midnight (e.g., 22:00–06:00) break naive date math. The backend handles this by:

Storing shift_start and shift_end as TIME columns (no date component).
When calculating worked hours, the logic checks: if shift_end <= shift_start, the shift spans two calendar days.
Clock-in/clock-out timestamps are stored as TIMESTAMPTZ (UTC). Reporting queries convert to the configured timezone (Asia/Dhaka by default) and apply the shift boundary logic to attribute hours to the correct "attendance date" — which for a night shift is the start date, not the end date.
Auto-close cron job: A hourly scheduler runs on startup and every hour thereafter, finds any open clock-ins past their shift end + grace period, closes them automatically, and logs an audit entry. This handles forgotten clock-outs without manual intervention.
Other Features
Role-based access: Admin dashboard (employee management, leave approvals, reports, settings) vs. Employee portal (clock in/out, leave requests, device status).
Leave management: Employees submit leave requests; admins approve/reject with optional notes.
Monthly reports: CSV export with daily totals, late/early flags, and overtime calculation.
Audit log: Every state-changing action (device reset, IP change, leave decision, auto-close) is recorded with actor, timestamp, and before/after values.
Tech Stack
Layer	Choice	Why
Runtime	Node.js 20+	LTS, native fetch, good DX
Framework	Express.js	Minimal, unopinionated, easy to debug
ORM	Sequelize	Mature Postgres support, migrations, associations
Database	PostgreSQL (Supabase)	Free tier, connection pooling, auth integration if needed later
Auth	JWT (stateless) + express-session (web views)	APIs stay stateless; server-rendered pages use cookies
Frontend	EJS + Tailwind CDN	No build step, fast iteration, good enough for internal tools
Scheduler	node-cron (in-process)	Simple, runs hourly via bin/cron.js
Cache	Redis (Upstash) with in-memory fallback	Office IP caching; falls back to Map if Redis unavailable (redis/cache.js)
Deployment	Render (web service) + GitHub Actions (keep-alive)	Free tier, auto-deploys from main, zero config
Deployment Notes
Render: Web service, npm run start:render (runs migrations then starts server). Health check at /api/health.
Supabase: Uses Transaction Pooler (port 6543) with ?pgbouncer=true because Render's IPv4-only egress can't reach Supabase's direct IPv6 endpoint.
Environment variables (set in Render dashboard): JWT_SECRET, DATABASE_URL (pooler URL), OFFICE_PUBLIC_IP, ATTENDANCE_TIME_ZONE, TRUST_PROXY=true, NODE_ENV=production.
Keep-alive: .github/workflows/keep-alive.yml runs curl against /api/health every 14 minutes via cron (*/14 * * * *). This prevents the free instance from spinning down.
Local Development
# 1. Clone & install
git clone https://github.com/iftiyeamin06/attendance-system.git
cd attendance-system
npm install

# 2. Create .env with required variables
# Required: JWT_SECRET, DATABASE_URL (local Postgres or Supabase pooler URL)
# Optional: OFFICE_PUBLIC_IP, ATTENDANCE_TIME_ZONE, REDIS_URL, etc.

# 3. Run migrations & seed default users
npm run migrate

# 4. Start dev server (nodemon)
npm run dev
Default local users (created by npm run migrate):

Admin: admin@attendance.local / admin123
Employee: employee@attendance.local / employee123
Project Structure (High Level)
attendance-system/
├── app.js                 # Express entry point, middleware, routes, server bootstrap
├── bin/
│   ├── migrate.js         # One-time migration + seed script
│   └── cron.js            # Auto-close scheduler (runs hourly)
├── config/
│   └── database.js        # Sequelize + pg pool config (SSL, pooler support)
├── controllers/           # Request handlers (auth, device, attendance, admin, leave)
├── middleware/            # Auth, admin check, IP validation, device validation, audit
├── models/                # Sequelize models (User, Setting, AttendanceLog, Leave, Holiday, AuditLog)
├── routes/                # API route definitions
├── views/                 # EJS templates (admin/, employee/, auth/)
├── public/                # Static assets (CSS, logos)
├── redis/
│   └── cache.js           # Redis client with in-memory fallback
├── services/
│   └── attendanceCleanup.js  # Auto-close logic used by cron
├── test/                  # Integration tests
├── .github/workflows/     # keep-alive.yml
└── render.yaml            # Render blueprint (optional)
Known Limitations
Single-instance scheduler: The auto-close cron runs inside the web process. On a multi-instance deploy, you'd need a distributed lock or external scheduler (e.g., pg_cron, BullMQ).
No rate limiting on device registration: An attacker who obtains valid credentials could register unlimited devices. Mitigation: short JWT expiry, admin audit log review.
IP allowlist is single-entry: Only one office IP supported. Multi-office would need a many-to-many office_ips table.
Device secret in localStorage: Vulnerable to XSS. CSP headers mitigate, but a compromised frontend could exfiltrate secrets.
License
MIT — use it, fork it, break it, fix it.

