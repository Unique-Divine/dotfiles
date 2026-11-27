@powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0status.ps1" %*
@exit /b %ERRORLEVEL%
