@echo off
title OFD Workstation Server
cd /d "%~dp0"

rem ---- locate server.js (works from either folder) ----
if exist "server.js" goto :found
if exist "server\server.js" ( cd server & goto :found )
if exist "ofd-workstation-server_v2\server\server.js" ( cd ofd-workstation-server_v2\server & goto :found )
echo.
echo  [!] server.js not found near this file.
echo      Put this .bat anywhere inside the unzipped folder and run again.
echo.
pause
exit /b 1
:found

rem ---- check Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js is not installed.
  echo      Install the LTS version from  https://nodejs.org  then run this file again.
  echo.
  pause
  exit /b 1
)
node -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Your Node.js is too old. Install the latest LTS from  https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo  =====================================================
echo   OFD Workstation server starting...
echo   Browser will open:  http://localhost:8787
echo   Keep this window open. Closing it stops the server.
echo   Data file: ofd.db  (folder: %CD%)
echo  =====================================================
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8787"
node --no-warnings server.js
echo.
echo  Server stopped.
pause
