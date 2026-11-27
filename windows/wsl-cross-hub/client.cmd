@powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0client.ps1" %*
@exit /b %ERRORLEVEL%
