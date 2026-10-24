@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 安装 LLaMA-Factory + 依赖

set "PY=C:\Program Files\Python312\python.exe"
if exist "%PY%" goto :haspy
for /f "delims=" %%i in ('where python 2^>nul') do (
    set "PY=%%i"
    goto :haspy
)
echo [错误] 找不到 python，先运行 安装环境.bat
goto :end

:haspy
echo.
echo   ============================================
echo     安装 LLaMA-Factory + 依赖
echo   ============================================
echo.
echo   Python: %PY%

set "VENDOR=%~dp0train\vendor\LLaMA-Factory"
set "WHEELS=%~dp0train\vendor\wheels"

if not exist "%VENDOR%\pyproject.toml" (
    echo   [错误] 找不到源码：%VENDOR%
    goto :end
)
if not exist "%WHEELS%" (
    echo   [错误] 找不到 wheels：%WHEELS%
    goto :end
)
echo   源码:   %VENDOR%
echo   wheels: %WHEELS%
echo.

echo   [1/4] 找 site-packages 目录...
"%PY%" -c "import site; print(site.getsitepackages()[0])" > "%TEMP%\amiya_sp.txt" 2>&1
set "SP="
set /p SP=<"%TEMP%\amiya_sp.txt"
del "%TEMP%\amiya_sp.txt" >nul 2>&1
if not defined SP (
    echo   [错误] 拿不到 site-packages 路径
    goto :end
)
echo        %SP%

echo.
echo   [2/4] 用 .pth 挂载源码到 site-packages...
echo         不走 pip install -e，避免 hatchling 等构建依赖
set "PTH=%SP%\amiya_llamafactory.pth"
set "SRCDIR=%VENDOR%\src"
>"%PTH%" echo %SRCDIR%
if not exist "%PTH%" (
    echo   [错误] 无法写入 %PTH%
    echo          需要管理员权限，请右键本文件「以管理员身份运行」
    goto :end
)
echo         %SRCDIR%
echo         ===^> %PTH%
echo        [OK] 已挂载

echo.
echo   [3/4] 装依赖（遍历 wheels 目录全部安装）...
echo         之前 --no-deps 加显式列表会漏掉 regex/tokenizers 等传递依赖，
echo         改成遍历目录装全部 wheel，一个都不会少。
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0train\install-deps.ps1" -Py "%PY%" -WheelsDir "%WHEELS%"
if errorlevel 1 (
    echo.
    echo   [X] 有包装不上，看上面的失败列表
    goto :end
)

echo.
echo   [4/4] 验证...
echo.
"%PY%" -c "import llamafactory; print('        llamafactory -> ' + llamafactory.__file__)"
if errorlevel 1 (
    echo.
    echo   [X] import llamafactory 失败
    goto :end
)
"%PY%" -c "from llamafactory.data import get_template_and_fix_tokenizer; print('        llamafactory.data OK')"
"%PY%" -c "from llamafactory.train.tuner import run_exp; print('        llamafactory.train.tuner OK')"
"%PY%" -c "import torch; print('        torch ' + torch.__version__ + '   cuda=' + str(torch.cuda.is_available()))"
"%PY%" -c "import numpy; print('        numpy ' + numpy.__version__)"
"%PY%" "%~dp0train\lf.py" --help >nul 2>&1
if errorlevel 1 (
    echo        [X] lf.py 启动失败
    "%PY%" "%~dp0train\lf.py" --help
    goto :end
)
echo        lf.py 可以启动

echo.
echo   ============================================
echo   全部完成
echo   ============================================
echo.

:end
echo   窗口不会自动关闭，看完了按任意键...
pause >nul
