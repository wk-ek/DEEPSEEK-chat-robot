@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 本地环境自检

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0本地自检.ps1"

echo.
echo 按任意键关闭窗口...
pause >nul