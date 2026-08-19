@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
set "PYTHON=local_transcriber\.venv\Scripts\python.exe"

if not exist "%PYTHON%" (
    echo [First run] Creating the Python virtual environment...
    set "BOOTSTRAP_PYTHON=python"
    where py >nul 2>&1
    if not errorlevel 1 set "BOOTSTRAP_PYTHON=py -3"
    !BOOTSTRAP_PYTHON! -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
    if errorlevel 1 goto python_not_found
    !BOOTSTRAP_PYTHON! -m venv local_transcriber\.venv
    if errorlevel 1 goto setup_failed
)

"%PYTHON%" -c "import fastapi, uvicorn, faster_whisper, imageio_ffmpeg" >nul 2>&1
if errorlevel 1 (
    echo [Setup] Installing Python dependencies. This may take several minutes...
    "%PYTHON%" -m pip install --disable-pip-version-check -r local_transcriber\requirements.txt
    if errorlevel 1 goto setup_failed
)

call :is_port_unavailable
if not errorlevel 1 goto start_service

echo Port 8765 is occupied, reserved, or unavailable. Waiting...
for /l %%I in (1,1,10) do (
    echo Retry %%I/10 in 3 seconds...
    timeout /t 3 /nobreak >nul
    call :is_port_unavailable
    if not errorlevel 1 goto start_service
)

for /l %%I in (1,1,6) do (
    echo Retry %%I/6 in 5 seconds...
    timeout /t 5 /nobreak >nul
    call :is_port_unavailable
    if not errorlevel 1 goto start_service
)

echo.
echo Port 8765 is still occupied, reserved, or unavailable after 16 retries.
echo Service was not started.
pause
exit /b 1

:start_service
echo Starting local transcription service at http://127.0.0.1:8765
"%PYTHON%" -m uvicorn local_transcriber.app:app --app-dir . --host 127.0.0.1 --port 8765

if errorlevel 1 (
    echo.
    echo Service failed to start.
    pause
)
endlocal
exit /b

:python_not_found
echo.
echo Python 3.10 or newer was not found.
echo Install Python from https://www.python.org/downloads/ and enable "Add Python to PATH".
pause
exit /b 1

:setup_failed
echo.
echo Initial setup failed. Check the error above, then run this file again.
pause
exit /b 1

:is_port_unavailable
"%PYTHON%" -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',8765)); s.close()" >nul 2>&1
exit /b %errorlevel%
