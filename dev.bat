@echo off
:: DEVELOPMENT mode with hot-reload: runs the server (:5050) plus the Vite dev
:: server (:5173, with HMR). Vite proxies /ws through to the server, so the app
:: works the same as production. Use start.bat for the single-port hosted run.
cd /d "%~dp0"

echo Starting Mara 3 (dev / hot-reload)...
echo   server : ws://localhost:5050
echo   web    : http://localhost:5173  (open this one)
echo.

start "Mara 3 - Server" cmd /k pnpm --filter @mara/server dev
start "Mara 3 - Web (HMR)" cmd /k pnpm --filter @mara/web dev

timeout /t 5 /nobreak >nul
start "" http://localhost:5173

echo Two windows opened (Server + Web). Close them to stop Mara 3.
