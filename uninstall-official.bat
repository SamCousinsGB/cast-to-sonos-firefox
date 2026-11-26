@echo off
setlocal
title Cast to Sonos for Firefox — Uninstall Local Bridge
echo Removing Windows Startup launcher...
del /f /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CastToSonosBridge.vbs" 2>nul

echo Removing Firefox Native Messaging registration...
reg delete "HKCU\Software\Mozilla\NativeMessagingHosts\cast_to_sonos_firefox" /f 2>nul

echo Stopping running bridge processes (if any)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*cast-to-sonos-firefox*bridge*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

echo.
echo Uninstalled Cast to Sonos local bridge startup and native host.
pause
