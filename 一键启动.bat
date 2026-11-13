@echo off
rem ============================================================
rem  One-click start for the frontend handoff package
rem  Starts MySQL (if needed) + backend + static server, opens browser
rem  ASCII only. Chinese output comes from setup\start.js
rem ============================================================
title Weiguang - Start
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] Node.js not found. Install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

node setup\start.js
echo.
pause
