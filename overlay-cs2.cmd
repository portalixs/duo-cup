@echo off
cd /d "%~dp0desktop"
if not exist "node_modules\.bin\electron.cmd" (
    call npm ci --no-audit --no-fund
    if errorlevel 1 (
        pause
        exit /b 1
    )
)
call npm start
if errorlevel 1 pause
