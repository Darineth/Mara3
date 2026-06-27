@echo off
:: Run the full test suite (120 tests across the packages).
cd /d "%~dp0"
pnpm test
echo.
pause
