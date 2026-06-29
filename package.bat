@echo off
:: Build the Mara 3 clients into dist\ and zip them into dist\zips\ (with BUILD-INFO +
:: SHA256SUMS): self-contained server, web build, the portable Windows desktop client
:: (if Rust is installed), and the Linux client via WSL. This SKIPS the Win7 legacy
:: client — use package-all.bat for the full set including Win7.
:: - Linux builds in WSL (scripts\package-linux.mjs); --optional means it SKIPS with a
::   warning if WSL isn't available, so this still works on a machine without it.
:: Pass-throughs to package.mjs: package.bat --skip-tests --skip-desktop
cd /d "%~dp0"
node scripts\package.mjs %*
if errorlevel 1 goto fail
node scripts\package-linux.mjs --optional
if errorlevel 1 goto fail
node scripts\zip-dist.mjs
if errorlevel 1 goto fail
echo.
pause
exit /b 0
:fail
echo.
echo PACKAGING FAILED. See output above.
pause
exit /b 1
