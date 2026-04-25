@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo Building NSIS installer WITH Azure Trusted Signing...
echo.
echo Prerequisites (all under this app):
echo   - build\sign_release_azure.ps1  (vendored in this repo)
echo   - build\artifact_signing_metadata.json (auto-created from .sample.json on first sign if missing)
echo   - Azure Artifact Signing tools, Windows SDK signtool (x64), az login with signer role
echo.
echo Stopping RootRecordWeatherManager.exe if running, then building, then signing all PE files under release\...
echo.
call npm run build:installer:signed
set ERR=%ERRORLEVEL%
if %ERR% neq 0 (
  echo Failed with exit code %ERR%.
  pause
  exit /b %ERR%
)
echo.
echo Signed output: release\Root Record Weather Manager-Setup-*.exe and release\win-unpacked\ (PE binaries)
echo Stale *.exe.blockmap files were removed from release\ after signing.
pause
exit /b 0
