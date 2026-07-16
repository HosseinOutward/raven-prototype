@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cd /d "C:\Users\Soroush Taheri\code\raven\apps\desktop\src-tauri"
set CARGO_TARGET_DIR=C:\Users\Soroush Taheri\rv
cargo check > "C:\Users\Soroush Taheri\code\raven\apps\desktop\src-tauri\vcheck.log" 2>&1
