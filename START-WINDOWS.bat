@echo off
cd /d "%~dp0"
echo StoreLedger Offline will be served at http://localhost:8000
echo Keep this window open during first setup and cache refresh.
echo Press Ctrl+C to stop the local server.
echo.
py -m http.server 8000
if errorlevel 1 (
  echo.
  echo The py command failed. If Python is installed, try running manually:
  echo python -m http.server 8000
  pause
)
