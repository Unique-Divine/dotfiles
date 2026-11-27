@powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0wsl-cross-hub.ps1" %*
@exit /b %ERRORLEVEL%
