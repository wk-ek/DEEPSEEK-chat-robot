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
