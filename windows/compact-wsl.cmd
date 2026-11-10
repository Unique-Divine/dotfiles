@powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0compact-wsl.ps1" %*
@if not "%~1"=="" exit /b %ERRORLEVEL%
@pause
