@echo off
rem ============================================================
rem  One-click setup for the frontend handoff package
rem  ASCII only. Chinese output comes from setup\install.js
rem ============================================================
title Weiguang - Setup
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] Node.js not found.
  echo.
  echo   Please install Node.js 18 or newer first:
  echo       https://nodejs.org
  echo.
  echo   After installing, run this file again.
  echo.
  pause
  exit /b 1
)

node setup\install.js
echo.
pause
