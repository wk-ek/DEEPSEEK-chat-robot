# ============================================================
#  阿米娅训练包 · 环境安装
#
#  做两件事：
#    1. 检查 Python 版本，太旧或没有就装新的（3.12）
#    2. 检查 PyTorch，装成 CUDA 版（不是 CPU 版）
#
#  用法：
#      双击 安装环境.bat
#  或：
#      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#      .\安装环境.ps1
#
#  参数：
#      -PythonOnly      只处理 Python
#      -TorchOnly       只处理 PyTorch
#      -CudaVersion     指定 CUDA 版本（cu118 / cu121 / cu124 / cu126），默认自动检测
#      -Force           即使已装好也重装
#      -Log <path>      日志保存路径
# ============================================================
param(
    [switch]$PythonOnly,
    [switch]$TorchOnly,
    [switch]$Force,
    [string]$CudaVersion = "",
    [string]$Log = ""
)

$ErrorActionPreference = "Continue"

try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

# ---- 日志 ----
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

function Hr { Write-Host ("  " + ("=" * 60)) -ForegroundColor DarkGray }
function Section($t) { Write-Host ""; Write-Host "  【$t】" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    ✓ $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "    ✗ $m" -ForegroundColor Red }
function Warn2($m){ Write-Host "    ! $m" -ForegroundColor Yellow }
function Info($m) { Write-Host "      $m" -ForegroundColor DarkGray }
function Step($m) { Write-Host "    → $m" -ForegroundColor White }

# ============================================================
#  工具函数
# ============================================================

function Get-IsAdmin {
    try {
        $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $p = New-Object System.Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Invoke-Python($py, [string[]]$PyArgs) {
    if ($py.Args -and $py.Args.Count -gt 0) {
        & $py.Cmd @($py.Args) @PyArgs
    } else {
        & $py.Cmd @PyArgs
    }
}

function Find-Python {
    # 返回 @{ Cmd = "python"; Version = "3.12.1"; Major = 3; Minor = 12 }
    $candidates = @()
    foreach ($cmd in @("python", "python3", "py")) {
        try {
            if ($cmd -eq "py") {
                $ver = (& py -3 --version 2>&1).ToString().Trim()
            } else {
                $ver = (& $cmd --version 2>&1).ToString().Trim()
            }
            if ($ver -match '^Python\s+(\d+)\.(\d+)\.(\d+)') {
                $candidates += [PSCustomObject]@{
                    Cmd     = $cmd
                    Args    = if ($cmd -eq "py") { @("-3") } else { @() }
                    Version = "$($matches[1]).$($matches[2]).$($matches[3])"
                    Major   = [int]$matches[1]
                    Minor   = [int]$matches[2]
                    Patch   = [int]$matches[3]
                }
            }
        } catch { }
    }
    # 选版本最高的
    if ($candidates.Count -eq 0) { return $null }
    return ($candidates | Sort-Object -Property @{Expression={$_.Major};Descending=$true}, @{Expression={$_.Minor};Descending=$true} | Select-Object -First 1)
}

function Test-PythonOk($py) {
    return ($py -and $py.Major -eq 3 -and $py.Minor -ge 10)
}

function Install-Python {
    Write-Host ""
    Warn2 "准备安装 Python 3.12"

    $isAdmin = Get-IsAdmin
    if (-not $isAdmin) {
        Warn2 "当前不是管理员权限，静默安装可能失败"
        Info "建议：右键 安装环境.bat → 以管理员身份运行"
        Write-Host ""
        $ans = Read-Host "  仍要继续尝试吗？(y/N)"
        if ($ans -ne "y" -and $ans -ne "Y") {
            Info "已跳过 Python 安装"
            return $false
        }
    }

    # 方案 A：winget（Win10 1809+ / Win11 有，Server 2019 一般没有）
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Step "用 winget 安装 Python 3.12"
        & winget install --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements 2>&1 | ForEach-Object { Info $_ }
        if ($LASTEXITCODE -eq 0) {
            Ok "winget 安装完成"
            Info "注意：需要重开一个终端窗口，PATH 才会生效"
            return $true
        }
        Warn2 "winget 安装失败，改用官方安装包"
    } else {
        Info "没有 winget（Windows Server 2019 通常没有），用官方安装包"
    }

    # 方案 B：下载官方安装包（多源重试，国内镜像优先）
    $tmp = Join-Path $env:TEMP "python-3.12.8-amd64.exe"
    $sources = @(
        @{ Name = "华为云镜像"; Url = "https://mirrors.huaweicloud.com/python/3.12.8/python-3.12.8-amd64.exe" },
        @{ Name = "npmmirror";  Url = "https://registry.npmmirror.com/-/binary/python/3.12.8/python-3.12.8-amd64.exe" },
        @{ Name = "官方源";     Url = "https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe" }
    )

    Step "下载 Python 3.12.8（约 25 MB）"
    $ProgressPreference = 'SilentlyContinue'
    $downloaded = $false

    foreach ($src in $sources) {
        if ($downloaded) { break }
        Info "尝试 $($src.Name)：$($src.Url)"
        try {
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            Invoke-WebRequest -Uri $src.Url -OutFile $tmp -UseBasicParsing -TimeoutSec 180
            $sw.Stop()
            if ((Test-Path $tmp) -and ((Get-Item $tmp).Length -gt 10MB)) {
                Ok "下载完成（$($src.Name)，$([math]::Round($sw.Elapsed.TotalSeconds)) 秒）"
                $downloaded = $true
            } else {
                Warn2 "文件不完整，换下一个源"
            }
        } catch {
            Warn2 "$($src.Name) 失败：$($_.Exception.Message.Split([char]10)[0])"
        }
    }

    if (-not $downloaded) {
        Bad "三个源都下载失败"
        Info "手动下载安装（任一链接）："
        foreach ($src in $sources) { Info "  $($src.Url)" }
        Info "  安装时务必勾选 Add python.exe to PATH"
        return $false
    }

    Step "静默安装（需要几分钟）"
    try {
        $args = @("/quiet", "InstallAllUsers=1", "PrependPath=1", "Include_test=0", "Include_pip=1")
        $proc = Start-Process -FilePath $tmp -ArgumentList $args -Wait -PassThru
        if ($proc.ExitCode -eq 0) {
            Ok "安装完成"
            Info "重要：需要重开一个 PowerShell 窗口，PATH 才会生效"
            return $true
        } else {
            Bad "安装返回码 $($proc.ExitCode)"
            Info "可能是权限问题，试试右键「以管理员身份运行」"
            return $false
        }
    } catch {
        Bad "安装失败：$($_.Exception.Message)"
        return $false
    }
}

function Get-CudaVersionFromNvidiaSmi {
    try {
        $out = & nvidia-smi 2>&1 | Out-String
        if ($out -match 'CUDA Version:\s*(\d+)\.(\d+)') {
            return "$($matches[1]).$($matches[2])"
        }
    } catch { }
    return ""
}

function Install-PyTorch($py) {
    Write-Host ""

    # 选 CUDA 版本
    $cuda = $CudaVersion
    if (-not $cuda) {
        $detected = Get-CudaVersionFromNvidiaSmi
        if ($detected) {
            Info "nvidia-smi 显示 CUDA $detected"
            $major = [int]($detected.Split('.')[0])
            $minor = [int]($detected.Split('.')[1])
            $verNum = $major * 10 + $minor

            if ($verNum -ge 126) { $cuda = "cu126" }
            elseif ($verNum -ge 124) { $cuda = "cu124" }
            elseif ($verNum -ge 121) { $cuda = "cu121" }
            elseif ($verNum -ge 118) { $cuda = "cu118" }
            else {
                Warn2 "CUDA $detected 太旧（需要 11.8+）"
                Info "建议更新显卡驱动，或者换 Ubuntu 环境"
                $cuda = "cu118"
            }
        } else {
            Warn2 "检测不到 CUDA（nvidia-smi 没输出）"
            Info "可能没装显卡驱动。先装驱动，或者换 Ubuntu"
            Write-Host ""
            $ans = Read-Host "  仍要安装 PyTorch 吗？会装 CUDA 12.1 版（(y/N)）"
            if ($ans -ne "y" -and $ans -ne "Y") {
                Info "已跳过 PyTorch 安装"
                return $false
            }
            $cuda = "cu121"
        }
    }

    Ok "将安装 PyTorch（$cuda）"

    $indexUrl = "https://download.pytorch.org/whl/$cuda"
    Step "pip install torch torchvision torchaudio --index-url $indexUrl"
    Info "这个包约 2.5 GB，看网速可能要 5-20 分钟"

    # 先换国内源加速非 torch 的依赖
    Step "配置 pip 源（清华，加速小依赖）"
    Invoke-Python $py @("-m","pip","config","set","global.index-url","https://pypi.tuna.tsinghua.edu.cn/simple") 2>&1 | Out-Null
    Invoke-Python $py @("-m","pip","config","set","global.trusted-host","pypi.tuna.tsinghua.edu.cn") 2>&1 | Out-Null

    Step "开始安装"
    if ($py.Cmd -eq "py -3") {
        Invoke-Python $py @("-m","pip","install","torch","torchvision","torchaudio","--index-url",$indexUrl,"--timeout","300","--retries","5")
    } else {
        Invoke-Python $py @("-m","pip","install","torch","torchvision","torchaudio","--index-url",$indexUrl,"--timeout","300","--retries","5")
    }

    if ($LASTEXITCODE -ne 0) {
        Bad "安装失败（返回码 $LASTEXITCODE）"
        Info "常见原因："
        Info "  · 网络问题 —— 挂代理，或重试"
        Info "  · 磁盘空间不足 —— 需要约 6 GB"
        Info "  · Python 版本不兼容 —— 需要 3.10+"
        return $false
    }

    Ok "安装完成"
    return $true
}

# ============================================================
#  主流程
# ============================================================

Hr
Write-Host "  阿米娅训练包 · 环境安装" -ForegroundColor Cyan
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray
if ($script:LogFile) { Write-Host "  日志: $script:LogFile" -ForegroundColor DarkGray }
Hr

# 系统信息
Section "系统"
$os = Get-CimInstance Win32_OperatingSystem
Write-Host "    $($os.Caption) $($os.Version)"
if ($os.Caption -match "Server") {
    Warn2 "Windows Server 环境 —— 消费级显卡（GeForce）驱动可能有问题"
    Info "先跑 nvidia-smi 确认驱动，再装 PyTorch"
}
$isAdmin = Get-IsAdmin
if ($isAdmin) { Ok "管理员权限" } else { Warn2 "非管理员权限（安装 Python 会受限）" }

# ---------- Python ----------
if (-not $TorchOnly) {
    Section "Python"
    $py = Find-Python

    if ($py) {
        Write-Host "    当前版本：$($py.Version)  （命令：$($py.Cmd)）"

        if (Test-PythonOk($py) -and -not $Force) {
            Ok "版本满足要求（需要 3.10+），跳过安装"
        } else {
            if (-not (Test-PythonOk($py))) { Bad "版本太旧（需要 3.10+）" }
            if ($Force) { Warn2 "-Force 指定，强制重装" }

            Write-Host ""
            Write-Host "  要安装 Python 3.12 吗？" -ForegroundColor Yellow
            Info "会下载官方安装包并静默安装，不影响现有 Python（可多版本共存）"
            $ans = Read-Host "  确认 (y/N)"
            if ($ans -eq "y" -or $ans -eq "Y") {
                $done = Install-Python
                if ($done) {
                    Info "重开终端后运行： py -3 --version"
                }
            } else {
                Info "跳过 Python 安装"
            }
        }
    } else {
        Bad "没找到 Python"
        Info "去 https://www.python.org/downloads/ 下载，安装时勾选 Add to PATH"
        Write-Host ""
        $ans = Read-Host "  要自动安装吗？(y/N)"
        if ($ans -eq "y" -or $ans -eq "Y") {
            Install-Python
        }
    }
}

# ---------- PyTorch ----------
if (-not $PythonOnly) {
    Section "PyTorch"

    # 重新查找（可能刚装完）
    $py = Find-Python
    if (-not $py) {
        Bad "没有可用的 Python，无法安装 PyTorch"
        Info "先解决 Python 再回来"
    } else {
        Write-Host "    使用 Python $($py.Version)（$($py.Cmd)）"

        $hasTorch = $false
        $torchVer = ""
        $cudaOk = $false
        try {
            $torchVer = (Invoke-Python $py @("-c", 'import torch; print(torch.__version__)') 2>&1).ToString().Trim()
            $hasTorch = ($LASTEXITCODE -eq 0 -and $torchVer -match '^\d')
        } catch { }

        if ($hasTorch) {
            Write-Host "    当前 PyTorch：$torchVer"
            $cudaOk = ((Invoke-Python $py @("-c", 'import torch; print(torch.cuda.is_available())') 2>&1).ToString().Trim() -eq "True")
            if ($cudaOk) {
                $cudaVer = (Invoke-Python $py @("-c", 'import torch; print(torch.version.cuda)') 2>&1).ToString().Trim()
                $gpuName = (Invoke-Python $py @("-c", 'import torch; print(torch.cuda.get_device_name(0))') 2>&1).ToString().Trim()
                Ok "CUDA 可用（$cudaVer）"
                Write-Host "    显卡：$gpuName"
            } else {
                Bad "CUDA 不可用（装的是 CPU 版）"
            }
        } else {
            Warn2 "没装 PyTorch"
        }

        if ($cudaOk -and -not $Force) {
            Ok "已是最优状态，跳过安装"
        } else {
            Write-Host ""
            if ($hasTorch -and -not $cudaOk) {
                Write-Host "  当前是 CPU 版，要重装成 CUDA 版吗？" -ForegroundColor Yellow
                Info "CPU 版训练会慢 100 倍，必须换"
            } else {
                Write-Host "  要安装 PyTorch（CUDA 版）吗？" -ForegroundColor Yellow
                Info "约 2.5 GB，看网速 5-20 分钟"
            }
            $ans = Read-Host "  确认 (y/N)"
            if ($ans -eq "y" -or $ans -eq "Y") {
                if ($hasTorch -and -not $cudaOk) {
                    Step "先卸载 CPU 版"
                    Invoke-Python $py @("-m","pip","uninstall","-y","torch","torchvision","torchaudio") 2>&1 | Out-Null
                }
                Install-PyTorch $py
            } else {
                Info "跳过 PyTorch 安装"
                Info "手动安装命令："
                Info "  $($py.Cmd) -m pip install torch --index-url https://download.pytorch.org/whl/cu121"
            }
        }
    }
}

# ---------- 验证 ----------
Section "验证"
$py = Find-Python
if ($py) {
    Write-Host "    Python: $($py.Version)"
    try {
        $tv = (Invoke-Python $py @("-c", 'import torch; print(torch.__version__)') 2>&1).ToString().Trim()
        if ($tv -match '^\d') {
            Write-Host "    PyTorch: $tv"
            $cuda = (Invoke-Python $py @("-c", 'import torch; print(torch.cuda.is_available())') 2>&1).ToString().Trim()
            if ($cuda -eq "True") {
                $gpu = (Invoke-Python $py @("-c", 'import torch; print(torch.cuda.get_device_name(0))') 2>&1).ToString().Trim()
                $vram = (Invoke-Python $py @("-c", 'import torch; print(round(torch.cuda.get_device_properties(0).total_memory/1024**3,1))') 2>&1).ToString().Trim()
                Ok "CUDA 可用"
                Write-Host "    显卡: $gpu  ($vram GB)"
                if ([double]$vram -lt 6) {
                    Warn2 "显存 $vram GB，训练 4B 模型需要 6 GB 以上"
                    Info "这台机器适合推理，不适合训练"
                    Info "训练建议用容器云 RTX 4090，1.88 元/时"
                }
            } else {
                Bad "CUDA 仍不可用"
                Info "如果刚装完，重开一个终端窗口再试"
            }
        } else {
            Bad "PyTorch 导入失败"
        }
    } catch {
        Bad "验证出错：$($_.Exception.Message)"
    }
} else {
    Bad "没有可用的 Python"
}

# ---------- 收尾 ----------
Hr
Write-Host ""
Write-Host "  下一步：" -ForegroundColor Cyan
Write-Host "      .\本地自检.ps1 -Log 自检报告.txt    # 确认环境"
Write-Host "      双击 开始训练.bat                    # 或者云端训练"
Write-Host ""

if ($script:LogFile) {
    $lp = $script:LogFile
    Stop-Log
    Write-Host "  日志已保存：$lp" -ForegroundColor Green
} else {
    Stop-Log
}

Write-Host ""
