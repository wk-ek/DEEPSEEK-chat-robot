@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 手动训练 Stage 1

echo.
echo   ============================================
echo     手动训练：Stage 1 智慧层
echo   ============================================
echo.
echo   这个脚本直接调用 llamafactory-cli，
echo   能看到真实的报错信息（run.ps1 里可能被吞掉）。
echo.

set "LF=C:\Program Files\Python312\Scripts\llamafactory-cli.exe"

if not exist "%LF%" (
    echo   [错误] 找不到:
    echo   %LF%
    echo.
    echo   先跑 本地自检.bat 看看 llamafactory-cli 在哪。
    goto :end
)

echo   llamafactory-cli: %LF%
echo.
echo   命令:
echo     "%LF%" train train\stage1-wisdom.yaml ^
echo       dataset_dir=data ^
echo       output_dir=output\stage1-wisdom ^
echo       bf16=false fp16=true
echo.
echo   ============================================
echo.

if not exist "output" mkdir "output"

"%LF%" train "train\stage1-wisdom.yaml" dataset_dir="data" output_dir="output\stage1-wisdom" bf16=false fp16=true

set "RC=%ERRORLEVEL%"

echo.
echo   ============================================
if "%RC%"=="0" (
    echo   成功！退出码 0
    echo   产物在 output\stage1-wisdom\
) else (
    echo   失败，退出码 %RC%
    if "%RC%"=="-1073741819" (
        echo.
        echo   0xC0000005 = 内存访问冲突，进程崩溃
        echo   这通常是某个 C 扩展的问题。
        echo   跑 诊断依赖.bat 定位是哪个包。
    )
)
echo   ============================================
echo.

:end
echo   窗口不会自动关闭，看完了按任意键...
pause >nul
