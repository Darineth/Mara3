@echo off
rem Optional launcher for the Windows 7 client. Mara3.exe now finds the bundled
rem FIXED-version runtime beside it on its own (see use_bundled_webview2 in main.rs), so
rem double-clicking the exe works; this script stays for anyone whose shortcut points at it
rem and as the place to override the location. Windows 7 has no evergreen WebView2 runtime.
rem (Download Microsoft's "Fixed Version" WebView2 runtime, last Win7-capable ~Chromium
rem 109, and extract it into .\webview2-runtime so this folder contains msedgewebview2.exe.)
set "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER=%~dp0webview2-runtime"
start "" "%~dp0Mara3.exe"
