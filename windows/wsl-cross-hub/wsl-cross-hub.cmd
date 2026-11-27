@echo off
for %%C in (status history preview doctor compact job logs probe setup --help -h --json) do if /i "%~1"=="%%C" goto cli
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0wsl-cross-hub.ps1" %*
exit /b %ERRORLEVEL%
:cli
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0cli.ps1" %*
exit /b %ERRORLEVEL%
