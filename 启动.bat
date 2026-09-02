@echo off
rem ============================================================
rem  Brick Cost Estimation System - Launcher
rem  ASCII-only on purpose: cmd parses batch files in the local
rem  OEM codepage, so any Chinese text here would be corrupted.
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"
set "PORT=8237"
set "URL=http://127.0.0.1:%PORT%/"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo Please install Node.js LTS from https://nodejs.org, then run this file again.
  pause
  exit /b 1
)

rem If the service is already running, just open the browser and exit.
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();exit 0}catch{exit 1}" >nul 2>nul
if not errorlevel 1 goto open

echo Starting the cost estimation server on port %PORT% ...
start "BrickCostServer" node server.js

rem Wait until the server answers HTTP (up to ~20 seconds).
set /a n=0
:wait
set /a n+=1
if %n% gtr 20 goto open
powershell -NoProfile -Command "try{(New-Object Net.WebClient).DownloadString('%URL%')|Out-Null;exit 0}catch{exit 1}" >nul 2>nul
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait
)

:open
start "" "%URL%"
echo ============================================
echo   Server URL : %URL%
echo   Data file  : data\data.json  (back it up to keep your data)
echo   Keep the "BrickCostServer" console window open.
echo   Closing that window stops the service.
echo ============================================
exit /b 0
