@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 本地环境自检

for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TS=%%i"
set "LOG=%~dp0自检报告-%TS%.txt"

echo.
echo   ============================================
echo   报告将保存到:
echo   %LOG%
echo   ============================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0本地自检.ps1" -Log "%LOG%"

echo.
echo   ============================================
echo   报告已保存:
echo   %LOG%
echo   ============================================
echo.
echo 按任意键关闭窗口...
pause >nul
