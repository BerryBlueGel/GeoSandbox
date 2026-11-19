@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\geosandbox-start.ps1" -OpenBrowser
if errorlevel 1 pause
