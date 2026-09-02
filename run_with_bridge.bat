@echo off
setlocal EnableExtensions

REM This script lives in clawd-on-desk\. Resolve the pi-pet workspace root
REM without depending on the caller's current directory.
for %%I in ("%~dp0..") do set "PI_PET_ROOT=%%~fI"

set "CLAWD_PET_BRIDGE=1"
set "CLAWD_PET_BRIDGE_HIDE_NATIVE_PET=1"
set "CLAWD_PET_BRIDGE_STATUS_DIR=%USERPROFILE%\.pi-pet\status"
set "CLAWD_PET_BRIDGE_RENDERER_BIN=%PI_PET_ROOT%\claude-status-pet\pet-app\src-tauri\target\release\claude-status-pet.exe"

if not exist "%CLAWD_PET_BRIDGE_RENDERER_BIN%" (
  echo ERROR: claude-status-pet.exe was not found:
  echo %CLAWD_PET_BRIDGE_RENDERER_BIN%
  echo Build it first from claude-status-pet\pet-app with: npm run build
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing Clawd dependencies...
  call npm ci
  if errorlevel 1 (
    echo ERROR: npm ci failed.
    pause
    exit /b 1
  )
)

call npm start
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
