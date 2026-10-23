# 阿米娅人格模型 · 训练套件

**打包上传 → 跑一个脚本 → 拿到两个模型（纯官方 / 官方+同人）。**

```bash
node train/pack.mjs              # 生成 dist/amiya-train-<日期>.zip
# 上传解压到 /workspace
cd amiya-train && bash train/run.sh --auto
```

---

## 一、这是什么

把「人格」从 prompt 里搬进模型权重。分两层训：

| 阶段 | 学什么 | 数据 | 为什么分开 |
| --- | --- | --- | --- |
| **Stage 1 智慧层** | 泰拉是什么样的世界 | 422 个干员档案 + 109 个剧情章节提炼 | 不知道自己活在什么世界里的角色，回答什么都是空的 |
| **Stage 2 说话层** | 像阿米娅那样说话 | 3426 条真实剧情对话 + 日常生成 | 短句、43% 带省略号、被夸先愣一下 |
| **Stage 3 同人层**（可选） | 加一点同人的味道 | 同人文本或 API 生成的深度自省 | 在官方版基础上微调，训歪了直接丢 |

**混在一起训会出问题**：模型会把世界观当成台词的一部分，说每句话都像在念设定集。
分开训，Stage 2 从 Stage 1 的 adapter 接着来，知识不丢、语气更纯。

**两个独立产物，互不干扰：**

| 产物 | 说明 | 建议 |
| --- | --- | --- |
| `amiya-official` | 纯官方数据训的 | **主用这个** |
| `amiya-extra` | 官方版 + 同人层再微调 | 想让她更"有味道"时试 |

同人的语气是「作者理解的阿米娅」，不是阿米娅。所以单独一层，
训歪了丢掉这一层就行，官方版还在。

---

## 二、花多少钱

| 项目 | 规格 | 耗时 | 估算 |
| --- | --- | --- | --- |
| 世界观提取（一次性，本地） | DeepSeek API × 109 次 | 20 分钟 | **1–2 元** |
| 日常对话生成（一次性，本地） | DeepSeek API × 75 次 | 10 分钟 | **3–6 元** |
| **Stage 1 训练** | RTX 4090 24G | 20–30 分钟 | **1–2 元** |
| **Stage 2 训练** | 同上 | 20–30 分钟 | **1–2 元** |
| 合并导出 | 同上 | 10 分钟 | 含上面 |
| **总计** | **约 1.5 小时 GPU** | | **6–12 元** |

> 你说的 100 元够跑 8 遍；1000 元能训 8B 甚至 14B。
> **真正烧钱的是忘记关机**——挂一晚上 20–30 元。脚本跑完立刻关实例。
>
> ⚠️ 并行智算云的价格页我这边访问不到（域名解析到非公网 IP），以上按国内行情估算，
> **具体单价请在你控制台确认**。

---

## 三、怎么用（三步）

### 第 1 步：本地准备数据（不花钱，跑一次就行）

```bash
cd F:/qq-deepseek-robot

# 1) 干员档案 → 角色知识（正则提取，不调 API，免费）
node train/prepare-wisdom.mjs

# 2) 剧情章节 → 世界观问答（调 API，约 1-2 元，109 个文件）
node train/prepare-lore.mjs

# 3) 剧情对话 → 她的语气（免费）
node train/prepare-data.mjs

# 4) 补日常闲聊（调 API，约 3-6 元，建议 1500 条）
node train/augment-dialogue.mjs --count 1500

# 5) 合并成两套训练集
node train/build-dataset.mjs
```

产出（`train/out/`）：

```
wisdom.jsonl        约 1250 条   Stage 1 用
wisdom_val.jsonl    约 25 条
persona.jsonl       约 4900 条   Stage 2 用
persona_val.jsonl   约 100 条
```

### 第 2 步：上传到云端

把 `train/` 整个目录 + 数据传上去。云端目录长这样：

```
/workspace/
├── data/
│   ├── wisdom.jsonl
│   ├── wisdom_val.jsonl
│   ├── persona.jsonl
│   ├── persona_val.jsonl
│   └── dataset_info.json
└── train/                    ← 本目录
    ├── run.sh
    ├── stage1-wisdom.yaml
    ├── stage2-persona.yaml
    └── ...
```

> `train/out/` 里的 jsonl 要**改名去掉目录层级**放进 `/workspace/data/`：
> `wisdom.jsonl`、`persona.jsonl` 保持原名即可，`dataset_info.json` 也在里面。

### 第 3 步：跑

```bash
cd /workspace/train
bash run.sh
```

脚本会自动：

1. 检查 GPU 和数据
2. 装 LLaMA-Factory（首次 3–5 分钟）
3. **Stage 1** 训智慧层 → `output/stage1-wisdom`
4. **Stage 2** 从 Stage 1 接着训说话层 → `output/stage2-persona`
5. 合并导出完整模型 → `output/amiya-merged`
6. 打印产物路径并提醒你关机

**常用参数：**

```bash
bash run.sh --dry            # 只检查环境，不训练（先跑这个确认没问题）
bash run.sh --stage1-only    # 只训智慧层
bash run.sh --skip-export    # 训完不合并
```

---

## 四、数据从哪来

| 来源 | 条数 | 怎么来的 |
| --- | --- | --- |
| 干员档案 | 1266 | 444 个 txt，正则提取【代号】【种族】【出身地】等 + 履历段落 |
| 世界观提炼 | 约 870 | 109 个剧情章节（主线/支线/故事集/特殊）喂给 DeepSeek 提炼设定 |
| 剧情对话 | 3426 | 从 553 个剧情文件里提取「别人说 → 阿米娅答」的真实对话对 |
| 日常生成 | 约 1500 | 用 DeepSeek 按人格生成（剧情里没有「今天好累」这种） |

**关于「不只阿米娅相关」**：Stage 1 特意用了**全部**剧情章节和**全部**干员档案。
她不是在真空里长大的——泰拉的历史、国家、种族、那场战争、感染者怎么被对待，
这些构成了她的世界。知道这些，她回答问题时才不像个只有人设的空壳。

---

## 五、训练配置的关键取舍

| 选择 | 为什么 |
| --- | --- |
| **Qwen3-4B** 而非 7B | 训完 Q4 只占 2.5 GB，**你 4GB 显存的本机能跑** |
| QLoRA 4bit | 4090 24G 够用，便宜 |
| Stage 1 **r=32** | 智慧层要装「知识」，rank 大一点 |
| Stage 2 **r=16** | 说话层是「浅层风格」，rank 大容易过拟合到具体句子 |
| Stage 2 **lr=6e-5**（比 Stage 1 低） | 微调语气，别把刚学的知识冲掉 |
| Stage 1 **cutoff 1536** | 百科式答案较长 |
| Stage 2 **cutoff 1024** | 对话都很短（回答均长 20 字） |

---

## 六、训完怎么用

### Ollama

```bash
# 1) 导出 GGUF 后（run.sh 会自动做，或手动）
# 2) 写 Modelfile：
cat > Modelfile <<'EOF'
FROM /workspace/output/amiya-4b-Q4_K_M.gguf
PARAMETER temperature 0.85
PARAMETER top_p 0.9
PARAMETER repeat_penalty 1.1
SYSTEM """你是阿米娅，11岁，卡特斯，罗德岛的公开领袖。叫对方「博士」，用「您」。"""
EOF

ollama create amiya -f Modelfile
ollama run amiya "今天好累啊"
```

### 接进机器人

现在用的是 OpenAI 兼容接口，改成指向本地只差几个配置：

```ini
LLM_PROVIDER=local
DEEPSEEK_BASE_URL=http://127.0.0.1:11434/v1
DEEPSEEK_API_KEY=ollama
DEEPSEEK_MODEL=amiya
```

> ⚠️ 代码里还有 4 处会挡路（强制要 key、超时 90 秒太短、JSON 模式 Ollama 不认、模型名映射）。
> **这部分还没改**，要用的时候说一声。

### 混合模式（推荐）

4B 本地模型跑**日常闲聊**（快、免费、隐私），DeepSeek API 跑**需要世界知识的事**
（查天气、查资料）。两边共用同一套人格设定。

---

## 七、数据质量标准

好的样本：

```
用户：还有，阿米娅，记得任何时候，你都可以依赖身边的人。
阿米娅：凯尔希医生，您有时间的话，我们一起吃午饭吧！

用户：我睡啦 晚安
阿米娅：晚安……好好休息，别熬夜。
```

**已经过滤掉的坑**（这些会毒化训练）：

| 问题 | 例子 | 处理 |
| --- | --- | --- |
| 旁白混进台词 | 「阿米娅闻声回头，目光温柔……」 | 含「阿米娅」或叙述动词的整条丢 |
| 半句话 | 「……医生，我觉得……」 | 去标点后不足 4 字丢掉 |
| 承上启下碎片 | 「它为什么一直抓着博士的兜帽呀！」 | 缺前情，丢掉 |
| 表情标记 | `[[sticker:amiya_shy]]` | 丢掉（部署后由代码控制） |

---

## 八、文件清单

| 文件 | 作用 |
| --- | --- |
| `run.sh` | **一键训练**（云端跑这个） |
| `stage1-wisdom.yaml` | Stage 1 超参（智慧层） |
| `stage2-persona.yaml` | Stage 2 超参（说话层） |
| `dataset_info.json` | LLaMA-Factory 数据注册表 |
| `prepare-wisdom.mjs` | 干员档案 → 角色知识（免费） |
| `prepare-lore.mjs` | 剧情章节 → 世界观问答（约 1-2 元） |
| `prepare-data.mjs` | 剧情文本 → 对话对（免费） |
| `augment-dialogue.mjs` | 生成日常闲聊（约 3-6 元） |
| `build-dataset.mjs` | 合并成两套训练集 |

---

## 九、关于二创素材

**没有纳入**，原因：

- 二创作品著作权归原作者。自己用、不发布，法律风险很低，但仍有。
- 更关键的是**质量**：同人作品的语气是「作者理解的阿米娅」，不是阿米娅。
  拿它训练会把别人的理解混进来，反而稀释人格。
- 现在 3426 条真实剧情对话是**官方原文的语气**，纯度更高。

如果你还是想加，建议：

1. 只用**文字类**（同人小说、安科），不碰画作
2. 放 `train/data/extra/` 下，用 `build-dataset.mjs` 时手动合并
3. 比例控制在 10% 以内——多了会盖掉原始语气

---

## 十、常见问题

**训完模型说话很生硬？**
→ Stage 2 数据不够或 epoch 太多。先看 loss 曲线（`output/stage2-persona/training_loss.png`），
如果 loss 降到 0.5 以下基本是过拟合了，减 epoch 或加数据。

**问它泰拉的事答不上来？**
→ Stage 1 数据不够。把 `prepare-lore.mjs` 跑全量 109 个文件，别只跑 --limit 2。

**模型只会说「博士」？**
→ 训练数据里称呼占比太高。`augment-dialogue.mjs` 的 prompt 里已经写了
「不要每句都带博士称呼」，但生成的数据还是可能偏。可以抽样检查一下。

**显存不够？**
→ 把 yaml 里的 `per_device_train_batch_size` 降到 2，
`gradient_accumulation_steps` 提到 8（等效 batch 不变）。
