# 阿米娅人格模型 · 训练套件

把「人格」从 prompt 里搬进模型权重的一套工具。目标是训出一个**说话像阿米娅**的小模型，
训完能跑在你自己机器上（4B 模型 Q4 量化后只要 2.5 GB，4 GB 显存跑得动）。

---

## 先说结论：花多少钱

按国内 GPU 云的市场行情估算（**并行智算云的具体价格请你在控制台确认，我这边访问不到他们的价格页**）：

| 项目 | 规格 | 耗时 | 单价（估） | 小计 |
| --- | --- | --- | --- | --- |
| 数据生成 | DeepSeek API | 约 30 分钟 | — | **3–6 元** |
| **训练**（QLoRA 4B） | RTX 4090 24G | **1–2 小时** | 2–3 元/时 | **2–6 元** |
| 合并 + 导出 | 同上一台机器 | 10 分钟 | — | 含在上面 |
| 试跑验证 | 同上一台机器 | 20 分钟 | — | 含在上面 |
| **合计** | | **约 2–3 小时** | | **5–12 元** |

**你说的 100 元预算，够跑 10 遍还有剩。** 1000 元能训一个 8B 甚至 14B 的。

> 真正容易超预算的不是训练，是**你忘了关机**。一台 4090 挂一晚上就是 20–30 元。
> 用完立刻关机，别让它空转。

如果是训 8B 模型：

| 项目 | 规格 | 耗时 | 小计 |
| --- | --- | --- | --- |
| QLoRA 8B | RTX 4090 24G | 3–4 小时 | 8–12 元 |

---

## 三步走

### 第一步：准备数据（本地跑，不花钱）

```bash
cd F:/qq-deepseek-robot

# 1) 从剧情文本提取真实对话对（需要 F:\ark_story_data）
node train/prepare-data.mjs

# 2) 生成日常对话样本（调 DeepSeek，约 3-6 元）
node train/augment-dialogue.mjs --count 1500

# 3) 合并清洗，输出训练集
node train/build-dataset.mjs
```

产出：

```
train/out/train.jsonl   约 4500 条
train/out/val.jsonl     约 90 条
```

**数据从哪来：**

| 来源 | 条数 | 内容 |
| --- | --- | --- |
| 剧情对话 | 约 3400 | 从 553 个剧情文件里提取的「别人说 → 阿米娅答」真实对话对 |
| 生成的日常 | 约 1500 | 用 DeepSeek 按人格生成的日常闲聊（剧情里没有「今天好累」这种） |

> 剧情对只覆盖了 49 个文件——因为阿米娅只在那 49 个里有台词，其余是别人的故事。

### 第二步：上传云端

在云端容器里（以 LLaMA-Factory 为例）：

```bash
git clone https://github.com/hiyouga/LLaMA-Factory.git
cd LLaMA-Factory && pip install -e ".[torch,metrics]"
```

**数据放法**（LLaMA-Factory 要求 `dataset_info.json` + 数据文件）：

```
/workspace/data/
├── dataset_info.json
├── amiya_train.jsonl
└── amiya_val.jsonl
```

`dataset_info.json` 内容：

```json
{
  "amiya_train": {
    "file_name": "amiya_train.jsonl",
    "formatting": "sharegpt",
    "columns": { "messages": "messages" }
  },
  "amiya_val": {
    "file_name": "amiya_val.jsonl",
    "formatting": "sharegpt",
    "columns": { "messages": "messages" }
  }
}
```

> 我们的 `train.jsonl` 是 `{"messages":[{"role":"user",...},{"role":"assistant",...}]}` 格式，
> 对应 LLaMA-Factory 的 `sharegpt` + `messages` 列。

### 第三步：训练

```bash
# 上传 train/LLaMA-Factory.yaml 到 /workspace/
llamafactory-cli train /workspace/LLaMA-Factory.yaml
```

跑完在 `/workspace/output/amiya-lora/` 拿到 LoRA 权重。

**别忘了关机。**

---

## 训完怎么用

### 方式一：合并成完整模型，本地跑

```bash
llamafactory-cli export \
  --model_name_or_path Qwen/Qwen3-4B-Instruct-2507 \
  --adapter_name_or_path /workspace/output/amiya-lora \
  --template qwen3 \
  --finetuning_type lora \
  --export_dir /workspace/amiya-4b-merged \
  --export_quantization_bit 4 \
  --export_quantization_dataset /tmp/calib.json
```

导出的 GGUF 可以直接丢给 Ollama：

```bash
ollama create amiya -f /path/to/Modelfile
```

### 方式二：接进现有机器人（推荐先这样试）

机器人目前用的是 OpenAI 兼容接口，改成指向本地服务只差几个配置：

```ini
# .env
LLM_PROVIDER=local
DEEPSEEK_BASE_URL=http://127.0.0.1:11434/v1   # Ollama
DEEPSEEK_API_KEY=ollama
DEEPSEEK_MODEL=amiya
```

> ⚠️ 但现在代码里有 4 个地方会挡路（强制要 key、超时太短、JSON 模式、模型名映射），
> 需要先改。**这部分我还没动**，你要用的时候跟我说。

### 混合模式（我建议的用法）

训好的 4B 负责**日常闲聊**（快、免费、隐私），DeepSeek API 负责**需要世界知识的事**
（「今天天气」「帮我查个东西」）。两边的 prompt 可以共用同一套人格。

---

## 数据长什么样

好的样本：

```
用户：还有，阿米娅，记得任何时候，你都可以依赖身边的人。
阿米娅：凯尔希医生，您有时间的话，我们一起吃午饭吧！

用户：我睡啦 晚安
阿米娅：晚安……好好休息，别熬夜。
```

**已经过滤掉的坑**（这些都会毒化训练）：

| 问题 | 例子 | 处理 |
| --- | --- | --- |
| 旁白混进台词 | 「阿米娅闻声回头，目光温柔……」 | 含「阿米娅」或叙述词的整条丢掉 |
| 半句话 | 「……医生，我觉得……」 | 去标点后不足 4 字丢掉 |
| 承上启下的碎片 | 「它为什么一直抓着博士的兜帽呀！」 | 缺前情，丢掉 |
| 表情标记 | `[[sticker:amiya_shy]]` | 丢掉（部署后由代码控制） |

---

## 文件清单

| 文件 | 作用 |
| --- | --- |
| `prepare-data.mjs` | 从剧情文本提取真实对话对 |
| `augment-dialogue.mjs` | 用 DeepSeek 生成日常对话样本 |
| `build-dataset.mjs` | 合并清洗，输出训练集 |
| `LLaMA-Factory.yaml` | 训练超参配置 |

---

## 二创素材

**没做这一项**，原因：

- 二创作品的**著作权归原作者**，拿来做训练数据在法律上是灰色地带（尤其你要发布的模型）
- 官方剧情文本相对安全（同人训练通常被认为属于合理使用范畴，且不复制原作品）
- 现有 3400 条剧情对 + 1500 条生成样本，数据量已经够训 4B

如果你坚持要加二创内容，建议：

1. 只用**文字类**（同人小说、安科），不碰画作
2. 在模型卡里明确声明「训练数据包含同人作品」
3. 不要商用（你的项目本来也禁止商用，这点一致）

需要的话我可以帮你找，但要你自己确认版权风险。
