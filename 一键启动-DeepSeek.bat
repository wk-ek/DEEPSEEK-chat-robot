@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 一键启动 - DeepSeek API

echo.
echo   ============================================
echo     一键启动：DeepSeek 云端 API 模式
echo   ============================================
echo.
echo   模型：deepseek-chat（官方）
echo   服务：https://api.deepseek.com
echo   费用：按用量计费，约 1 元 / 百万 token
echo.

REM ---- 用环境变量覆盖 .env 里的配置 ----
set "LLM_PROVIDER=deepseek"
set "DEEPSEEK_BASE_URL=https://api.deepseek.com"
set "DEEPSEEK_MODEL=deepseek-chat"
set "LLM_TIMEOUT=90000"
REM 清掉本地模式的占位 key，避免把 ollama 发给真接口
set "DEEPSEEK_API_KEY="

REM ---- 检查有没有 key ----
REM 先看环境变量（可能外面已经设了）
if not "%DEEPSEEK_KEY_ENV%"=="" set "DEEPSEEK_API_KEY=%DEEPSEEK_KEY_ENV%"

REM 再看 .env 文件
findstr /b /c:"DEEPSEEK_API_KEY=sk-" ".env" >nul 2>&1
if not errorlevel 1 (
    REM .env 里有真 key，让 config.js 自己读
    echo   [OK] .env 里找到了 API key
    goto :ready
)

REM .env 里没有，检查是否被注释掉
findstr /b /c:"# DEEPSEEK_API_KEY=" ".env" >nul 2>&1
if not errorlevel 1 (
    echo   [错误] .env 里的 DEEPSEEK_API_KEY 被注释掉了
    echo.
    echo   用本地模型：双击 一键启动-本地模型.bat
    echo   或用云端：把 .env 里这行的 # 去掉并填上真 key
    echo.
    echo      DEEPSEEK_API_KEY=sk-你的密钥
    echo.
    goto :end_err
)

echo   [错误] .env 里没有 DEEPSEEK_API_KEY
echo.
echo   去 platform.deepseek.com 拿一个 key，填进 .env：
echo      DEEPSEEK_API_KEY=sk-你的密钥
echo.
echo   或者用免费的本地模型：双击 一键启动-本地模型.bat
echo.
goto :end_err

:ready
echo.
call "%~dp0一键启动.bat"
exit /b %ERRORLEVEL%

:end_err
echo   窗口不会自动关闭，看完了按任意键...
pause >nul
exit /b 1
