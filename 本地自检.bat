@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 本地环境自检
setlocal enabledelayedexpansion

for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TS=%%i"
set "LOG=%~dp0自检报告-%TS%.txt"

echo.
echo   ============================================
echo   报告将保存到:
echo   %LOG%
echo   ============================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0本地自检.ps1" -Log "%LOG%"
set "RC=%ERRORLEVEL%"

echo.
echo   ============================================
if "%RC%"=="0" (
    echo   自检完成
) else (
    echo   自检结束（返回码 %RC%），上面有具体信息
)
echo   报告: %LOG%
echo   ============================================
echo.

:end
echo   窗口不会自动关闭，看完了按任意键...
pause >nul
exit /b 0
