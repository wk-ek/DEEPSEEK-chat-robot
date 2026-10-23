@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 环境安装 - Python + PyTorch

for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TS=%%i"
set "LOG=%~dp0安装日志-%TS%.txt"

echo.
echo   ============================================
echo     环境安装：Python + PyTorch
echo   ============================================
echo.
echo   会做两件事：
echo     1. 检查 Python，太旧就装 3.12
echo     2. 检查 PyTorch，装成 CUDA 版
echo.
echo   每一步都会先检测，能跳过就跳过。
echo   日志: %LOG%
echo.

net session >nul 2>&1
if errorlevel 1 (
    echo   ! 当前不是管理员权限
    echo     安装 Python 时可能失败。
    echo     建议：右键这个文件 - 以管理员身份运行
    echo.
)

echo 按任意键开始，或直接关窗口取消...
pause >nul

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装环境.ps1" -Log "%LOG%"

echo.
echo   ============================================
echo   完成
echo   日志: %LOG%
echo   ============================================
echo.
echo   重要：如果刚装了 Python，需要重开一个
echo         新的 PowerShell 窗口，PATH 才会生效。
echo.
echo 按任意键关闭窗口...
pause >nul
