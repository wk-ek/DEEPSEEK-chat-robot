# 训练数据准备进度

> 暂停于 2026-10-23（用户电脑没电）

## 已完成

| 脚本 | 状态 | 产出 |
| --- | --- | --- |
| `prepare-wisdom.mjs` | ✅ 完成 | 422 个角色 → 1266 条 |
| `prepare-data.mjs` | ✅ 完成 | 3426 条剧情对话 |
| `prepare-lore.mjs` | ⏸ 中断 | 约 557 条（跑了约 70/109 个文件） |
| `augment-dialogue.mjs` | ⏸ 中断 | 约 459 条（目标 1500） |

## 下次继续

```bash
cd F:\qq-deepseek-robot

# 1) 断点续传，跳过已处理的文件
node train/prepare-lore.mjs

# 2) 日常对话要从头跑（这个脚本是覆盖写）
node train/augment-dialogue.mjs --count 1500

# 3) 合并成两套训练集
node train/build-dataset.mjs

# 4) 打包（带上剧情素材和训练数据）
node train/pack.mjs --with-story --with-data
```

## 说明

- `prepare-lore.mjs` 已改成**断点续传**：重跑会读已有的 jsonl，跳过处理过的文件
- `augment-dialogue.mjs` 还是**覆盖写**：重跑会清空重来（要改成续传的话说一声）
- 两个中断的脚本都花了几毛钱，数据都在

## 目标数据量

| 数据集 | 当前 | 目标 |
| --- | --- | --- |
| wisdom_lore | 557 | 约 870 |
| augmented | 459 | 1500 |
| wisdom_operators | 1266 | 已完成 |
| raw_pairs | 3426 | 已完成 |

## 打包后的目标结构

```
amiya-train.zip
├── train/          run.sh + 脚本 + 3 个 yaml
├── src/            依赖
├── config/         人格档案
├── story/          剧情素材 37 MB（--with-story）
└── data/           训练数据（--with-data）
```

解压后 `bash train/run.sh` 即可开训，不需要 API key。
