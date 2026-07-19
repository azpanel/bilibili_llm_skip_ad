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

echo Starting local transcription service at http://127.0.0.1:8765
"%PYTHON%" -m uvicorn local_transcriber.app:app --app-dir . --host 127.0.0.1 --port 8765

if errorlevel 1 (
    echo.
    echo Service failed to start.
    pause
)
endlocal
