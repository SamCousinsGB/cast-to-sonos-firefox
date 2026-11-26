@echo off
title Cast to Sonos for Firefox — Local Bridge
cd /d "%~dp0"
echo Starting Cast to Sonos local audio bridge...
node bridge\server.js
pause
