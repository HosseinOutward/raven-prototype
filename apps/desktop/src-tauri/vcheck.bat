@echo off
setlocal

rem Keep this helper portable across synced Windows workspaces. The PowerShell
rem environment scripts discover Visual Studio, LLVM, and a short target dir.
set "SCRIPT_DIR=%~dp0..\scripts"
set "TAURI_DIR=%~dp0."
set "LOG_FILE=%~dp0vcheck.log"

powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $ErrorActionPreference = 'Stop'; . (Join-Path $args[0] 'msvc-env.ps1'); . (Join-Path $args[0] 'native-build-env.ps1'); Set-Location -LiteralPath $args[1]; cargo check }" "%SCRIPT_DIR%" "%TAURI_DIR%" > "%LOG_FILE%" 2>&1
exit /b %ERRORLEVEL%
