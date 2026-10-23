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

$ErrorActionPreference = "Continue"

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
function Info($m) { Write-Host "      $m" -ForegroundColor DarkGray }

# 检查外部命令退出码，非零就中止（替代 ErrorActionPreference = Stop 的作用）
function Assert-Exit {
    param([string]$What)
    if ($LASTEXITCODE -ne 0) {
        Die "$What 失败（退出码 $LASTEXITCODE），往上翻看具体报错"
    }
}

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
$script:PrecisionArgs = @("bf16=true", "fp16=false")
$script:PrecisionName = "bf16"
try {
    $gpuName = (& $python -c "import torch; print(torch.cuda.get_device_name(0))").ToString().Trim()
    $capMajor = [int]((& $python -c "import torch; print(torch.cuda.get_device_capability(0)[0])").ToString().Trim())
    $capMinor = [int]((& $python -c "import torch; print(torch.cuda.get_device_capability(0)[1])").ToString().Trim())
    Write-Host "    架构: SM $capMajor.$capMinor" -ForegroundColor DarkGray

    # bf16 需要 Ampere 及以上（SM 8.0+）
    # Volta=7.0, Turing=7.5, Ampere=8.0/8.6, Ada=8.9, Hopper=9.0
    if ($capMajor -ge 8) {
        $script:PrecisionArgs = @("bf16=true", "fp16=false")
        $script:PrecisionName = "bf16"
        Ok "支持 bf16（Ampere 及以上）"
    } else {
        $script:PrecisionArgs = @("bf16=false", "fp16=true")
        $script:PrecisionName = "fp16"
        Warn "$gpuName 是 SM $capMajor.$capMinor，不支持 bf16"
        Info "改用 fp16（速度一样，精度略低但训练够用）"
    }
} catch {
    Warn "判断精度失败，默认用 fp16（最兼容）"
    $script:PrecisionArgs = @("bf16=false", "fp16=true")
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

# 判断 LLaMA-Factory 是否可用（用 python -m 检测，不依赖 PATH）
$lfOk = $false
try {
    $null = & $python -c "import llamafactory" 2>&1
    $lfOk = ($LASTEXITCODE -eq 0)
} catch { $lfOk = $false }

if (-not $lfOk -and $lfCli) { $lfOk = $true }

# ★ 关键：import llamafactory 不需要 transformers（__init__.py 只 import extras.env），
#   所以只测这个会漏掉依赖。必须逐个检查训练真正需要的模块。
$requiredMods = @("transformers", "datasets", "accelerate", "peft", "trl", "safetensors", "sentencepiece", "torch")
$missingDeps = @()
foreach ($m in $requiredMods) {
    & $python -c "import $m" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { $missingDeps += $m }
}
if ($missingDeps.Count -gt 0) {
    Warn "缺少依赖：$($missingDeps -join ', ')"
    $lfOk = $false
} else {
    Ok "训练依赖齐全（$($requiredMods.Count) 个模块都能 import）"
    $lfOk = $true
}

if (-not $lfOk) {
    Say "安装 LLaMA-Factory"

    # ★ 优先用包内自带的源码（train\vendor\LLaMA-Factory）
    #   这样完全不需要网络，也不依赖 git
    $vendorDir = Join-Path $ScriptDir "vendor\LLaMA-Factory"
    if ((Test-Path $vendorDir) -and (Test-Path (Join-Path $vendorDir "pyproject.toml"))) {
        Ok "使用包内自带的源码：train\vendor\LLaMA-Factory"
        Say "安装依赖（这一步要联网下 transformers/peft/trl 等，约 5-10 分钟）"

        & $python -m pip install -e $vendorDir --no-deps -q
        if ($LASTEXITCODE -ne 0) { Warn "editable 安装失败，尝试普通安装" }

        # ★ 优先用包内离线 wheel（完全不需要联网）
        $wheelsDir = Join-Path $ScriptDir "vendor\wheels"
        $wheelCount = 0
        if (Test-Path $wheelsDir) {
            $wheelCount = (Get-ChildItem $wheelsDir -Filter *.whl -ErrorAction SilentlyContinue | Measure-Object).Count
        }

        if ($wheelCount -ge 20) {
            $wheelsMB = [math]::Round(((Get-ChildItem $wheelsDir -Filter *.whl | Measure-Object -Sum Length).Sum / 1MB), 0)
            Ok "使用包内离线依赖：$wheelCount 个 wheel，$wheelsMB MB"
            Say "完全不需要联网，从本地 wheel 安装"

            $offlineDeps = @(
                "transformers", "datasets", "accelerate", "peft", "trl", "torchdata",
                "tyro", "einops", "numpy", "pandas", "scipy", "sentencepiece",
                "tiktoken", "hf-transfer", "safetensors", "fire", "omegaconf",
                "packaging", "protobuf", "pyyaml", "pydantic", "matplotlib", "setuptools"
            )

            # 不用 -q，让 pip 显示「Installing collected packages」等进度
            # 但要关掉下载进度条（本地文件，进度条没意义且刷屏）
            $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
            # 必须用 2>&1 捕获：PowerShell 5.1 的 Transcript 抓不到原生程序的 stderr
            $pipArgs = @("-m", "pip", "install", "--no-index", "--find-links", $wheelsDir, "--progress-bar", "off") + $offlineDeps
            $pipLines = & $python @pipArgs 2>&1
            $rc = $LASTEXITCODE
            $sw2.Stop()
            $pipLines | ForEach-Object { Write-Host "    $_" }
            Info "耗时 $([math]::Round($sw2.Elapsed.TotalSeconds)) 秒"

            if ($rc -ne 0) {
                Warn "离线安装返回码 $rc，看上面的具体包名"
                Info "如果报 torch 相关：云端 torch 可能没装好，跑 本地自检.bat 看"
                Info "如果报某个包找不到：该包没打进 wheels，把日志发我补上"
            }
        } else {
            Warn "包内没有 vendor\wheels（或文件太少），只能联网装"
            $deps = @(
                "transformers>=4.55.0,<=5.8.0",
                "datasets>=2.16.0,<=4.0.0",
                "accelerate>=1.3.0,<=1.11.0",
                "peft>=0.18.0,<=0.18.1",
                "trl>=0.18.0,<=0.24.0",
                "torchdata>=0.10.0,<=0.11.0",
                "tyro", "einops", "numpy", "pandas", "scipy", "sentencepiece",
                "tiktoken", "hf-transfer", "safetensors", "fire", "omegaconf",
                "packaging", "protobuf", "pyyaml", "pydantic", "matplotlib", "setuptools"
            )
            Say "装 $($deps.Count) 个依赖包（联网）"
            & $python -m pip install @deps -q -i https://pypi.tuna.tsinghua.edu.cn/simple --timeout 300 --retries 3
            if ($LASTEXITCODE -ne 0) {
                Warn "清华源失败，换阿里云"
                & $python -m pip install @deps -q -i https://mirrors.aliyun.com/pypi/simple --timeout 300 --retries 3
            }
        }

        try {
            $null = & $python -c "import llamafactory" 2>&1
            $lfOk = ($LASTEXITCODE -eq 0)
        } catch { $lfOk = $false }

    } else {
        Warn "包内没有 vendor\LLaMA-Factory，改用联网安装"
    }
}

if (-not $lfOk) {
    Say "联网安装 LLaMA-Factory"

    # 方式 1：pip install llamafactory（不需要 git）
    Say "方式 1/2：pip install llamafactory"
    & $python -m pip install llamafactory -q --timeout 300 --retries 3
    if ($LASTEXITCODE -ne 0) {
        Warn "PyPI 直连失败，换清华源"
        & $python -m pip install llamafactory -q -i https://pypi.tuna.tsinghua.edu.cn/simple --timeout 300 --retries 3
    }

    try {
        $null = & $python -c "import llamafactory" 2>&1
        $lfOk = ($LASTEXITCODE -eq 0)
    } catch { $lfOk = $false }

    # 方式 2：下载 zip 解压再装（pip 也失败时）
    if (-not $lfOk) {
        Warn "pip 安装失败，改用下载 zip"
        $zipUrl = "https://github.com/hiyouga/LLaMA-Factory/archive/refs/heads/main.zip"
        $zipTmp = Join-Path $env:TEMP "LLaMA-Factory-main.zip"
        $extractDir = Join-Path $env:TEMP "lf_extract"

        try {
            Say "下载 LLaMA-Factory（约 15 MB）"
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $zipUrl -OutFile $zipTmp -UseBasicParsing -TimeoutSec 300
            if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
            Expand-Archive -Path $zipTmp -DestinationPath $extractDir -Force
            $sub = Get-ChildItem $extractDir -Directory | Select-Object -First 1
            if ($sub) {
                Push-Location $sub.FullName
                try {
                    & $python -m pip install -e . -q -i https://pypi.tuna.tsinghua.edu.cn/simple --timeout 300
                } finally { Pop-Location }
            }
            try {
                $null = & $python -c "import llamafactory" 2>&1
                $lfOk = ($LASTEXITCODE -eq 0)
            } catch { $lfOk = $false }
        } catch {
            Warn "下载 zip 也失败：$($_.Exception.Message.Split([char]10)[0])"
        }
    }

    if (-not $lfOk) {
        Die @"
LLaMA-Factory 安装失败。

常见原因：
  1. 没有网络到 pypi.org 且清华源也不行
  2. 缺 Visual Studio Build Tools（部分包要编译）
     装这个：https://aka.ms/vs/17/release/vc_redist.x64.exe
  3. Python 版本太新导致某些包没有预编译 wheel
     这台是 Python 3.12，如果某个包只支持到 3.11，需要降到 3.11

手动试一下看具体报错：
  $python -m pip install llamafactory
"@
    }
    Ok "LLaMA-Factory 安装完成"
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
    $bnbWheelDir = Join-Path $ScriptDir "vendor\wheels"
    $bnbWheel = Get-ChildItem $bnbWheelDir -Filter "bitsandbytes-*.whl" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($bnbWheel) {
        Warn "没装 bitsandbytes，从包内离线安装（$($bnbWheel.Name)）"
        & $python -m pip install --no-index --find-links $bnbWheelDir --no-deps bitsandbytes -q 2>&1 | Out-Null
    } else {
        Warn "没装 bitsandbytes，尝试联网安装…"
        & $python -m pip install bitsandbytes -q 2>&1 | Out-Null
    }
    try {
        $null = & $python -c "import bitsandbytes" 2>&1
        $hasBnb = ($LASTEXITCODE -eq 0)
    } catch { $hasBnb = $false }
    if (-not $hasBnb) {
        Info "bitsandbytes 装不上无所谓 —— V100 用 fp16 LoRA 一样能训"
        Info "会自动切到不带量化的配置（多占约 6 GB 显存，32 GB 完全够）"
    }
}


if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$TotalStart = Get-Date

function Get-YamlPath($name) {
    $withSuffix = Join-Path $ScriptDir ($name + $YamlSuffix + ".yaml")
    if (Test-Path $withSuffix) { return $withSuffix }
    return (Join-Path $ScriptDir ($name + ".yaml"))
}

# ---------- 4.5 定位 llamafactory-cli 的真实路径 ----------
# pip 安装的脚本在 Python 的 Scripts 目录，可能不在 PATH 里
$LfExe = $null
try {
    $scriptsDir = (& $python -c "import sysconfig; print(sysconfig.get_path('scripts'))").ToString().Trim()
    foreach ($name in @("llamafactory-cli.exe", "llamafactory-cli")) {
        $cand = Join-Path $scriptsDir $name
        if (Test-Path $cand) { $LfExe = $cand; break }
    }
    if (-not $LfExe) {
        Info "Scripts 目录: $scriptsDir"
        Info "没找到 llamafactory-cli，改用 python -m 调用"
    } else {
        Ok "llamafactory-cli: $LfExe"
    }
} catch {
    Warn "定位 llamafactory-cli 失败，改用 python -m"
}

# 统一的调用函数
function Invoke-Lf {
    param([string[]]$LfArgs)
    # 2>&1 合并 stderr，否则 Python 的 traceback 在 Transcript 里看不到
    if ($LfExe) {
        & $LfExe @LfArgs 2>&1 | ForEach-Object { Write-Host $_ }
    } else {
        & $python -m llamafactory.cli @LfArgs 2>&1 | ForEach-Object { Write-Host $_ }
    }
}

# ---------- 5. Stage 1 ----------
$Stage2Base = ""
if ($needWisdom) {
    Hr
    Write-Host "  Stage 1 / 智慧层：让她认识这个世界" -ForegroundColor Cyan
    Say "约 2045 条，20-30 分钟"
    $s = Get-Date
    $yaml = Get-YamlPath "stage1-wisdom"
    Invoke-Lf (@("train", $yaml, "model_name_or_path=$BaseModel", "dataset_dir=$DataDir", "output_dir=$(Join-Path $OutDir 'stage1-wisdom')") + $script:PrecisionArgs)
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
$stage2Args = @("train", $yaml, "model_name_or_path=$BaseModel", "dataset_dir=$DataDir", "output_dir=$(Join-Path $OutDir 'stage2-persona')") + $script:PrecisionArgs
if ($Stage2Base) { $stage2Args += "adapter_name_or_path=$Stage2Base" }
Invoke-Lf $stage2Args
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
    Invoke-Lf (@("train", $yaml, "model_name_or_path=$BaseModel", "dataset_dir=$DataDir", "adapter_name_or_path=$FinalDir", "output_dir=$(Join-Path $OutDir 'stage3-extra')") + $script:PrecisionArgs)
    if ($LASTEXITCODE -eq 0) {
        Ok "Stage 3 完成（$([math]::Round(((Get-Date) - $s).TotalMinutes)) 分钟）→ 这是【官方+同人版】"
        $FinalDir = Join-Path $OutDir "stage3-extra"
        $FinalName = "amiya-extra"
    } else {
        Warn "Stage 3 失败，不影响官方版"
    }
}

# ---------- 8. 导出 ----------
# 磁盘不够时跳过合并：LoRA 权重只有几十 MB，合并成完整模型要 8 GB
$freeGB = 0
try {
    $drv = (Get-Item $OutDir).PSDrive
    if ($drv) { $freeGB = [math]::Round($drv.Free / 1GB, 1) }
} catch { }

if (-not $SkipExport -and $freeGB -gt 0 -and $freeGB -lt 15) {
    Hr
    Warn "磁盘只剩 $freeGB GB，不够合并导出（需要约 10 GB）"
    Say "跳过导出，只保留 LoRA 权重（约 50 MB）"
    Say "把 LoRA 下载回本地再合并即可，命令见文末"
    $SkipExport = $true
}

if (-not $SkipExport) {
    Hr
    Write-Host "  导出完整模型" -ForegroundColor Cyan
    Say "把 LoRA 合并进基座，约 10 分钟"

    $yaml = Get-YamlPath "stage2-persona"
    Invoke-Lf @("export", $yaml, "model_name_or_path=$BaseModel", "adapter_name_or_path=$(Join-Path $OutDir 'stage2-persona')", "export_dir=$(Join-Path $OutDir 'amiya-official-merged')", "export_size=4")
    if ($LASTEXITCODE -eq 0) { Ok "官方版 → $OutDir\amiya-official-merged" }
    else { Warn "官方版合并失败（LoRA 还在，可稍后单独导出）" }

    if ($FinalName -eq "amiya-extra") {
        $yaml3 = Get-YamlPath "stage3-extra"
        Invoke-Lf @("export", $yaml3, "model_name_or_path=$BaseModel", "adapter_name_or_path=$(Join-Path $OutDir 'stage3-extra')", "export_dir=$(Join-Path $OutDir 'amiya-extra-merged')", "export_size=4")
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
