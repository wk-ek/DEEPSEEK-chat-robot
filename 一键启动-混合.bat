@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 一键启动 - 混合模式（本地 + 云端）

echo.
echo   ============================================
echo     一键启动：混合模式
echo   ============================================
echo.
echo   闲聊、情绪、日常  →  本地模型（免费）
echo   问到明日方舟设定  →  云端 DeepSeek（准确）
echo.
echo   云端只在检索到知识时才调用，日常聊天不花钱。
echo.

REM ---- 环境变量覆盖 ----
set "LLM_PROVIDER=hybrid"
set "LOCAL_BASE_URL=http://127.0.0.1:11434/v1"
set "LOCAL_MODEL=amiya"
set "LOCAL_TIMEOUT=180000"
set "HYBRID_ROUTE_ON_KB=true"
set "HYBRID_FALLBACK=true"
REM 云端配置（CLOUD_API_KEY 等）从 .env 读，这里不动

REM ---- 检查本地模型 ----
if not exist "F:\ollama\ollama.exe" (
    echo   [警告] 找不到 F:\ollama\ollama.exe
    echo.
    echo   混合模式需要本地模型跑闲聊。没有的话它会全部走云端（更贵）。
    echo   继续也能用，只是不省钱。
    echo.
    timeout /t 3 /nobreak >nul
)

REM ---- 检查云端 key ----
findstr /b /c:"CLOUD_API_KEY=sk-" ".env" >nul 2>&1
if not errorlevel 1 (
    echo   [OK] .env 里找到了云端 API key
    goto :ready
)

REM 兼容旧的 DEEPSEEK_API_KEY 写法
findstr /b /c:"DEEPSEEK_API_KEY=sk-" ".env" >nul 2>&1
if not errorlevel 1 (
    echo   [OK] .env 里找到了 DEEPSEEK_API_KEY
    goto :ready
)

echo   [提示] .env 里没有云端 API key（CLOUD_API_KEY）
echo.
echo   现在会以「纯本地」运行：
echo     - 闲聊没问题
echo     - 问明日方舟设定会瞎编
echo.
echo   要启用云端，把 key 填进 .env：
echo       CLOUD_API_KEY=sk-你的密钥
echo.
echo   继续启动？(3 秒后自动继续，Ctrl+C 退出)
timeout /t 3 /nobreak >nul

:ready
echo.
call "%~dp0一键启动.bat"
exit /b %ERRORLEVEL%
