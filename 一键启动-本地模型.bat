@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 一键启动 - 本地模型（阿米娅）

echo.
echo   ============================================
echo     一键启动：本地模型模式
echo   ============================================
echo.
echo   模型：F:\ollama\models\amiya（Q4_K_M，2.33 GB）
echo   服务：http://127.0.0.1:11434（Ollama，本机）
echo   费用：0 元，不联网
echo.

REM ---- 用环境变量覆盖 .env 里的配置 ----
set "LLM_PROVIDER=local"
set "DEEPSEEK_BASE_URL=http://127.0.0.1:11434/v1"
set "DEEPSEEK_MODEL=amiya"
set "LLM_TIMEOUT=180000"
REM 本地不需要 key，给个占位值防止某些版本挑剔
set "DEEPSEEK_API_KEY=ollama"

REM ---- 检查 Ollama 是否存在 ----
if not exist "F:\ollama\ollama.exe" (
    echo   [错误] 找不到 F:\ollama\ollama.exe
    echo.
    echo   本地模型需要 Ollama。如果你只想用云端 API，
    echo   请双击 一键启动-DeepSeek.bat
    echo.
    goto :end_err
)

REM ---- 检查模型是否导入过 ----
if not exist "F:\ollama\models\manifests" (
    echo   [错误] 模型库里没有模型
    echo.
    echo   需要先导入：见 train\部署指南-windows.md
    echo.
    goto :end_err
)

echo   [OK] Ollama 和模型都在
echo.

REM ---- 交给通用启动器 ----
call "%~dp0一键启动.bat"
exit /b %ERRORLEVEL%

:end_err
echo   窗口不会自动关闭，看完了按任意键...
pause >nul
exit /b 1
