@echo off
:: Build and launch the desktop client (thin Tauri shell) for testing.
:: The desktop client loads a Mara server's hosted UI, so this starts a local
:: server first if one isn't already running on :5050.
:: Requires the Rust toolchain -- install from https://rustup.rs if missing.
cd /d "%~dp0"

where cargo >nul 2>nul
if errorlevel 1 (
  echo.
  echo Rust/cargo not found. The desktop client needs the Rust toolchain.
  echo Install it from https://rustup.rs then run this again.
  echo.
  pause
  exit /b 1
)

:: Start a local server unless one is already listening on :5050.
netstat -ano | findstr "LISTENING" | findstr ":5050 " >nul
if errorlevel 1 (
  echo No server on :5050 - building the web client and starting one...
  call pnpm --filter @mara/web build
  if errorlevel 1 (
    echo.
    echo Web build failed. Have you run install.bat?
    pause
    exit /b 1
  )
  start "Mara 3 - Server" cmd /k pnpm --filter @mara/server serve
  echo Waiting for the server to come up...
  timeout /t 4 /nobreak >nul
) else (
  echo Using the Mara server already running on :5050.
)

:: Point the client elsewhere by setting MARA_URL before running, e.g.
::   set MARA_URL=http://192.168.1.5:5050
echo Launching desktop client (the first run compiles Rust -- be patient)...
pnpm --filter @mara/shell tauri:dev
