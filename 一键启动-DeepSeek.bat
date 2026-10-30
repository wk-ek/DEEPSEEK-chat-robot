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
REM 清掉可能残留的占位值，让 config.js 从 .env 里读真 key
set "DEEPSEEK_API_KEY="

REM ---- 检查 key ----
REM .env 里可能写 CLOUD_API_KEY，也可能写 DEEPSEEK_API_KEY，两个都认
findstr /b /c:"CLOUD_API_KEY=sk-" ".env" >nul 2>&1
if not errorlevel 1 goto :has_key

findstr /b /c:"DEEPSEEK_API_KEY=sk-" ".env" >nul 2>&1
if not errorlevel 1 goto :has_key

echo   [错误] .env 里没有 API key
echo.
echo   打开 F:\qq-deepseek-robot\.env，找到这一行并填上你的密钥：
echo.
echo       CLOUD_API_KEY=sk-你的密钥
echo.
echo   key 在 https://platform.deepseek.com/api_keys 申请。
echo.
echo   或者用混合模式（闲聊免费）：双击 一键启动-混合.bat
echo.
goto :end_err

:has_key
echo   [OK] .env 里找到了 API key
echo.
call "%~dp0一键启动.bat"
exit /b %ERRORLEVEL%

:end_err
echo   窗口不会自动关闭，看完了按任意键...
pause >nul
exit /b 1
