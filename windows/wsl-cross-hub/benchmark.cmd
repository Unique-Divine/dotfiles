@powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0benchmark.ps1" %*
@exit /b %ERRORLEVEL%
