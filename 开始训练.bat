@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 阿米娅人格模型训练
setlocal enabledelayedexpansion

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
echo   想先查环境？关掉这个窗口，双击「本地自检.bat」
echo   直接开训？等 5 秒后自动开始（Ctrl+C 可取消）
echo.

timeout /t 5 /nobreak
if errorlevel 1 goto :cancelled

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0train\run.ps1" -Log "%LOG%"
set "RC=%ERRORLEVEL%"

echo.
echo   ============================================
if "%RC%"=="0" (
    echo   训练流程结束
) else (
    echo   训练中断或失败（返回码 %RC%），上面有具体信息
)
echo   日志: %LOG%
echo   ============================================
echo.
echo   产物在: %~dp0output\
echo.
echo   别忘了关机！挂一晚上 20-30 元。
echo.
goto :end

:cancelled
echo.
echo   已取消（你在 5 秒内按了键）
echo.

:end
echo   窗口不会自动关闭，看完了按任意键...
pause >nul
exit /b 0
