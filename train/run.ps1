# ============================================================
#  阿米娅人格模型 · 一键训练（Windows 版）
#
#  用法（在云端的 Windows 实例里，PowerShell 中）：
#      .\train\run.ps1               完整三阶段
#      .\train\run.ps1 -Dry          只检查环境
#      .\train\run.ps1 -OfficialOnly 跳过同人层
#      .\train\run.ps1 -SkipExport   训完不合并
#
#  前置：数据在 ..\data\（包内自带）
#
#  如果提示「禁止运行脚本」，先执行：
#      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# ============================================================
param(
    [switch]$Dry,
    [switch]$OfficialOnly,
    [switch]$SkipExport,
    [string]$DataDir,
    [string]$OutDir,
    [string]$BaseModel = "Qwen/Qwen3-4B-Instruct-2507",
    [string]$LfDir,
    [string]$Log = ""
)

$ErrorActionPreference = "Stop"

# ---- 控制台 UTF-8，避免中文乱码 ----
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

function Say($msg) { Write-Host "  > $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  OK $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Die($msg) { Write-Host "  X $msg" -ForegroundColor Red; Stop-Log; exit 1 }
function Hr { Write-Host ("  " + ("-" * 50)) -ForegroundColor DarkGray }

$ScriptDir = $PSScriptRoot
$RootDir = Split-Path $ScriptDir -Parent

# ---- 默认路径 ----
if (-not $DataDir) {
    # 按优先级找数据：包内的 data/ → 开发环境的 train/out/
    $candidates = @(
        (Join-Path $RootDir "data"),
        (Join-Path $ScriptDir "out"),
        (Join-Path $RootDir "train\out")
    )
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c "persona.jsonl")) { $DataDir = $c; break }
    }
    if (-not $DataDir) { $DataDir = $candidates[0] }
}
if (-not $OutDir) { $OutDir = Join-Path $RootDir "output" }
if (-not $LfDir) { $LfDir = Join-Path $RootDir "LLaMA-Factory" }

$env:PYTHONIOENCODING = "utf-8"

Write-Host ""
# ---- 日志：同时输出到控制台和 txt 文件 ----
$script:LogFile = $null
if ($Log) {
    $script:LogFile = $Log
    try {
        $logDir = Split-Path $Log -Parent
        if ($logDir -and -not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
        Start-Transcript -Path $Log -Force -ErrorAction Stop | Out-Null
    } catch {
        Write-Host "  ! 日志启动失败：$($_.Exception.Message)" -ForegroundColor Yellow
        $script:LogFile = $null
    }
}

function Stop-Log {
    if ($script:LogFile) {
        try { Stop-Transcript -ErrorAction SilentlyContinue | Out-Null } catch { }
        $script:LogFile = $null
    }
}

Write-Host "  === 阿米娅人格模型（Windows）===" -ForegroundColor Cyan
Write-Host ""

# ---------- 1. 环境检查 ----------
Say "检查环境"

# Python
$python = $null
foreach ($cmd in @("python", "python3")) {
    try {
        $null = & $cmd --version 2>&1
        if ($LASTEXITCODE -eq 0) { $python = $cmd; break }
    } catch { }
}
if (-not $python) {
    Die "没找到 Python。安装 https://www.python.org/downloads/ 时勾选 Add to PATH"
}

$pyVer = (& $python -c "import sys; print(str(sys.version_info.major)+'.'+str(sys.version_info.minor))").Trim()
Write-Host "    Python $pyVer" -ForegroundColor DarkGray
& $python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"
if ($LASTEXITCODE -ne 0) { Die "Python 太旧（$pyVer），需要 3.10+" }

# torch / CUDA
$hasTorch = $false
try {
    $null = & $python -c "import torch" 2>&1
    $hasTorch = ($LASTEXITCODE -eq 0)
} catch { }

if (-not $hasTorch) {
    Warn "没装 torch，稍后安装依赖时会一起装（约 2-3 GB）"
} else {
    # 用单引号 here-string，避免 PowerShell 解析 Python 代码里的大括号
    $pyProbe = @'
import torch, sys
if not torch.cuda.is_available():
    print('NOCUDA')
    sys.exit(1)
p = torch.cuda.get_device_properties(0)
vram = p.total_memory / 1024**3
print(str(p.name) + '|' + format(vram, '.1f') + '|' + str(torch.version.cuda))
'@
    $cudaInfo = (& $python -c $pyProbe 2>&1) -join ""
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  X CUDA 不可用。检查：" -ForegroundColor Red
        Write-Host "      1. nvidia-smi 能跑吗？不能的话先装显卡驱动" -ForegroundColor Red
        Write-Host "      2. torch 是不是 CPU 版？重装：" -ForegroundColor Red
        Write-Host "         $python -m pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cu121" -ForegroundColor Red
        exit 1
    }
    $parts = $cudaInfo.Trim().Split('|')
    Write-Host "    GPU: $($parts[0])  $($parts[1]) GB" -ForegroundColor DarkGray
    Write-Host "    CUDA: $($parts[2])" -ForegroundColor DarkGray
    $vram = [double]$parts[1]
    if ($vram -lt 15) { Warn "显存 $vram GB 偏小，4B 训练建议 16GB+" }
}

# ---- 判断用 bf16 还是 fp16（V100/T4 这类卡不支持 bf16）----
$script:PrecisionArg = "bf16=true"
$script:PrecisionName = "bf16"
try {
    $gpuName = (& $python -c "import torch; print(torch.cuda.get_device_name(0))").ToString().Trim()
    $capMajor = [int]((& $python -c "import torch; print(torch.cuda.get_device_capability(0)[0])").ToString().Trim())
    $capMinor = [int]((& $python -c "import torch; print(torch.cuda.get_device_capability(0)[1])").ToString().Trim())
    Write-Host "    架构: SM $capMajor.$capMinor" -ForegroundColor DarkGray

    # bf16 需要 Ampere 及以上（SM 8.0+）
    # Volta=7.0, Turing=7.5, Ampere=8.0/8.6, Ada=8.9, Hopper=9.0
    if ($capMajor -ge 8) {
        $script:PrecisionArg = "bf16=true"
        $script:PrecisionName = "bf16"
        Ok "支持 bf16（Ampere 及以上）"
    } else {
        $script:PrecisionArg = "fp16=true"
        $script:PrecisionName = "fp16"
        Warn2 "$gpuName 是 SM $capMajor.$capMinor，不支持 bf16"
        Info "改用 fp16（速度一样，精度略低但训练够用）"
    }
} catch {
    Warn2 "判断精度失败，默认用 fp16（最兼容）"
    $script:PrecisionArg = "fp16=true"
    $script:PrecisionName = "fp16"
}

Ok "环境正常"

# ---------- 2. 数据检查 ----------
Hr
Say "检查数据"
if (-not (Test-Path $DataDir)) { Die "数据目录不存在：$DataDir" }
# dataset_info.json 是 LLaMA-Factory 的数据注册表，必须在数据目录里
$infoFile = Join-Path $DataDir "dataset_info.json"
if (-not (Test-Path $infoFile)) {
    $infoSrc = Join-Path $ScriptDir "dataset_info.json"
    if (Test-Path $infoSrc) {
        Copy-Item $infoSrc $infoFile -Force
        Write-Host "    已把 train\dataset_info.json 复制到数据目录" -ForegroundColor DarkGray
    } else {
        Die "缺少 dataset_info.json（应该在 train\ 或数据目录里）"
    }
}

$needWisdom = Test-Path (Join-Path $DataDir "wisdom.jsonl")
$needPersona = Test-Path (Join-Path $DataDir "persona.jsonl")
$haveExtra = Test-Path (Join-Path $DataDir "extra.jsonl")

if (-not $needPersona) { Die "缺少 persona.jsonl（Stage 2 必需）" }

foreach ($f in @("wisdom", "wisdom_val", "persona", "persona_val", "extra", "extra_val")) {
    $p = Join-Path $DataDir "$f.jsonl"
    if (Test-Path $p) {
        $n = (Get-Content $p -ErrorAction SilentlyContinue | Measure-Object).Count
        Write-Host "    $f.jsonl  $n 条" -ForegroundColor DarkGray
    }
}
Ok "数据检查通过"

if ($Dry) {
    Hr
    Write-Host "  -Dry：环境与数据检查完成，不安装依赖、不训练" -ForegroundColor Yellow
    Write-Host "  确认无误后运行： .\train\run.ps1" -ForegroundColor Yellow
    if ($script:LogFile) {
        $lp = $script:LogFile
        Stop-Log
        Write-Host "  日志已保存：$lp" -ForegroundColor Green
    }
    Write-Host ""
    exit 0
}

# ---------- 3. 装 LLaMA-Factory ----------
Hr
$lfCli = $null
try { $lfCli = (Get-Command llamafactory-cli -ErrorAction Stop).Source } catch { }

if (-not $lfCli) {
    Say "安装 LLaMA-Factory（首次约 5-10 分钟）"
    if (-not (Test-Path $LfDir)) {
        git clone --depth 1 https://github.com/hiyouga/LLaMA-Factory.git $LfDir
        if ($LASTEXITCODE -ne 0) { Die "git clone 失败。装 Git: https://git-scm.com/download/win" }
    }
    Push-Location $LfDir
    try {
        & $python -m pip install -e ".[torch,metrics]" -q
        if ($LASTEXITCODE -ne 0) {
            Warn "标准安装失败，换国内源重试"
            & $python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -e ".[torch,metrics]" -q
            if ($LASTEXITCODE -ne 0) {
                Die "依赖安装失败。常见原因：缺 Visual Studio Build Tools（https://visualstudio.microsoft.com/visual-cpp-build-tools/）"
            }
        }
    } finally { Pop-Location }
    Ok "安装完成"
} else {
    Ok "LLaMA-Factory 已安装"
}

# ---------- 4. bitsandbytes 检测 ----------
Hr
Say "检查 bitsandbytes（4bit 量化）"
$hasBnb = $false
try {
    $null = & $python -c "import bitsandbytes" 2>&1
    $hasBnb = ($LASTEXITCODE -eq 0)
} catch { }

if (-not $hasBnb) {
    Warn "没装 bitsandbytes，尝试安装…"
    & $python -m pip install bitsandbytes -q 2>&1 | Out-Null
    try {
        $null = & $python -c "import bitsandbytes" 2>&1
        $hasBnb = ($LASTEXITCODE -eq 0)
    } catch { }
}


if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$TotalStart = Get-Date

function Get-YamlPath($name) {
    $withSuffix = Join-Path $ScriptDir ($name + $YamlSuffix + ".yaml")
    if (Test-Path $withSuffix) { return $withSuffix }
    return (Join-Path $ScriptDir ($name + ".yaml"))
}

# ---------- 5. Stage 1 ----------
$Stage2Base = ""
if ($needWisdom) {
    Hr
    Write-Host "  Stage 1 / 智慧层：让她认识这个世界" -ForegroundColor Cyan
    Say "约 2045 条，20-30 分钟"
    $s = Get-Date
    $yaml = Get-YamlPath "stage1-wisdom"
    & llamafactory-cli train $yaml "model_name_or_path=$BaseModel" "dataset_dir=$DataDir" "output_dir=$(Join-Path $OutDir 'stage1-wisdom')" "$($script:PrecisionArg)"
    if ($LASTEXITCODE -ne 0) { Die "Stage 1 失败" }
    Ok "Stage 1 完成（$([math]::Round(((Get-Date) - $s).TotalMinutes)) 分钟）"
    $Stage2Base = Join-Path $OutDir "stage1-wisdom"
} else {
    Warn "没有 wisdom 数据，跳过 Stage 1"
}

# ---------- 6. Stage 2 ----------
Hr
Write-Host "  Stage 2 / 说话层：让她像阿米娅那样说话" -ForegroundColor Cyan
Say "约 4824 条，20-30 分钟"
$s = Get-Date
$yaml = Get-YamlPath "stage2-persona"
$stage2Args = @("train", $yaml, "model_name_or_path=$BaseModel", "dataset_dir=$DataDir", "output_dir=$(Join-Path $OutDir 'stage2-persona')", "$($script:PrecisionArg)")
if ($Stage2Base) { $stage2Args += "adapter_name_or_path=$Stage2Base" }
& llamafactory-cli @stage2Args
if ($LASTEXITCODE -ne 0) { Die "Stage 2 失败" }
Ok "Stage 2 完成（$([math]::Round(((Get-Date) - $s).TotalMinutes)) 分钟）→ 这是【纯官方版】"

# ---------- 7. Stage 3 ----------
$FinalDir = Join-Path $OutDir "stage2-persona"
$FinalName = "amiya-official"

if ($haveExtra -and -not $OfficialOnly) {
    Hr
    Write-Host "  Stage 3 / 同人层：加一层同人的味道" -ForegroundColor Cyan
    Say "在纯官方版基础上微调"
    $s = Get-Date
    $yaml = Get-YamlPath "stage3-extra"
    & llamafactory-cli train $yaml "model_name_or_path=$BaseModel" "dataset_dir=$DataDir" "adapter_name_or_path=$FinalDir" "output_dir=$(Join-Path $OutDir 'stage3-extra')" "$($script:PrecisionArg)"
    if ($LASTEXITCODE -eq 0) {
        Ok "Stage 3 完成（$([math]::Round(((Get-Date) - $s).TotalMinutes)) 分钟）→ 这是【官方+同人版】"
        $FinalDir = Join-Path $OutDir "stage3-extra"
        $FinalName = "amiya-extra"
    } else {
        Warn "Stage 3 失败，不影响官方版"
    }
}

# ---------- 8. 导出 ----------
if (-not $SkipExport) {
    Hr
    Write-Host "  导出完整模型" -ForegroundColor Cyan
    Say "把 LoRA 合并进基座，约 10 分钟"

    $yaml = Get-YamlPath "stage2-persona"
    & llamafactory-cli export $yaml "model_name_or_path=$BaseModel" "adapter_name_or_path=$(Join-Path $OutDir 'stage2-persona')" "export_dir=$(Join-Path $OutDir 'amiya-official-merged')" "export_size=4"
    if ($LASTEXITCODE -eq 0) { Ok "官方版 → $OutDir\amiya-official-merged" }
    else { Warn "官方版合并失败（LoRA 还在，可稍后单独导出）" }

    if ($FinalName -eq "amiya-extra") {
        $yaml3 = Get-YamlPath "stage3-extra"
        & llamafactory-cli export $yaml3 "model_name_or_path=$BaseModel" "adapter_name_or_path=$(Join-Path $OutDir 'stage3-extra')" "export_dir=$(Join-Path $OutDir 'amiya-extra-merged')" "export_size=4"
        if ($LASTEXITCODE -eq 0) { Ok "同人版 → $OutDir\amiya-extra-merged" }
        else { Warn "同人版合并失败（LoRA 还在）" }
    }
}

# ---------- 9. 总结 ----------
$totalMin = [math]::Round(((Get-Date) - $TotalStart).TotalMinutes)
Write-Host ""
Write-Host "  === 全部完成（GPU 共 $totalMin 分钟）===" -ForegroundColor Green
Write-Host ""
Write-Host "  产物："
if (Test-Path (Join-Path $OutDir "amiya-official-merged")) {
    Write-Host "    $OutDir\amiya-official-merged      纯官方版（推荐主用）"
}
if (Test-Path (Join-Path $OutDir "amiya-extra-merged")) {
    Write-Host "    $OutDir\amiya-extra-merged         官方+同人版"
}
Write-Host "    $OutDir\stage2-persona              官方版 LoRA"
Write-Host ""
Write-Host "  ! 立刻关机！挂一晚上 20-30 元" -ForegroundColor Yellow
Write-Host "  GPU 预估花费：约 $([math]::Round($totalMin * 1.88 / 60, 2)) 元" -ForegroundColor DarkGray
Write-Host ""

Stop-Log
