@echo off
:: Run Mara 3 the "real" way: the server hosts the web UI AND the WebSocket on a
:: single port (http://localhost:5050). Builds the web client first.
cd /d "%~dp0"

echo Building all packages + web client...
:: Build everything in dependency order so package changes (e.g. client-core)
:: propagate into the web bundle.
call pnpm build
if errorlevel 1 (
  echo.
  echo Build failed. Have you run install.bat?
  pause
  exit /b 1
)

echo.
echo Starting Mara 3 on http://localhost:5050  (close the "Mara 3" window to stop)
start "Mara 3" cmd /k pnpm --filter @mara/server serve

:: Give the server a moment to bind the port, then open the app.
timeout /t 4 /nobreak >nul
start "" http://localhost:5050
