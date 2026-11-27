@powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0build-desktop.ps1" %*
@exit /b %ERRORLEVEL%
