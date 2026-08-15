@echo off
title Integrated Power Control Center Launcher
cd /d "%~dp0"

echo [Integrated Power] Starting Control Center...

:: 1. Launch the standalone desktop application
if exist "%~dp0src-tauri\target\release\integrated-power-control-center.exe" (
    start "" "%~dp0src-tauri\target\release\integrated-power-control-center.exe"
    echo [Integrated Power] Desktop application launched.
) else (
    echo [Integrated Power] Release binary not found, opening web interface...
    start "" "http://127.0.0.1:5173"
)

:: 2. Also open in default browser for instant access
start "" "http://127.0.0.1:5173"

exit /b 0
