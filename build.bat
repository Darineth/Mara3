@echo off
:: Build every package and app in the monorepo.
cd /d "%~dp0"
pnpm build
echo.
pause
