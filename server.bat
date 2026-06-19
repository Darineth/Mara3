@echo off
:: Run just the Mara 3 WebSocket server (ws://localhost:5050). Ctrl+C to stop.
cd /d "%~dp0"
pnpm --filter @mara/server dev
