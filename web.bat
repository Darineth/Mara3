@echo off
:: Run just the Mara 3 web client (http://localhost:5173). Ctrl+C to stop.
:: Needs the server running too (server.bat) to actually connect.
cd /d "%~dp0"
pnpm --filter @mara/web dev
