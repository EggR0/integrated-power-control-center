@echo off
if exist "d:\Workspace\Integrated POWER\packages\control-center\scripts\ensure-broker.cmd" (
    call "d:\Workspace\Integrated POWER\packages\control-center\scripts\ensure-broker.cmd"
    exit /b %ERRORLEVEL%
)
powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0ensure-broker.ps1"
