@echo off
:: Build EVERY Mara 3 distributable into dist\ (self-contained server, web build,
:: desktop client if Rust is installed, and the Win7 legacy client), then zip each
:: into version-stamped archives under dist\zips\ with BUILD-INFO + SHA256SUMS.
:: Win7 legacy needs the WebView2 fixed runtime once (see scripts\package-legacy.mjs).
cd /d "%~dp0"
node scripts\package.mjs %*
if errorlevel 1 goto fail
node scripts\package-legacy.mjs
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
