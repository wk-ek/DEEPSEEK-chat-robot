@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 下载 Qwen3-4B 模型

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0下载模型.ps1"

echo.
echo 窗口不会自动关闭，看完了按任意键...
pause >nul
