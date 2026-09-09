@echo off
REM Compatibility entry point; the owned launcher now lives in pi-pet.
call "%~dp0..\scripts\run-with-bridge.bat" %*
exit /b %ERRORLEVEL%
