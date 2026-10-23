@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 阿米娅人格模型训练

for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TS=%%i"
set "LOG=%~dp0训练日志-%TS%.txt"

echo.
echo   ============================================
echo     阿米娅人格模型训练
echo   ============================================
echo.
echo   日志会保存到:
echo   %LOG%
echo.
echo   先跑自检？按 Ctrl+C 退出，然后双击「本地自检.bat」
echo   直接开训？等 5 秒...
echo.

timeout /t 5 /nobreak >nul

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0train\run.ps1" -Log "%LOG%"

echo.
echo   ============================================
echo   训练结束
echo   日志: %LOG%
echo   ============================================
echo.
echo   产物在：%~dp0output\
echo.
echo   别忘了关机！挂一晚上 20-30 元。
echo.
echo 按任意键关闭窗口...
pause >nul
