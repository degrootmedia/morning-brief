@echo off
title Morning Brief
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this computer.
  echo   Install it once from https://nodejs.org  ^(the LTS version^),
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo Starting Morning Brief...
node serve.js

echo.
echo Morning Brief stopped.
pause
