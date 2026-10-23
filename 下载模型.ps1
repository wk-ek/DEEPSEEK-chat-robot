# ============================================================
#  下载 Qwen3-4B 模型（从 ModelScope 魔搭，国内快）
#
#  双击 下载模型.bat 运行。
#  共 14 个文件 7.51 GB，支持断点续传（已下载的会跳过）。
#  下完后训练自动用本地模型，不需要再联网。
# ============================================================

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = "Continue"

function Hr { Write-Host ("  " + ("=" * 56)) -ForegroundColor DarkGray }
function Ok($m) { Write-Host "  OK $m" -ForegroundColor Green }
function Warn2($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Bad($m) { Write-Host "  X $m" -ForegroundColor Red }
function Info($m) { Write-Host "    $m" -ForegroundColor DarkGray }

$ScriptDir = $PSScriptRoot
$ModelDir = Join-Path $ScriptDir "models\Qwen3-4B-Instruct-2507"
$ModelId = "Qwen/Qwen3-4B-Instruct-2507"

Write-Host ""
Hr
Write-Host "  下载 Qwen3-4B-Instruct-2507" -ForegroundColor Cyan
Write-Host "  来源: ModelScope 魔搭（国内）" -ForegroundColor DarkGray
Hr
Write-Host ""

# ---- 磁盘检查 ----
$drive = (Get-Item $ScriptDir).PSDrive
$freeGB = [math]::Round($drive.Free / 1GB, 1)
Write-Host "  磁盘可用: $freeGB GB  ($($drive.Name):)"
if ($freeGB -lt 9) {
    Bad "空间不足！模型需要 7.51 GB，建议至少留 9 GB"
    Info "先清理磁盘，或者换个小模型（Qwen3-1.7B 只有 3.4 GB）"
    Write-Host ""
    Write-Host "  按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}
Ok "空间够（7.51 GB 模型 + 余量）"
Write-Host ""

if (-not (Test-Path $ModelDir)) { New-Item -ItemType Directory -Path $ModelDir -Force | Out-Null }

# ---- 文件清单 ----
$files = @(
    @{ Name = "config.json";                   Size = 1024 },
    @{ Name = "configuration.json";            Size = 1024 },
    @{ Name = "generation_config.json";        Size = 1024 },
    @{ Name = "merges.txt";                    Size = 1672192 },
    @{ Name = "model.safetensors.index.json";  Size = 32768 },
    @{ Name = "model-00001-of-00003.safetensors"; Size = 3961966592 },
    @{ Name = "model-00002-of-00003.safetensors"; Size = 3983583232 },
    @{ Name = "model-00003-of-00003.safetensors"; Size = 96665600 },
    @{ Name = "tokenizer.json";                Size = 11422720 },
    @{ Name = "tokenizer_config.json";         Size = 9216 },
    @{ Name = "vocab.json";                    Size = 2777088 }
)

$baseUrl = "https://www.modelscope.cn/api/v1/models/$ModelId/repo?Revision=master&FilePath="

$downloaded = 0
$skipped = 0
$failed = @()

Write-Host "  共 $($files.Count) 个文件"
Write-Host ""

for ($i = 0; $i -lt $files.Count; $i++) {
    $f = $files[$i]
    $target = Join-Path $ModelDir $f.Name
    $num = "[$($i+1)/$($files.Count)]"

    # 已存在且大小正确就跳过
    if (Test-Path $target) {
        $existSize = (Get-Item $target).Length
        if ($existSize -eq $f.Size -or ($f.Size -lt 10240 -and $existSize -gt 0)) {
            Write-Host "  $num $($f.Name)  已存在，跳过" -ForegroundColor DarkGray
            $skipped++
            continue
        }
        Write-Host "  $num $($f.Name)  大小不符，重新下载" -ForegroundColor Yellow
        Remove-Item $target -Force
    }

    $sizeMB = [math]::Round($f.Size / 1MB, 1)
    Write-Host "  $num $($f.Name)  ($sizeMB MB)" -ForegroundColor White

    $url = $baseUrl + $f.Name
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue

    if ($curl) {
        # curl 自带进度条，支持断点续传
        & curl.exe -L --fail --retry 3 --retry-delay 5 -C - -o "$target" "$url"
        $rc = $LASTEXITCODE
    } else {
        # 退回 PowerShell 下载（无进度条）
        try {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing -TimeoutSec 1800
            $rc = 0
        } catch {
            $rc = 1
        }
    }

    if ($rc -eq 0 -and (Test-Path $target)) {
        $got = (Get-Item $target).Length
        if ($f.Size -gt 10240 -and [math]::Abs($got - $f.Size) -gt 1024) {
            Warn2 "  大小不符（期望 $($f.Size)，实际 $got），可能下载不完整"
            $failed += $f.Name
        } else {
            $downloaded++
        }
    } else {
        Bad "  失败（退出码 $rc）"
        $failed += $f.Name
    }
    Write-Host ""
}

# ---- 总结 ----
Hr
Write-Host ""
$totalSize = 0
if (Test-Path $ModelDir) {
    $totalSize = (Get-ChildItem $ModelDir -File | Measure-Object -Sum Length).Sum
}

Write-Host "  下载: $downloaded 个   跳过: $skipped 个   失败: $($failed.Count) 个"
Write-Host "  目录: $ModelDir"
Write-Host "  体积: $([math]::Round($totalSize/1GB, 2)) GB"
Write-Host ""

if ($failed.Count -gt 0) {
    Bad "有 $($failed.Count) 个文件失败："
    $failed | ForEach-Object { Write-Host "    $_" -ForegroundColor Red }
    Write-Host ""
    Info "重新双击这个脚本会续传，已下载的不会重来"
} elseif ($totalSize -gt 7GB) {
    Ok "全部下载完成！"
    Write-Host ""
    Write-Host "  现在可以双击 手动训练.bat 或 开始训练.bat" -ForegroundColor Green
    Write-Host "  训练会自动用本地模型，不需要再联网。" -ForegroundColor Green
} else {
    Warn2 "体积偏小（$([math]::Round($totalSize/1GB,2)) GB），可能没下全"
    Info "重新双击会续传"
}

Write-Host ""
Hr
Write-Host ""
Write-Host "  按任意键退出..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
