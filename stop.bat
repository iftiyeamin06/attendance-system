@echo off
echo Stopping Attendance System...
taskkill /f /im node.exe 2>nul
if %errorlevel% == 0 (
    echo Server stopped.
) else (
    echo No server was running.
)
pause