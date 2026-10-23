@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 修复 LLaMA-Factory 安装

set "PY=C:\Program Files\Python312\python.exe"
if not exist "%PY%" (
    echo [错误] 找不到 %PY%
    goto :end
)
set "VENDOR=%~dp0train\vendor\LLaMA-Factory"

echo.
echo   ============================================
echo     修复 LLaMA-Factory 安装
echo   ============================================
echo.
echo   Python: %PY%
echo   源码:   %VENDOR%
echo.

if not exist "%VENDOR%\pyproject.toml" (
    echo   [错误] 找不到源码，检查包里有没有 train\vendor\LLaMA-Factory
    goto :end
)

echo   [1/4] 当前 llamafactory 指向哪里...
"%PY%" -c "import llamafactory; print('    ' + llamafactory.__file__)" 2>&1

echo.
echo   [2/4] 卸载旧的安装记录...
"%PY%" -m pip uninstall -y llamafactory 2>&1 | findstr /i "Successfully uninstalled Skipping"

echo.
echo   [3/4] 重新做 editable 安装（指向包内源码）...
"%PY%" -m pip install -e "%VENDOR%" --no-deps --no-build-isolation --progress-bar off 2>&1

echo.
echo   [4/4] 验证...
"%PY%" -c "import llamafactory; print('    llamafactory -> ' + llamafactory.__file__)" 2>&1
"%PY%" -c "from llamafactory.data import get_template_and_fix_tokenizer; print('    llamafactory.data OK')" 2>&1
"%PY%" -c "from llamafactory.train.tuner import run_exp; print('    llamafactory.train.tuner OK')" 2>&1

echo.
echo   ============================================
echo   如果上面两行都显示 OK，就可以双击 手动训练.bat 了
echo   ============================================
echo.

:end
echo   窗口不会自动关闭，看完了按任意键...
pause >nul
