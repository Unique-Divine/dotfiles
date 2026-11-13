@echo off
rem Build audio-capture into %LOCALAPPDATA%\Programs\audio-capture.
rem Needs the .NET 10 SDK: winget install Microsoft.DotNet.SDK.10
setlocal
set "OUT=%LOCALAPPDATA%\Programs\audio-capture"
set "CFG=%APPDATA%\audio-capture\audio-capture.toml"

rem Stop a running copy so the exe can be replaced, but never in the middle
rem of a recording: --quit-if-idle exits 3 while recording or saving.
if exist "%OUT%\audio-capture.exe" (
  "%OUT%\audio-capture.exe" --quit-if-idle
  if errorlevel 3 (
    echo audio-capture is recording or saving. Stop it, then build again.
    exit /b 1
  )
)

dotnet publish "%~dp0audio-capture.cs" -o "%OUT%"
if errorlevel 1 exit /b 1

if not exist "%CFG%" (
  if not exist "%APPDATA%\audio-capture" mkdir "%APPDATA%\audio-capture"
  copy "%~dp0audio-capture.example.toml" "%CFG%" >nul
  echo created %CFG%
)

"%OUT%\audio-capture.exe" --self-test
if errorlevel 1 exit /b 1
echo built %OUT%\audio-capture.exe
