@echo off
setlocal
title Cast to Sonos for Firefox — Official Setup
set "PROJECT_DIR=%~dp0"
if "%PROJECT_DIR:~-1%"=="\" set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"

echo ========================================================
echo   Cast to Sonos for Firefox — Official Local Setup
echo ========================================================
echo.

for /f "delims=" %%i in ('where node 2^>nul') do (
  set "NODE_PATH=%%i"
  goto :found_node
)
echo [ERROR] Node.js not found in PATH. Install Node.js 18+ first.
pause
exit /b 1

:found_node
echo [1/3] Registering Firefox Native Messaging host...
set "WRAPPER_BAT=%PROJECT_DIR%\bridge\native-host.bat"
set "MANIFEST_JSON=%PROJECT_DIR%\bridge\cast_to_sonos_firefox.json"

(
  echo @echo off
  echo "%NODE_PATH%" "%PROJECT_DIR%\bridge\native-host.js"
) > "%WRAPPER_BAT%"

node -e "const fs=require('fs'),p=process.argv[1],w=process.argv[2];fs.writeFileSync(p,JSON.stringify({name:'cast_to_sonos_firefox',description:'Auto-launch helper for Cast to Sonos for Firefox local audio bridge',path:w,type:'stdio',allowed_extensions:['cast-to-sonos@firefox.local']},null,2));" "%MANIFEST_JSON%" "%WRAPPER_BAT%"

reg add "HKCU\Software\Mozilla\NativeMessagingHosts\cast_to_sonos_firefox" /ve /t REG_SZ /d "%MANIFEST_JSON%" /f >nul

echo [2/3] Installing silent Windows Startup launcher...
set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CastToSonosBridge.vbs"
(
  echo Set shell = CreateObject("WScript.Shell"^)
  echo shell.CurrentDirectory = "%PROJECT_DIR%"
  echo shell.Run """%NODE_PATH%"" ""%PROJECT_DIR%\bridge\server.js""", 0, False
) > "%STARTUP_VBS%"

echo [3/3] Starting local Sonos bridge silently in background...
wscript.exe "%STARTUP_VBS%"

echo.
echo Done! The local Sonos bridge now runs silently in the background
echo and auto-starts with Windows (no terminal window needed).
echo.
echo To install the Firefox extension permanently:
echo   1. Go to https://addons.mozilla.org/developers/addon/submit/distribution
echo   2. Choose "On your own" (Unlisted / Self-Distribution)
echo   3. Upload dist\cast-to-sonos-firefox-1.0.0.zip
echo   4. Download the Mozilla-signed .xpi and drag it into Firefox!
echo.
pause
