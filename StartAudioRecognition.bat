@echo off
setlocal

cd /d "%~dp0"
set "PYTHON=local_transcriber\.venv\Scripts\python.exe"

if not exist "%PYTHON%" (
    echo Python virtual environment not found: %PYTHON%
    echo Please create the environment and install requirements first.
    pause
    exit /b 1
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

:is_port_unavailable
"%PYTHON%" -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',8765)); s.close()" >nul 2>&1
exit /b %errorlevel%
