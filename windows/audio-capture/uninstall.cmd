@echo off
rem Uninstall audio-capture: remove the Start Menu and Startup shortcuts
rem and %LOCALAPPDATA%\Programs\audio-capture. %USERPROFILE%\.audio-capture
rem (config.toml with the hotkeys, logs, sessions) stays. Double-click it,
rem or run `just audio-capture-uninstall` from WSL, which passes --no-pause.
setlocal
set "OUT=%LOCALAPPDATA%\Programs\audio-capture"
set "EXE=%OUT%\audio-capture.exe"
set "PROGRAMS=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
set "RC=0"

if not exist "%EXE%" goto noexe

rem Never in the middle of a recording: --quit-if-idle exits 3 while
rem recording or saving, and otherwise waits for the app to exit.
"%EXE%" --quit-if-idle
if errorlevel 3 (
  echo audio-capture is recording or saving. Stop it, then uninstall again.
  goto fail
)
"%EXE%" --uninstall
if errorlevel 1 goto fail
rmdir /s /q "%OUT%"
if exist "%OUT%" (
  echo could not remove %OUT%
  goto fail
)
echo removed %OUT%
goto kept

:noexe
rem No exe to ask: remove a shortcut only if its target is the installed
rem exe's path. A same-name shortcut that points elsewhere isn't ours.
echo audio-capture is not installed in %OUT%
powershell.exe -NoProfile -Command ^
  "$exe = [IO.Path]::GetFullPath($env:EXE);" ^
  "$sh = New-Object -ComObject WScript.Shell;" ^
  "foreach ($p in @(($env:PROGRAMS + '\audio-capture.lnk')," ^
  "    ($env:PROGRAMS + '\Startup\audio-capture.lnk'))) {" ^
  "  if (-not (Test-Path -LiteralPath $p)) { continue }" ^
  "  $t = $sh.CreateShortcut($p).TargetPath;" ^
  "  if ($t -and [IO.Path]::GetFullPath($t) -ieq $exe) {" ^
  "    Remove-Item -LiteralPath $p; 'removed ' + $p" ^
  "  } else { 'kept ' + $p + ': not ours (it points at ' + $t + ')' } }"
if errorlevel 1 goto fail

:kept
echo kept %USERPROFILE%\.audio-capture
goto done

:fail
set "RC=1"
echo uninstall failed

:done
if /i not "%~1"=="--no-pause" pause
exit /b %RC%
