# 从本地 wheels 目录装全部依赖（不依赖 pip 的依赖解析）
#
# 为什么不能用 --no-deps + 显式列表：
#   显式列表会漏掉传递依赖（regex / tokenizers / huggingface-hub /
#   pyarrow / dill / aiohttp / xxhash ...），一个个补太容易忘。
#
# 为什么不能不加 --no-deps：
#   transformers 和 peft 的 METADATA 里有 Requires-Dist: sentencepiece，
#   而 sentencepiece 在 Windows Server 上 import 就崩，已经删了。
#   不加 --no-deps 会因为找不到它而整个安装失败。
#
# 所以：遍历目录里所有 wheel，分批 --no-deps 装。
# 已装的 pip 会跳过，重复执行安全。

param(
    [string]$Py = "C:\Program Files\Python312\python.exe",
    [string]$WheelsDir = "",
    [int]$BatchSize = 25
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (-not $WheelsDir) {
    $WheelsDir = Join-Path (Split-Path $PSScriptRoot -Parent) "train\vendor\wheels"
}
if (-not (Test-Path $WheelsDir)) {
    Write-Host "  [错误] 找不到 wheels 目录：$WheelsDir" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $Py)) {
    Write-Host "  [错误] 找不到 python：$Py" -ForegroundColor Red
    exit 1
}

$wheels = Get-ChildItem $WheelsDir -Filter *.whl | Sort-Object Name
Write-Host "  找到 $($wheels.Count) 个 wheel" -ForegroundColor DarkGray
Write-Host ""

$failed = @()
$ok = 0
$i = 0

# 分批装，避免命令行过长
for ($start = 0; $start -lt $wheels.Count; $start += $BatchSize) {
    $end = [Math]::Min($start + $BatchSize - 1, $wheels.Count - 1)
    $batch = @()
    for ($j = $start; $j -le $end; $j++) {
        $batch += $wheels[$j].FullName
    }

    $i++
    $total = [Math]::Ceiling($wheels.Count / $BatchSize)
    Write-Host "  [批次 $i/$total] $($batch.Count) 个包：$($wheels[$start].Name) ... $($wheels[$end].Name)" -ForegroundColor Cyan

    $lines = & $Py -m pip install --no-index --no-deps --progress-bar off @batch 2>&1
    $rc = $LASTEXITCODE

    # 只显示错误行和成功汇总，太啰嗦的过滤掉
    foreach ($line in $lines) {
        $s = $line.ToString()
        if ($s -match 'ERROR|error:|Failed|failed' ) {
            Write-Host "      $s" -ForegroundColor Red
        } elseif ($s -match 'Successfully installed') {
            Write-Host "      $s" -ForegroundColor Green
        }
    }

    if ($rc -eq 0) {
        $ok += $batch.Count
    } else {
        # 批次失败就逐个重试，定位是哪个包
        Write-Host "      批次失败，逐个重试..." -ForegroundColor Yellow
        foreach ($b in $batch) {
            $one = & $Py -m pip install --no-index --no-deps -q $b 2>&1
            if ($LASTEXITCODE -eq 0) {
                $ok++
            } else {
                $failed += (Split-Path $b -Leaf)
            }
        }
    }
}

Write-Host ""
Write-Host "  ============================================"
if ($failed.Count -eq 0) {
    Write-Host "  全部装好（$ok 个 wheel）" -ForegroundColor Green
} else {
    Write-Host "  成功 $ok 个，失败 $($failed.Count) 个" -ForegroundColor Yellow
    Write-Host "  失败列表："
    $failed | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
}
Write-Host "  ============================================"

exit $(if ($failed.Count -eq 0) { 0 } else { 1 })
