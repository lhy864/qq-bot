@echo off
chcp 65001 >nul
cd /d "%~dp0"
node src\bridge.js
if errorlevel 1 pause
