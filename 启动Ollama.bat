@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Ollama 本地模型服务

echo.
echo   ============================================
echo     Ollama 本地模型服务
echo   ============================================
echo.

set "OLLAMA_DIR=F:\ollama"
set "OLLAMA_EXE=%OLLAMA_DIR%\ollama.exe"
set "OLLAMA_MODELS=%OLLAMA_DIR%\models"
set "OLLAMA_HOST=127.0.0.1:11434"

if not exist "%OLLAMA_EXE%" (
    echo   [错误] 找不到 %OLLAMA_EXE%
    goto :end_err
)

netstat -ano | findstr ":11434" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo   [已运行] 端口 11434 已在监听
    echo.
    goto :list
)

echo   正在启动 Ollama（模型目录 %OLLAMA_MODELS%）...
echo   这个窗口不要关闭，关掉服务就停了。
echo.

:list
echo   已安装的模型：
"%OLLAMA_EXE%" list
echo.
echo   测试一下：
"%OLLAMA_EXE%" run amiya "今天好累啊"
echo.
echo   ============================================
echo   Ollama 服务窗口
echo   机器人用这个服务（http://127.0.0.1:11434）
echo   用完可以关掉这个窗口
echo   ============================================
echo.

echo   按任意键启动（服务会在前台运行，Ctrl+C 停止）...
pause >nul

"%OLLAMA_EXE%" serve

:end_err
echo   窗口不会自动关闭，看完了按任意键...
pause >nul
