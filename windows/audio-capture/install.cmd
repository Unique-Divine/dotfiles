@echo off
rem Install audio-capture as a Windows app: build.cmd publishes the exe,
rem then the exe creates its Start Menu shortcut and, if [app]
rem start_with_windows is on (the default), its Startup shortcut. Rerunning
rem updates both. Double-click it, or run `just audio-capture-install` from
rem WSL, which passes --no-pause.
setlocal
set "OUT=%LOCALAPPDATA%\Programs\audio-capture"
set "RC=0"

call "%~dp0build.cmd"
if errorlevel 1 goto fail
"%OUT%\audio-capture.exe" --install
if errorlevel 1 goto fail
rem Launch through the new Start Menu shortcut. Explorer starts it, so the
rem app doesn't inherit this window's pipes, which would keep a WSL caller
rem waiting until the app exits.
explorer.exe "%APPDATA%\Microsoft\Windows\Start Menu\Programs\audio-capture.lnk"
echo installed audio-capture; it is running in the tray
goto done

:fail
set "RC=1"
echo install failed

:done
if /i not "%~1"=="--no-pause" pause
exit /b %RC%
