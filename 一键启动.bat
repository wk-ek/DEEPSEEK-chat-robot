@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 一键启动 - 大肥鱼
setlocal enabledelayedexpansion

echo.
echo   ============================================
echo     一键启动：NapCat + 机器人
echo   ============================================
echo.

set "NAPCAT_DIR=NapCat\OneKey\NapCat.52230.Shell"
set "NAPCAT_EXE=%NAPCAT_DIR%\NapCatWinBootMain.exe"

if not exist "%NAPCAT_EXE%" (
    echo        [错误] 找不到 NapCat：
    echo        %NAPCAT_EXE%
    echo.
    echo        请检查 NapCat 目录是否完整。
    goto :end_err
)

echo  [1/3] 清理可能冲突的 QQ 进程...
echo.
echo        原因：NapCat 内置 QQ 是 9.9.33，如果系统 QQ（新版本）
echo        正在运行，NapCat 注入会失败，3001 端口起不来。
echo.

tasklist /fi "imagename eq QQ.exe" 2>nul | findstr /i "QQ.exe" >nul
if not errorlevel 1 (
    echo        发现 QQ 正在运行，正在关闭...
    taskkill /f /im QQ.exe >nul 2>&1
    timeout /t 3 /nobreak >nul
    echo        QQ 已关闭。
) else (
    echo        没有运行中的 QQ，继续。
)

echo.
echo  [2/3] 启动 NapCat...
echo        注意：会打开一个新窗口显示扫码登录，那个窗口不要关。
echo.
start "NapCat" /d "%NAPCAT_DIR%" cmd /k "chcp 65001 >nul && NapCatWinBootMain.exe"

echo        等待 NapCat 就绪（最多 120 秒）...
echo        提示：NapCat 会打开一个 QR 扫码窗口，第一次用要扫码登录。
echo.

set /a WAIT=0
:waitloop
timeout /t 3 /nobreak >nul
set /a WAIT+=1
netstat -ano | findstr ":3001" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto ready
if !WAIT! geq 40 goto timeout
echo        第 !WAIT! 次检查，还没起来...
goto waitloop

:ready
echo.
echo        [成功] NapCat 已就绪（端口 3001 已监听）
echo.
echo  [2.5/3] 检查模型服务...
echo.
set "NEED_OLLAMA=0"
findstr /b /c:"LLM_PROVIDER=local" .env >nul 2>&1
if not errorlevel 1 set "NEED_OLLAMA=1"
findstr /b /c:"LLM_PROVIDER=hybrid" .env >nul 2>&1
if not errorlevel 1 set "NEED_OLLAMA=1"

if "%NEED_OLLAMA%"=="0" (
    echo        没有配置本地模型，跳过
) else (
    netstat -ano ^| findstr ":11434" ^| findstr "LISTENING" >nul 2>&1
    if not errorlevel 1 (
        echo        [OK] Ollama 已在运行
    ) else (
        echo        启动 Ollama...
        set "OLLAMA_MODELS=F:\ollama\models"
        set "OLLAMA_HOST=127.0.0.1:11434"
        start "Ollama" /min "F:\ollama\ollama.exe" serve
        echo        等 10 秒让它就绪...
        timeout /t 10 /nobreak >nul
        netstat -ano ^| findstr ":11434" ^| findstr "LISTENING" >nul 2>&1
        if errorlevel 1 (
            echo        [警告] Ollama 没起来，本地模型会连不上
            echo               手动启动：双击 启动Ollama.bat
        ) else (
            echo        [OK] Ollama 已就绪
        )
    )
)
echo.
echo  [3/3] 启动机器人...
echo.
echo        机器人日志会直接显示在下面。
echo        要停止机器人：按 Ctrl+C
echo.
timeout /t 2 /nobreak >nul
node src/index.js
set "BOT_EXIT=%ERRORLEVEL%"

echo.
echo   ============================================
echo     机器人已停止（退出码 %BOT_EXIT%）
if not "%BOT_EXIT%"=="0" (
    echo     非正常退出，往上翻看错误信息
)
echo   ============================================
echo.
echo   NapCat 那个窗口还在运行，如需彻底关闭请手动关掉。
echo.
goto :end

:otimeout
echo.
echo        [警告] Ollama 60 秒没起来，机器人可能连不上模型
echo               手动启动：双击 启动Ollama.bat
echo.
goto :timeout

:timeout
echo.
echo        [失败] 等了 120 秒，3001 端口还没起来。
echo.
echo        排查顺序：
echo          1. 去看 NapCat 的窗口 - 是不是停在扫码登录界面？
echo             第一次用必须扫码登录一次。
echo.
echo          2. QQ 版本冲突 - NapCat 内置 9.9.33，系统装的是新版。
echo             本脚本已经尝试关掉系统 QQ，但如果没关干净，
echo             手动打开任务管理器，结束所有 QQ.exe 再重试。
echo.
echo          3. NapCat 的 WebSocket 服务被关了 -
echo             浏览器打开 http://127.0.0.1:6099 进 WebUI 检查。
echo.
echo          4. 检查配置里的端口：
echo             NapCat\OneKey\NapCat.52230.Shell\versions\
echo               9.9.33-52230\resources\app\napcat\config\
echo               onebot11_2034919973.json
echo.
echo        详细诊断：node scripts\napcat-doctor.mjs
echo.
goto :end_err

:end_err
echo.
echo   ============================================
echo     脚本异常结束，上面是原因
echo   ============================================
echo.

:end
echo   窗口不会自动关闭，看完了按任意键...
pause >nul
exit /b 0
