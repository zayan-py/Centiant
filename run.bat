@echo off
pushd "%~dp0"
title Century Solver Pro - Stable Launcher
echo.
echo ===========================================
echo    CENTURY SOLVER PRO - HIGH SPEED
echo ===========================================
echo.

:: Check for Node.js
echo [1/3] Checking Environment...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Node.js is not installed! 
    echo Please download and install "LTS" version from: https://nodejs.org/
    echo.
    pause
    exit /b
)
echo [OK] Node.js found.

:: Install dependencies (Always check to ensure new updates are installed)
echo [2/3] Verifying requirements...
call npm init -y >nul 2>&1
call npm install playwright@latest --save >nul 2>&1
call npm install openai@latest --save >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Failed to verify dependencies. Check internet.
    pause
    exit /b
)
echo [OK] Dependencies verified.

:: Browser binaries check (Playwright handles this efficiently)
echo [3/3] Checking browser binaries...
call npx playwright install chromium
if %errorlevel% neq 0 (
    echo [ERROR] Failed to setup browser.
    pause
    exit /b
)
echo [OK] Browser ready.

echo.
echo [START] Launching Backend...
node century_solver.js
if %errorlevel% neq 0 (
    echo.
    echo [CRASH] The solver stopped unexpectedly.
    echo Error Code: %errorlevel%
    echo.
    pause
)
popd
pause
