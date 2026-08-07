@echo off
echo Starting Attendance System...
cd /d F:\AMS\attendance-system
echo Running database migration...
node bin/migrate.js
echo.
echo Starting server at http://localhost:3000
echo Press Ctrl+C to stop
echo.
node app.js