# ============================================================
#  依赖崩溃诊断
#
#  逐个 import 每个包，找出是哪个导致 0xC0000005 崩溃的。
#  双击 诊断依赖.bat 运行。
# ============================================================

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$ErrorActionPreference = "Continue"

# ---- 找 Python ----
$py = $null
$candidates = @(
    "C:\Program Files\Python312\python.exe",
    "C:\Program Files\Python311\python.exe",
    "C:\Program Files\Python310\python.exe"
)
foreach ($c in $candidates) {
    if (Test-Path $c) { $py = $c; break }
}
if (-not $py) {
    foreach ($cmd in @("python", "python3")) {
        try {
            $null = & $cmd --version 2>&1
            if ($LASTEXITCODE -eq 0) { $py = $cmd; break }
        } catch { }
    }
}
if (-not $py) {
    Write-Host "找不到 Python" -ForegroundColor Red
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host "     依赖崩溃诊断" -ForegroundColor Cyan
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Python: $py" -ForegroundColor DarkGray
Write-Host ""

# 版本
$ver = (& $py --version 2>&1).ToString().Trim()
Write-Host "  版本: $ver"
Write-Host ""

# ---- 逐个测试 ----
$tests = @(
    @{ Name = "numpy";        Code = "import numpy; print(numpy.__version__)" },
    @{ Name = "pyarrow";      Code = "import pyarrow; print(pyarrow.__version__)" },
    @{ Name = "tokenizers";   Code = "import tokenizers; print(tokenizers.__version__)" },
    @{ Name = "safetensors";  Code = "import safetensors; print(safetensors.__version__)" },
    @{ Name = "sentencepiece"; Code = "import sentencepiece; print('ok')" },
    @{ Name = "pandas";       Code = "import pandas; print(pandas.__version__)" },
    @{ Name = "scipy";        Code = "import scipy; print(scipy.__version__)" },
    @{ Name = "torch";        Code = "import torch; print(torch.__version__); print('cuda=' + str(torch.cuda.is_available()))" },
    @{ Name = "transformers"; Code = "import transformers; print(transformers.__version__)" },
    @{ Name = "datasets";     Code = "import datasets; print(datasets.__version__)" },
    @{ Name = "accelerate";   Code = "import accelerate; print(accelerate.__version__)" },
    @{ Name = "peft";         Code = "import peft; print(peft.__version__)" },
    @{ Name = "trl";          Code = "import trl; print(trl.__version__)" },
    @{ Name = "llamafactory"; Code = "import llamafactory; print(llamafactory.__version__)" },
    @{ Name = "tuner";        Code = "from llamafactory.train.tuner import run_exp; print('ok')" }
)

$crashed = @()
$failed = @()

foreach ($t in $tests) {
    Write-Host ("  [{0}] {1} ... " -f ($tests.IndexOf($t) + 1), $t.Name) -NoNewline
    $out = & $py -c $t.Code 2>&1
    $code = $LASTEXITCODE
    $outStr = ($out | Out-String).Trim()

    if ($code -eq 0) {
        $detail = ($outStr -split "`n" | Select-Object -First 1).Trim()
        Write-Host "OK  $detail" -ForegroundColor Green
    } elseif ($code -eq -1073741819 -or $code -eq 3221225477) {
        Write-Host "崩溃 (0xC0000005 访问冲突)" -ForegroundColor Red
        $crashed += $t.Name
        Write-Host ""
        Write-Host "  ══════════════════════════════════════════" -ForegroundColor Red
        Write-Host "  找到了：$($t.Name) 导致进程崩溃" -ForegroundColor Red
        Write-Host "  ══════════════════════════════════════════" -ForegroundColor Red
        Write-Host ""
        break
    } else {
        Write-Host "失败 (退出码 $code)" -ForegroundColor Yellow
        if ($outStr) { Write-Host "      $($outStr.Split("`n")[0])" -ForegroundColor DarkGray }
        $failed += $t.Name
    }
}

Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
if ($crashed.Count -gt 0) {
    Write-Host "  结论：$($crashed[0]) 崩溃了" -ForegroundColor Red
    Write-Host ""
    Write-Host "  这就是 0xC0000005 的来源。把上面这段结果发出来，"
    Write-Host "  我会换一个更稳定的版本重新打包。"
} elseif ($failed.Count -gt 0) {
    Write-Host "  结论：$($failed -join ', ') 导入失败（不是崩溃）" -ForegroundColor Yellow
    Write-Host "  把结果发出来。"
} else {
    Write-Host "  结论：所有模块都能正常导入，没有崩溃" -ForegroundColor Green
    Write-Host ""
    Write-Host "  那 Stage 1 的崩溃可能发生在："
    Write-Host "    · 模型下载阶段（网络或磁盘）"
    Write-Host "    · 加载模型时（显存或 CUDA 驱动）"
    Write-Host ""
    Write-Host "  试试手动跑（注意开头的 & 和引号）："
    Write-Host '    & "C:\Program Files\Python312\Scripts\llamafactory-cli.exe" --help'
}
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "  按任意键退出..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
