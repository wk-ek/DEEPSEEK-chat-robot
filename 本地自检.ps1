# ============================================================
#  阿米娅训练包 · 本地自检
#
#  在你自己的电脑上跑，检查环境是否满足要求。
#  纯诊断，不安装任何东西，不改任何配置。
#
#  用法（PowerShell）：
#      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#      .\本地自检.ps1
#
#  或者双击 本地自检.bat
# ============================================================

param(
    [string]$Log = ""
)

$ErrorActionPreference = "Continue"

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

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

function Hr { Write-Host ("  " + ("=" * 60)) -ForegroundColor DarkGray }
function Section($t) { Write-Host ""; Write-Host "  【$t】" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    ✓ $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "    ✗ $m" -ForegroundColor Red }
function Warn2($m){ Write-Host "    ! $m" -ForegroundColor Yellow }
function Info($m) { Write-Host "      $m" -ForegroundColor DarkGray }

$problems = 0
$warnings = 0

Write-Host ""
Hr
Write-Host "  阿米娅人格模型 · 本地环境自检" -ForegroundColor Cyan
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
Hr

# ============================================================
# 1. 系统信息
# ============================================================
Section "系统信息"

$os = Get-CimInstance Win32_OperatingSystem
$osCaption = $os.Caption
Write-Host "    系统: $osCaption $($os.Version)"

# Windows Server 识别
$isServer = $false
if ($osCaption -match "Server" -or $os.ProductType -ne 1) { $isServer = $true }
if ($isServer) {
    $build = [int]($os.Version.Split('.')[2])
    $serverName = if ($build -ge 22000) { "Windows Server 2022" } elseif ($build -ge 17763) { "Windows Server 2019" } elseif ($build -ge 14393) { "Windows Server 2016" } else { "Windows Server（旧版）" }
    Write-Host "    检测到: $serverName" -ForegroundColor Yellow
    $script:isServerOS = $true
    if ($build -lt 17763) {
        Warn2 "Server 版本较旧，部分 Python 包可能不兼容"
        $warnings++
    }
    Write-Host "    注意: Server 版对消费级显卡（GeForce）的驱动支持有限" -ForegroundColor DarkYellow
    Write-Host "          如果 nvidia-smi 用不了，多半是驱动问题，不是脚本问题" -ForegroundColor DarkYellow
}

$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1)
Write-Host "    CPU:  $($cpu.Name.Trim())"
Write-Host "           $($cpu.NumberOfCores) 核 $($cpu.NumberOfLogicalProcessors) 线程"

$ramGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
Write-Host "    内存: $ramGB GB"
if ($ramGB -lt 16) {
    Warn2 "内存偏小，训练建议 32 GB 以上"
    $warnings++
} else {
    Ok "内存够用"
}

# ============================================================
# 2. Python
# ============================================================
Section "Python"

$python = $null
foreach ($cmd in @("python", "python3")) {
    try {
        $null = & $cmd --version 2>&1
        if ($LASTEXITCODE -eq 0) { $python = $cmd; break }
    } catch { }
}

if (-not $python) {
    Bad "没找到 Python"
    Info "去 https://www.python.org/downloads/ 安装，勾选 Add to PATH"
    $problems++
} else {
    $pyVer = (& $python --version 2>&1).ToString().Trim()
    Write-Host "    版本: $pyVer"
    $verNum = ($pyVer -replace 'Python\s*', '').Trim()
    $major = [int]($verNum.Split('.')[0])
    $minor = [int]($verNum.Split('.')[1])
    if ($major -gt 3 -or ($major -eq 3 -and $minor -ge 10)) {
        Ok "版本满足要求（需要 3.10+）"
    } else {
        Bad "版本太旧，需要 3.10+"
        $problems++
    }
}

# ============================================================
# 3. PyTorch / CUDA
# ============================================================
Section "PyTorch / CUDA"

$hasTorch = $false
if ($python) {
    try {
        $null = & $python -c "import torch" 2>&1
        $hasTorch = ($LASTEXITCODE -eq 0)
    } catch { }
}

if (-not $hasTorch) {
    Bad "没装 PyTorch"
    Info "装 CUDA 版（别装 CPU 版）："
    Info "  pip install torch --index-url https://download.pytorch.org/whl/cu121"
    $problems++
} else {
    $torchInfo = (& $python -c "import torch; print(torch.__version__)" 2>&1).ToString().Trim()
    Write-Host "    PyTorch: $torchInfo"

    $cudaProbe = (& $python -c "import torch; print(torch.cuda.is_available())" 2>&1).ToString().Trim()
    if ($cudaProbe -eq "True") {
        Ok "CUDA 可用"
        $gpuName = (& $python -c "import torch; print(torch.cuda.get_device_name(0))" 2>&1).ToString().Trim()
        $vram = (& $python -c "import torch; print(round(torch.cuda.get_device_properties(0).total_memory/1024**3,1))" 2>&1).ToString().Trim()
        $cudaVer = (& $python -c "import torch; print(torch.version.cuda)" 2>&1).ToString().Trim()
        Write-Host "    显卡: $gpuName"
        Write-Host "    显存: $vram GB"
        Write-Host "    CUDA: $cudaVer"

        $vramNum = [double]$vram
        if ($vramNum -lt 6) {
            Bad "显存 $vramNum GB —— 训练 4B 模型需要至少 6 GB（QLoRA）"
            Info "你的显存只能做推理，不能训练"
            $problems++
        } elseif ($vramNum -lt 15) {
            Warn2 "显存 $vramNum GB —— 训练 4B 会很勉强，建议 16 GB 以上"
            $warnings++
        } else {
            Ok "显存充足，可以本地训练 4B 模型"
        }
    } else {
        Bad "CUDA 不可用（PyTorch 可能是 CPU 版）"
        Info "重装 CUDA 版：pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cu121"
        $problems++

        # Windows Server 上最常见的是驱动问题，不是 torch 问题
        if ($script:isServerOS) {
            Write-Host ""
            Warn2 "这是 Windows Server —— 先确认驱动，再怀疑 torch"
            Info "跑一下：nvidia-smi"
            Info "  · 能输出显卡信息 → 驱动 OK，问题在 torch，按上面重装"
            Info "  · 提示不是内部或外部命令 → 没装驱动，这是根本原因"
            Info "  · 报错 → 驱动型号不匹配"
            Write-Host ""
            Info "Server 版的驱动坑：NVIDIA 官方不提供 GeForce 驱动给 Windows Server。"
            Info "如果你的卡是 RTX 4090 这种消费卡，可能根本装不上驱动。"
            Info "这时候别折腾了，换 Ubuntu 容器，同样的钱，一条命令搞定。"
        }
    }
}

# ============================================================
# 4. 磁盘空间
# ============================================================
Section "磁盘空间"

try {
    $drive = (Get-Item $PSScriptRoot).PSDrive
    $freeGB = [math]::Round($drive.Free / 1GB, 1)
    Write-Host "    $($drive.Name): 盘可用 $freeGB GB"
    if ($freeGB -lt 20) {
        Warn2 "训练需要约 20 GB（模型 + 输出），空间偏紧"
        $warnings++
    } else {
        Ok "空间充足"
    }
} catch {
    Warn2 "无法读取磁盘空间"
}

# ============================================================
# 5. 训练包完整性
# ============================================================
Section "训练包完整性"

$checks = @(
    @{ Path = "train\run.ps1";                  Name = "Windows 训练脚本" },
    @{ Path = "train\run.sh";                   Name = "Linux 训练脚本" },
    @{ Path = "train\stage1-wisdom.yaml";       Name = "Stage 1 配置" },
    @{ Path = "train\stage2-persona.yaml";      Name = "Stage 2 配置" },
    @{ Path = "train\stage3-extra.yaml";        Name = "Stage 3 配置" },
    @{ Path = "train\dataset_info.json";        Name = "数据注册表" },
    @{ Path = "config\persona.amiya.profile.json"; Name = "人格档案" },
    @{ Path = "src\llm\deepseek.js";            Name = "依赖模块" }
)

foreach ($c in $checks) {
    $full = Join-Path $PSScriptRoot $c.Path
    if (Test-Path $full) {
        Ok $c.Name
    } else {
        Bad "$($c.Name) 缺失：$($c.Path)"
        $problems++
    }
}

# 数据文件
$dataDirs = @(
    (Join-Path $PSScriptRoot "data"),
    (Join-Path $PSScriptRoot "train\out")
)
$dataDir = $null
foreach ($d in $dataDirs) {
    if (Test-Path (Join-Path $d "persona.jsonl")) { $dataDir = $d; break }
}

Write-Host ""
if ($dataDir) {
    Ok "训练数据在：$dataDir"
    foreach ($f in @("wisdom", "persona", "extra")) {
        $p = Join-Path $dataDir "$f.jsonl"
        if (Test-Path $p) {
            $n = (Get-Content $p -ErrorAction SilentlyContinue | Measure-Object).Count
            Write-Host "      $f.jsonl  $n 条" -ForegroundColor DarkGray
        }
    }
} else {
    Bad "找不到训练数据（persona.jsonl）"
    Info "应该在 data\ 或 train\out\ 目录"
    $problems++
}

# 剧情素材
$storyDir = Join-Path $PSScriptRoot "story"
if (Test-Path $storyDir) {
    $n = (Get-ChildItem $storyDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Ok "剧情素材 $n 个文件"
} else {
    Warn2 "没有 story\ 目录（不影响训练，数据已经准备好了）"
}

# ============================================================
# 6. 结论
# ============================================================
Hr
Write-Host ""

if ($problems -eq 0 -and $warnings -eq 0) {
    Write-Host "  结论：本机完全可以训练" -ForegroundColor Green
    Write-Host ""
    Write-Host "  下一步：" -ForegroundColor Cyan
    Write-Host "      .\train\run.ps1 -Dry      # 预检"
    Write-Host "      .\train\run.ps1           # 开训"
} elseif ($problems -eq 0) {
    Write-Host "  结论：基本可用，但有 $warnings 个警告" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  可以试跑，但可能慢或内存吃紧。" -ForegroundColor Yellow
} else {
    Write-Host "  结论：有 $problems 个问题需要处理" -ForegroundColor Red
    Write-Host ""

    if (-not $hasTorch) {
        Write-Host "  最常见的原因是没装 PyTorch。装它（CUDA 版）：" -ForegroundColor Cyan
        Write-Host "      pip install torch --index-url https://download.pytorch.org/whl/cu121" -ForegroundColor White
        Write-Host ""
    }

    Write-Host "  ⚠️  但说实话：你的机器更适合「云端训练 + 本地推理」" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "     训练 → 容器云 RTX 4090，1.88 元/时，约 1 小时，共 2 元" -ForegroundColor White
    Write-Host "     推理 → 本地跑 Ollama，免费" -ForegroundColor White
}

Write-Host ""
Write-Host "  详细说明见：train\部署指南-windows.md" -ForegroundColor DarkGray
Write-Host ""
Hr
Write-Host ""

# ---- 收尾：关日志并告诉用户报告在哪 ----
if ($script:LogFile) {
    $logPath = $script:LogFile
    Stop-Log
    Write-Host ""
    Write-Host "  报告已保存：$logPath" -ForegroundColor Green
    if (Test-Path $logPath) {
        $kb = [math]::Round((Get-Item $logPath).Length / 1KB, 1)
        Write-Host "  文件大小：$kb KB" -ForegroundColor DarkGray
    }
} else {
    Stop-Log
}
Write-Host ""