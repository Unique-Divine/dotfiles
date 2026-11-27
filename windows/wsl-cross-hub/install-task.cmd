@powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0install-task.ps1" %*
@exit /b %ERRORLEVEL%
