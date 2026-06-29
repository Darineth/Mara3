@echo off
rem Portable launcher for the Windows 7 client. Ship this .bat next to Mara3.exe
rem and a "webview2-runtime" folder. Windows 7 has no evergreen WebView2 runtime, so
rem point WebView2 at the bundled FIXED-version runtime sitting beside this script.
rem (Download Microsoft's "Fixed Version" WebView2 runtime, last Win7-capable ~Chromium
rem 109, and extract it into .\webview2-runtime so this folder contains msedgewebview2.exe.)
set "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER=%~dp0webview2-runtime"
start "" "%~dp0Mara3.exe"
