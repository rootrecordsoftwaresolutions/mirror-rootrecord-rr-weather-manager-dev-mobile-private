@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo Building NSIS installer WITHOUT Azure signing...
echo Output: release\Root Record Weather Manager-Setup-*.exe and release\win-unpacked\
echo.
call npm run build:installer
set ERR=%ERRORLEVEL%
if %ERR% neq 0 (
  echo Failed with exit code %ERR%.
  pause
  exit /b %ERR%
)
echo.
echo Done.
pause
exit /b 0
