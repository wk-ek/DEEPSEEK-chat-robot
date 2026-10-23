# 部署运行指南（并行智算云 · Windows 实例）

> 全部命令在 **PowerShell** 里执行，可直接复制。

---

## 零、概览

```
① 上传训练包        约 1 分钟
② 解压             30 秒
③ 预检（-Dry）      30 秒
④ 正式训练          约 1 小时
```

花费：**约 2 元**（1.88 元/卡/时 × 1 小时，存储和网络免费）

---

## 一、上传训练包

### 包的位置（你本地电脑上）

```
F:\qq-deepseek-robot\dist\amiya-train-20261023.zip     约 16 MB
```

### 传到云端 Windows

**方式 A：平台自带的文件传输**

控制台 → 容器实例卡片 → 鼠标移到右下角【⋯】→【文件传输】→ 把 zip 拖进 `C:\Users\Administrator\` 或 `C:\train\`

**方式 B：远程桌面拖拽**

用 mstsc 连上 Windows 实例，直接复制粘贴文件。

**方式 C：scp（如果你本地有 ssh）**

```powershell
scp "F:\qq-deepseek-robot\dist\amiya-train-20261023.zip" Administrator@IP:C:/Users/Administrator/
```

---

## 二、解压

在云端 Windows 的 PowerShell 里：

```powershell
cd C:\Users\Administrator
Expand-Archive -Path amiya-train-20261023.zip -DestinationPath .
cd amiya-train
```

或者右键 zip → 全部解压。

确认结构：

```powershell
dir
# 应该看到：config  data  package.json  README-上传说明.md  src  story  train
```

---

## 二之二、装环境（Python + PyTorch）

如果预检时提示 Python 太旧或 PyTorch 是 CPU 版，用这个脚本自动处理。

### 双击运行

```
安装环境.bat
```

### 它会做两件事

| 步骤 | 判断逻辑 |
| --- | --- |
| **Python** | 版本 ≥ 3.10 → 跳过；否则下载 3.12 官方安装包静默安装 |
| **PyTorch** | 已装 CUDA 版 → 跳过；CPU 版或无 → 装 CUDA 版 |

**每一步都先检测、先问你要不要做**，不会擅自改系统。

### 参数

```powershell
.\安装环境.ps1                  # 交互式，两道确认
.\安装环境.ps1 -PythonOnly      # 只处理 Python
.\安装环境.ps1 -TorchOnly       # 只处理 PyTorch
.\安装环境.ps1 -Force           # 已装好也强制重装
.\安装环境.ps1 -CudaVersion cu118   # 指定 CUDA 版本
.\安装环境.ps1 -Log 安装日志.txt
```

### CUDA 版本怎么选

脚本会根据 `nvidia-smi` 显示的 CUDA 版本自动选：

| 你的 CUDA | 装的 PyTorch |
| --- | --- |
| 12.6+ | cu126 |
| 12.4+ | cu124 |
| 12.1+ | **cu121**（最通用） |
| 11.8+ | cu118 |
| 更旧 | 会警告，建议换环境 |

### 装 Python 的两种方式

1. **winget**（Win10 1809+ / Win11 自带）
   ```powershell
   winget install Python.Python.3.12
   ```
2. **官方安装包**（Server 2019 一般没有 winget）
   自动下载 `python-3.12.8-amd64.exe`，静默安装到全用户

> ⚠️ 装完 Python 后**必须重开一个 PowerShell 窗口**，PATH 才会生效。

### 注意事项

- **建议以管理员身份运行**（安装 Python 需要写系统目录）
- PyTorch CUDA 版约 **2.5 GB**，装 5–20 分钟
- 脚本会先配清华源加速小依赖，torch 本体还是从官方源下

---
## 三、预检（30 秒，必做）

### 先解除执行策略限制（只需一次）

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

> 如果提示权限不够，用管理员身份打开 PowerShell。

### 跑预检

```powershell
.\train\run.ps1 -Dry
```

正常输出：

```
  === 阿米娅人格模型（Windows）===

  > 检查环境
    Python 3.10
    GPU: NVIDIA GeForce RTX 4090  24.0 GB
    CUDA: 12.1
  OK 环境正常
  --------------------------------------------------
  > 检查数据
    wisdom.jsonl  2045 条
    persona.jsonl  4824 条
    extra.jsonl  59 条
  OK 数据检查通过
  -Dry：环境与数据检查完成，不安装依赖、不训练
```

**看到 `OK 数据检查通过` 就可以正式开训。**

`-Dry` 只做检查，不会装任何东西。

---

## 三之二、日志与报告

所有脚本都支持 `-Log` 参数，把输出同时写进 txt 文件。

### 双击 .bat（最简单，自动带日志）

| 文件 | 作用 | 日志文件 |
| --- | --- | --- |
| `本地自检.bat` | 检查环境 | `自检报告-<时间戳>.txt` |
| `开始训练.bat` | 开始训练 | `训练日志-<时间戳>.txt` |

双击就行，日志自动生成在同一个目录。

### 手动指定日志路径

```powershell
# 自检
.\本地自检.ps1 -Log "C:\report\自检.txt"

# 训练
.\train\run.ps1 -Log "C:\report\train.txt"
```

### 日志里有什么

txt 文件包含**完整控制台输出**，包括：

- 环境检查的每一项结果
- 数据量的统计
- 每个训练阶段的进度和耗时
- 报错信息和排查建议
- 最后的产物路径和花费

**出问题时把这个 txt 发出来就能定位。**

> 日志开头有十几行 PowerShell transcript 元信息（版本、机器名、启动命令），
> 从 `***` 分隔线之后才是正文。

---
## 三之三、离线依赖（本包已内置）

包里带了 **82 个 wheel（144 MB）**，LLaMA-Factory 的所有依赖都在里面，**安装时完全不需要联网**。

```
amiya-train\train\vendor\
├── LLaMA-Factory\    源码（2 MB）
└── wheels\           82 个依赖包（144 MB）
```

`run.ps1` 会自动走离线安装：

```
> 安装 LLaMA-Factory
OK 使用包内自带的源码：train\vendor\LLaMA-Factory
OK 使用包内离线依赖：82 个 wheel，144 MB
> 完全不需要联网，从本地 wheel 安装
```

### 没打包的三个大包及其原因

| 包 | 大小 | 为什么跳过 |
| --- | --- | --- |
| **torch / torchvision / torchaudio** | 124 MB | 云端已装 2.7.1+cu118。PyPI 上的是 CPU 版，装错会覆盖掉 CUDA 版 |
| **gradio** | 60 MB | 只用于 WebUI。查过源码，`train` 和 `export` 分支不走 webui |
| **av** | 32 MB | 视频处理，源码里没有任何 `import av` |

另外 `modelscope` / `uvicorn` / `fastapi` / `sse-starlette` 也没打（国内模型源和 API 服务，训练用不到），省了 6 MB。

### 唯一还需要联网的地方

**下载 Qwen3-4B 模型（8 GB）。**

从 HuggingFace 下，国内可能慢。如果卡住，可以设置镜像：

```powershell
$env:HF_ENDPOINT = "https://hf-mirror.com"
```

然后重新跑 `开始训练.bat`。

### 如果离线安装报错

看报错里的包名，基本只有两种可能：

| 报错 | 原因 |
| --- | --- |
| `No matching distribution found for xxx` | 该包没打进 wheels，发日志给我补 |
| `Could not find a version that satisfies the requirement torch` | 云端的 torch 没装好，跑 `本地自检.bat` 看 PyTorch 那一节 |

---
## 四、正式训练

```powershell
.\train\run.ps1
```

它会自动：

1. 装 LLaMA-Factory（首次 5–10 分钟）
2. 检测 bitsandbytes（能不能用 QLoRA）
3. **Stage 1** 智慧层 2045 条 —— 20–30 分钟
4. **Stage 2** 说话层 4824 条 —— 20–30 分钟
5. **Stage 3** 同人层 59 条 —— 约 5 分钟
6. 合并导出两个模型（约 10 分钟）

### 参数

```powershell
.\train\run.ps1 -Dry               # 只检查
.\train\run.ps1 -OfficialOnly      # 跳过同人层
.\train\run.ps1 -SkipExport        # 训完不合并
```

---

## 五、产出

```
C:\Users\Administrator\amiya-train\output\
├── amiya-official-merged\     纯官方版 ← 推荐主用
├── amiya-extra-merged\        官方 + 同人版
├── stage1-wisdom\             智慧层 LoRA
├── stage2-persona\            说话层 LoRA
└── stage3-extra\              同人层 LoRA
```

### ⚠️ 训完先下载模型，再关机

**关机时如果没勾「保存环境」，数据会丢。**

把 `output\amiya-official-merged` 整个目录复制回你本地：

- 用平台的文件传输工具
- 或用远程桌面拖拽
- 或者 `scp -r Administrator@IP:C:/Users/Administrator/amiya-train/output/amiya-official-merged "F:\models\"`

**下载完再关机。**

---

## 五之二、Windows Server 2019 特别说明

如果你云端实例是 **Windows Server 2019**（不是 Windows 10/11），注意这几点。

### 能跑吗

**能，但 GPU 驱动是最大风险。**

| 项目 | 情况 |
| --- | --- |
| PowerShell | Server 2019 自带 5.1，`run.ps1` 就是按 5.1 写的，兼容 |
| 执行策略 | 默认更严，`本地自检.bat` 和 `run.ps1` 都已带 `-ExecutionPolicy Bypass` |
| **GPU 驱动** | ⚠️ **可能装不上**（见下） |
| VC++ 运行库 | 可能缺，装依赖时报错再补 |

### GPU 驱动是最大的坑

NVIDIA **官方不提供 GeForce 驱动给 Windows Server**。所以：

| 你的卡 | 情况 |
| --- | --- |
| Tesla / Quadro / A 系列 | 官方有 Server 驱动，正常 |
| **RTX 4090 / 3090（消费卡）** | 官方不支持，看云平台有没有预装改版驱动 |

**先跑这个判断：**

```powershell
nvidia-smi
```

| 输出 | 含义 | 怎么办 |
| --- | --- | --- |
| 显卡信息 + CUDA Version | ✅ 驱动 OK | 直接往下走，能训练 |
| `不是内部或外部命令` | ❌ 没驱动 | 找云平台客服要驱动，或者干脆换 Ubuntu |
| 报错 | ❌ 驱动有问题 | 同上 |

### 如果 nvidia-smi 用不了

**别折腾了，换 Ubuntu 容器。**

同样的价钱（1.88 元/时），差别是：

| | Windows Server 2019 | Ubuntu 22.04 |
| --- | --- | --- |
| GPU 驱动 | 消费卡可能装不上 | 平台预装，开箱能用 |
| bitsandbytes | 经常要降级 | 原生支持 |
| 训练命令 | `.\train\run.ps1` | `bash train/run.sh` |
| 长任务保护 | 远程桌面断开会中断 | tmux 成熟 |

### Windows Server 上怎么跑

如果驱动没问题，流程和普通 Windows 一样：

```powershell
# 解压后进目录
cd C:\Users\Administrator\amiya-train

# 自检（会特意提示 Server 的注意事项）
.\train\本地自检.ps1

# 预检
.\train\run.ps1 -Dry

# 训练
.\train\run.ps1
```

自检脚本会识别出 Server 系统，在 CUDA 不可用时给出「先查驱动，再怀疑 torch」的提示。

### Server 上另外两个小题

**1. 可能缺 VC++ 运行库**

装依赖时报 `Microsoft Visual C++ 14.0 or greater is required`：

```
下载安装：https://aka.ms/vs/17/release/vc_redist.x64.exe
```

**2. 远程桌面断开会让训练中断**

Server 版没有 tmux 这类工具。三个办法：

- 训练期间别关远程桌面窗口
- 用 `Start-Process` 配合计划任务（麻烦）
- **或者干脆换 Ubuntu**（`tmux new -s train` 一行搞定）

---
## 六、Windows 特有的坑

### 1. `无法加载文件...未对文件进行数字签名`

执行策略限制。每次开新窗口都要设一次：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

或者永久放开（不推荐在个人电脑上做）：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### 2. bitsandbytes 装不上

**这是 Windows 上最常见的问题。** 它的 4bit 量化的官方支持主要在 Linux。

**脚本已经自动处理了**：检测到装不上就降级用 **fp16 LoRA**（`-win` 版 yaml），代价是多占约 6 GB 显存。

4090 24G 跑 4B 模型，QLoRA 和 fp16 LoRA 都够，只是后者慢一点点。

如果还是想装 QLoRA，可以试第三方 wheel：

```powershell
pip install https://github.com/jllllll/bitsandbytes-windows-webui/releases/download/wheels/bitsandbytes-0.41.1-py3-none-win_amd64.whl
```

装上了脚本就会自动用 QLoRA。

### 3. `pip install` 很慢

```powershell
python -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
```

### 4. `CUDA 不可用`

先确认：

```powershell
nvidia-smi                                          # 有输出吗
python -c "import torch; print(torch.version.cuda)" # 有版本号吗
```

如果 `nvidia-smi` 正常但 torch 说没 CUDA，是装成了 CPU 版：

```powershell
python -m pip install --force-reinstall torch --index-url https://download.pytorch.org/whl/cu121
```

### 5. 中文乱码

脚本里已经设了 `[Console]::OutputEncoding = UTF8`。如果还是乱：

```powershell
chcp 65001
```

### 6. 显存不足（OOM）

改 `train\*-win.yaml`：

```yaml
per_device_train_batch_size: 2       # 4 → 2
gradient_accumulation_steps: 8       # 4 → 8
```

---

## 七、花费

| 项目 | 单价 | 用量 | 费用 |
| --- | --- | --- | --- |
| RTX 4090 | **1.88 元/卡/时** | 约 1 小时 | **1.88 元** |
| 系统盘 30 GB | 免费 | — | 0 |
| 共享存储 50 GB | 免费 | — | 0 |
| 网络 | 不单独计费 | — | 0 |
| **合计** | | | **约 2 元** |

`run.ps1` 跑完会自动算实际花费。

**100 元够跑 50 次。**

---

## 八、一句话版本

```powershell
# ① 上传 amiya-train-20261023.zip 到云端 Windows
# ② 解压 + 进目录
cd C:\Users\Administrator
Expand-Archive -Path amiya-train-20261023.zip -DestinationPath .
cd amiya-train

# ③ 解除执行策略
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

# ④ 预检 + 训练
.\train\run.ps1 -Dry
.\train\run.ps1
```

---

## 九、为什么不建议在 Windows 上训练（但还是支持了）

| 对比项 | Linux（推荐） | Windows |
| --- | --- | --- |
| bitsandbytes QLoRA | 原生支持 | 经常装不上，要降级 |
| 编译依赖 | 一般不需要 | 可能要 VS Build Tools |
| 脚本 | `run.sh` 直接跑 | 要 `run.ps1` + 执行策略 |
| 长任务保护 | tmux 很成熟 | 远程桌面断开会中断训练 |

**如果这个 Windows 实例只是你随手选的**，建议换成 Ubuntu 容器——同样的 1.88 元/时，`bash train/run.sh` 一条命令搞定，不用踩上面这些坑。

**如果你只能用 Windows**，那上面的脚本已经把所有坑都填了，照着跑就行。

> ⚠️ 远程桌面断开会让训练中断。要么别断开窗口，要么用 `Start-Process -NoNewWindow` 配合计划任务。或者直接在控制台开着窗口不动。
