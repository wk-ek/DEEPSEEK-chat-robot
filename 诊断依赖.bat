@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 依赖崩溃诊断

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0诊断依赖.ps1"

echo.
echo 窗口不会自动关闭，看完了按任意键...
pause >nul
