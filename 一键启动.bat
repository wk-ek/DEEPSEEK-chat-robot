@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 一键启动 - 大肥鱼

echo.
echo   ============================================
echo    一键启动：NapCat + 机器人
echo   ============================================
echo.

echo  [1/2] 启动 NapCat...
if exist "NapCat\OneKey\NapCat.52230.Shell\NapCatWinBootMain.exe" (
    start "" /d "NapCat\OneKey\NapCat.52230.Shell" NapCatWinBootMain.exe
) else (
    echo        找不到 NapCat，检查 NapCat\OneKey\NapCat.52230.Shell
    pause
    exit /b 1
)

echo        等待 NapCat 就绪（最多 120 秒）...
set /a WAIT=0
:waitloop
timeout /t 3 /nobreak >nul
set /a WAIT+=1
netstat -ano | findstr ":3001" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto ready
if %WAIT% geq 40 goto timeout
echo        第 %WAIT% 次检查，还没起来...
goto waitloop

:ready
echo        NapCat 已就绪（端口 3001 已监听）。
echo.
echo  [2/2] 启动机器人...
echo.
timeout /t 2 /nobreak >nul
node src/index.js

echo.
echo  ============================================
echo    机器人已停止。按任意键关闭窗口。
echo  ============================================
pause >nul
exit /b 0

:timeout
echo.
echo        ❌ 等了 120 秒，NapCat 的 3001 端口还没起来。
echo.
echo        常见原因：
echo          1. NapCat 还停在扫码登录界面 —— 去看它的窗口
echo          2. QQ 版本和 NapCat 对不上
echo          3. NapCat 里没开 WebSocket 服务器（WebUI 6099 里检查）
echo.
pause
exit /b 1