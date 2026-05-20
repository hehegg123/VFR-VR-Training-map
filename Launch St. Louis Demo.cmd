@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0prototype\babylon-vr-faa-map\scripts\launch_stlouis_one_click_demo.ps1"
if errorlevel 1 (
  echo.
  echo Launcher failed. Press any key to close this window.
  pause >nul
)
