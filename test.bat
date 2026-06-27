@echo off
:: Run the full test suite (126 tests across the packages).
cd /d "%~dp0"
pnpm test
echo.
pause
