# Attendance System API Documentation

## Overview
Single-Office Employee Attendance System with Device Binding + IP Matching.

**Base URL:** `http://localhost:3000`

---

## Authentication

### POST `/api/auth/login`
Authenticate a user and receive a JWT token.

**Request Body:**
```json
{
  "email": "employee@attendance.local",
  "password": "employee123"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Login successful.",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "uuid",
    "name": "Test Employee",
    "email": "employee@attendance.local",
    "role": "employee",
    "boundDeviceId": null
  }
}
```

### POST `/api/auth/register`
Register a new employee (admin only in production).

**Request Body:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "securepassword",
  "role": "employee"
}
```

---

## Device Registration

### POST `/api/device/register`
Bind a device UUID to the authenticated user.

**Headers:** `Authorization: Bearer <token>`

**Request Body:**
```json
{
  "device_uuid": "device-hardware-uuid-12345"
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "Device registered successfully.",
  "data": {
    "user_id": "uuid",
    "bound_device_id": "device-hardware-uuid-12345"
  }
}
```

### GET `/api/device/status`
Check if the user has a device bound.

**Headers:** `Authorization: Bearer <token>`

---

## Attendance

### POST `/api/attendance/clock-in`
Clock in for the current day. Requires office IP + registered device.

**Headers:**
- `Authorization: Bearer <token>`
- `X-Device-UUID: <device-uuid>`

**Response (200):**
```json
{
  "success": true,
  "message": "Clock-in recorded successfully.",
  "data": {
    "log_id": "uuid",
    "clock_in_time": "2026-08-05T09:00:00.000Z",
    "ip_address": "192.168.1.100",
    "device_id": "device-uuid"
  }
}
```

**Error (403 - IP Mismatch):**
```json
{
  "success": false,
  "message": "Clock-in failed. Please connect to the Official Office Wi-Fi.",
  "error_code": "OFFICE_IP_MISMATCH"
}
```

**Error (403 - Device Mismatch):**
```json
{
  "success": false,
  "message": "Unregistered Device. You can only clock in from your registered smartphone.",
  "error_code": "UNREGISTERED_DEVICE"
}
```

### POST `/api/attendance/clock-out`
Clock out for the current day. Requires office IP + registered device.

**Headers:**
- `Authorization: Bearer <token>`
- `X-Device-UUID: <device-uuid>`

### GET `/api/attendance/today`
Get today's attendance status.

**Headers:** `Authorization: Bearer <token>`

### GET `/api/attendance/logs`
Get attendance history for the authenticated user.

**Headers:** `Authorization: Bearer <token>`

### GET `/api/attendance/office-ip`
Get the configured office public IP.

---

## Admin Panel

All admin endpoints require `Authorization: Bearer <admin-token>` and admin role.

### GET `/api/admin/dashboard`
Get today's attendance summary and employee list.

### GET `/api/admin/users`
List all users (admin/employees).

### POST `/api/admin/users/{id}/reset-device`
Reset a user's device binding.

### POST `/api/admin/settings/ip`
Update the office public IP address.

**Request Body:**
```json
{
  "office_public_ip": "10.0.0.50"
}
```

### GET `/api/admin/export`
Export attendance logs as CSV.

**Query Parameters:**
- `startDate` (optional)
- `endDate` (optional)

---

## Security Rules

1. **Office IP Verification:** All clock-in/out requests must originate from the configured `OFFICE_PUBLIC_IP`.
2. **Device Binding:** Each employee must register exactly one device. All subsequent attempts from a different device are rejected.
3. **Admin Override:** Admins can reset device bindings through the admin panel.
4. **JWT Tokens:** All API requests (except login/register) require a valid JWT token.

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `JWT_SECRET` | JWT signing secret | - |
| `JWT_EXPIRES_IN` | Token expiration | 24h |
| `OFFICE_PUBLIC_IP` | Office public IP address | 192.168.1.100 |
| `REDIS_URL` | Redis connection URL | redis://localhost:6379 |
| `BCRYPT_ROUNDS` | Password hashing rounds | 12 |
| `DATABASE_URL` | Database connection string | sqlite://database.sqlite |

---

## Default Credentials

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@attendance.local | admin123 |
| Employee | employee@attendance.local | employee123 |
