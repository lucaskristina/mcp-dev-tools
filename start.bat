@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0"

where node.exe >nul 2>&1
if %errorlevel% neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set "PATH=C:\Program Files\nodejs;%PATH%"
    ) else if exist "%LOCALAPPDATA%\Programs\node\node.exe" (
        set "PATH=%LOCALAPPDATA%\Programs\node;%PATH%"
    ) else (
        echo [!] Error: Node.js v20 or higher runtime not found.
        echo Please ensure Node.js is installed or in PATH.
        exit /b 2
    )
)

node.exe src\runner.js %*
exit /b %errorlevel%
