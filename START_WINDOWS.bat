@echo off
setlocal
title LinkedIn Lead Finder
cd /d "%~dp0"

if not exist "server.py" (
  echo server.py was not found next to this file.
  echo Extract the WHOLE ZIP to a folder first, then double-click START_WINDOWS.bat inside that folder.
  goto done
)

py -3 --version >nul 2>&1
if not errorlevel 1 (
  py -3 server.py %*
  goto done
)

python --version >nul 2>&1
if not errorlevel 1 (
  python server.py %*
  goto done
)

echo.
echo Python 3 is not installed on this computer.
echo 1. Go to https://www.python.org/downloads/ and install Python 3.
echo 2. On the first install screen tick "Add python.exe to PATH".
echo 3. Double-click START_WINDOWS.bat again.

:done
echo.
pause
