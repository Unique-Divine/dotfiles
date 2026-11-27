@powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0inventory.ps1" %*
@exit /b %ERRORLEVEL%
