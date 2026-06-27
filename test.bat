@echo off
:: Run the full Vitest test suite across all packages.
cd /d "%~dp0"
pnpm test
echo.
pause
