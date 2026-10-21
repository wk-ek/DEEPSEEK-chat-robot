@echo off
chcp 65001 >nul
cd /d "%~dp0"
title QQ DeepSeek Robot - %~dp0
echo.
echo  正在启动大肥鱼...
echo.
node src/index.js
echo.
echo  她停下了。按任意键关闭窗口。
pause >nul
