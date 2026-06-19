@echo off
:: Build every Mara 3 distributable into dist\ (self-contained server, web build,
:: and — if Rust is installed — the desktop installers).
:: Pass-throughs: package.bat --skip-tests --skip-desktop
cd /d "%~dp0"
node scripts\package.mjs %*
if errorlevel 1 (
  echo.
  echo PACKAGING FAILED. See output above.
  pause
  exit /b 1
)
echo.
pause
