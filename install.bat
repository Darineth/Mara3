@echo off
:: Install/refresh all dependencies for the monorepo.
cd /d "%~dp0"
pnpm install
echo.
pause
