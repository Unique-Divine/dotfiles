@echo off
rem Build audio-capture into %LOCALAPPDATA%\Programs\audio-capture.
rem Needs the .NET 10 SDK: winget install Microsoft.DotNet.SDK.10
setlocal
set "OUT=%LOCALAPPDATA%\Programs\audio-capture"
set "CFG=%APPDATA%\audio-capture\audio-capture.toml"

rem Stop a running copy so the exe can be replaced. --quit waits for it to
rem save any recording and exit.
if exist "%OUT%\audio-capture.exe" "%OUT%\audio-capture.exe" --quit >nul 2>&1

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
