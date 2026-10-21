# 大肥鱼 · QQ DeepSeek 机器人

一个跑在你自己电脑上的 QQ 机器人。用 DeepSeek 驱动，有固定人设、长期记忆，还会随着聊天慢慢对你产生好感和情绪变化。

**零第三方依赖**：只用 Node.js 内置能力（`fetch` / `WebSocket` / `node:sqlite`），不需要 `npm install`，不会被依赖版本拖住。

---

## 她现在能做什么

- **私聊**：有人找她就回。
- **群聊**：只有被 `@` 或者叫到她名字时才说话，其余时间安静旁听（防止刷屏）。
- **长期记忆**：聊够一定轮数后，会自动把对话提炼成「她记得的事」，下次能想起来。
- **情绪与好感度**：每聊几轮做一次「内省」，好感度 0~100 会变化，人设的行为提示也跟着变——越熟，她越会主动关心、开玩笑。
- **主动发言**（默认关闭）：在指定群里安静一阵后，偶尔自己说一句。

---

## 跑起来（3 步）

### 1. 填 API Key

打开 `.env`，把这一行填上：

```ini
DEEPSEEK_API_KEY=sk-你的key
```

Key 在 <https://platform.deepseek.com/api_keys> 申请，充几块钱就够聊很久（`deepseek-chat` 很便宜）。

### 2. 自检

```bat
npm run doctor
```

它会逐项检查 Node 版本、key、人设文件、API 连通性、NapCat 端口，并直接告诉你还差什么。

### 3. 启动

```bat
npm start
```

或者双击 `start.bat`。

> 想先看效果、不想配 QQ？用假模型跑一遍完整链路，不花钱：
> ```bat
> npm run e2e
> ```
> 它会自动起一个模拟 QQ 服务端，验证「私聊回复 / 群聊@回复 / 群里没@时保持安静」这三件事。

---

## 装 NapCat（关键的一步）

### 0. 先确认版本匹配 ⚠️

NapCat 靠注入 QQ 客户端工作，**QQ 版本必须和 NapCat 版本对应**，否则会白屏或注入失败。

- 看你装的 QQ 版本：`设置 → 关于`，或看 `C:\Program Files\Tencent\QQNT\QQ.exe` 的属性
- 看 NapCat 要求的版本：解压目录里的 `qqnt.json`，里面 `"version": "9.9.22-40990"` 就表示需要 QQ 9.9.22
- 对照官方发布页说明：<https://napneko.github.io/guide/boot/Shell>

**对不上就二选一**：

| 方案 | 做法 | 适合 |
| --- | --- | --- |
| **A. OneKey 安装器**（推荐） | 下载 `NapCat.Shell.Windows.OneKey.zip`，运行里面的 `NapCatInstaller.exe`，它会自己装一份匹配版本的 QQ + NapCat，**完全不动你现有的 QQ** | 不想升级/降级现有 QQ |
| B. 升级现有 QQ | 把 QQ 升到 NapCat 要求的版本，再用 Shell 版 `launcher.bat` | 愿意动现有 QQ |

### 1. 下载

可以让我直接帮你下：

```bat
npm run fetch-napcat
```

它会查最新版本、下载 `NapCat.Shell.zip` 到项目旁边的 `NapCat/` 目录。

或者手动去 <https://github.com/NapNeko/NapCatQQ/releases> 下载 **`NapCat.Shell.zip`**。

> 另有两个变体：
> - `NapCat.Shell.Windows.Node.zip` —— 自带 Node 运行时，你机器上已经有 Node 就不需要
> - `NapCat.Shell.Windows.OneKey.zip` —— 一键安装器（上面方案 A）

### 2. 解压并登录

1. 解压到一个**不含中文和空格**的目录，比如 `D:\NapCat`。
2. 双击 `launcher.bat`（部分版本叫 `napcat.bat`）。
3. 窗口里会出现登录二维码（也可能存成图片文件）。**用你要当机器人的 QQ 号扫码登录**。
4. 首次登录可能要求手机确认或设备验证，按提示走。

> 第一次登录后，QQ 的登录态会缓存在 NapCat 目录里，以后再启动通常不用重新扫码。

### 3. 开启 WebSocket 服务器

NapCat 登录后，浏览器打开 WebUI（默认 <http://127.0.0.1:6099>），进入 **网络配置**，点「添加」→ **WebSocket 服务器**：

| 配置项 | 填什么 |
| --- | --- |
| 名称 | 随便，比如 `local` |
| 主机 | `127.0.0.1` |
| 端口 | `3001` |
| 消息格式 | **`array`**（一定要选 array，不是 string / CQ 码） |
| Token | 留空即可 |
| 启用 | ✅ |

保存后启用它。

> 不同版本的界面措辞会变，但核心就是「开一个 WebSocket 服务器 / 正向 WS，端口 3001，消息格式 array」。
> 如果你更习惯改文件：NapCat 的配置在 `config/onebot11_<你的QQ号>.json`，把 `websocketServers` 里对应项设成 `"enable": true, "port": 3001, "messagePostFormat": "array"`。

### 4. 回到机器人

```bat
npm start
```

看到 `已连接到 NapCat / OneBot 服务` 和 `登录账号：xxx` 就成功了。现在用另一个号给这个号发条私聊试试。

---

## 她会记住你什么

三层，从快到慢：

| 层 | 存什么 | 存在哪 |
| --- | --- | --- |
| 短期上下文 | 最近 24 条对话 | `data/bot.db` 的 `messages` 表 |
| 长期记忆 | 每 40 条对话压缩出的「事实」 | `memories` 表 |
| 关系状态 | 每个用户的好感度、情绪、最近印象 | `users` 表 |

想看当前的记录：

```bat
npm run status
```

会打印出她记得的人、好感度条、最近提炼出的记忆。

> 想让她忘掉某个人：删 `data/bot.db` 里对应行，或者直接删掉整个 `data/bot.db`（全部重置）。

---

## 她有几副面孔

人格分两层。**主人格**决定她是谁，**子人格**决定她此刻怎么说话。

| 层 | 有哪些 | 作用范围 |
| --- | --- | --- |
| 主人格 | 大肥鱼、阿米娅 | **全局**——头像和 QQ 昵称是账号级的，只能一起变 |
| 子人格 | 正常、串子、傲娇、毒舌 | **按会话**——A 群切了不影响 B 群 |

### 聊天里就能切子人格（要 @ 她或叫名字）

```
@大肥鱼 当串子 / 整活          → 贱兮兮
@大肥鱼 当傲娇 / 傲娇一点      → 嘴硬心软
@大肥鱼 攻击模式 / 上强度      → 毒舌
@大肥鱼 不串了 / 不傲娇了      → 退出那个
@大肥鱼 正常点 / 变回来        → 不管在哪个，都回正常
```

### 换主人格：说话或者命令都行

**直接说话**（要 @ 她或叫名字）：

```
@大肥鱼 变成阿米娅      → 她就变成阿米娅了
@大肥鱼 变回大肥鱼      → 再变回来
```

能听懂的动词：变成 / 变回 / 切换成 / 切换到 / 换成 / 换回 / 成为 / 当。
「别变成阿米娅」「阿米娅是谁」这种不会误触发。

**用命令**：

```
/persona              → 看现在是谁、能切什么
/persona 阿米娅        → 换人（会一并换头像和群名片）
/persona 傲娇          → 换表现
/persona 默认          → 回正常
```

> ⚠️ **换主人格是真的「换人」**：头像会变，所有群的名片也会跟着变。
> 不想要这些副作用，可以在 `config.json` → `persona.apply` 里关掉 `avatar` / `groupCard`。
>
> 阿米娅目前是「人格一：罗德岛的阿米娅」，表情包暂时关着——现有 8 张图都是大肥鱼的形象，发出来会串味。

---

## 调教她：改人设

**`config/persona.md`** 是她的大脑，**`config/persona.<子人格>.md`** 是她此刻的演法。改完**不用重启**，最多 1 秒生效。

写人设的诀窍是**少写形容词，多写「她会做什么 / 不会做什么」**。对比：

- ❌ `她是一个温柔、善良、可爱的女孩，喜欢帮助别人。` —— 模型只能据此输出客服腔。
- ✅ `别人讲难过的事时，她先问一句「那后来呢」，不急着给建议。` —— 这才有具体的动作。

改完效果不满意，通常是这几个方向调：

| 症状 | 怎么改 |
| --- | --- |
| 太像客服 | 在 persona 的「她不会做什么」里明确禁止「有什么可以帮你」 |
| 话太多 | 减少 `reply.maxReplyChars`，并在 persona 写「三段话说不完就别说」 |
| 太冷淡 | 提高 `emotion.initialFavor`，或在 persona 里加「对熟一点的人会主动多说一句」 |
| 复读 | 调高 `.env` 里的 `DEEPSEEK_TEMPERATURE`（0.8~1.1） |
| 记不住事 | 降低 `memory.summarizeEveryMessages`，或手动往 `memories` 表插 |

### 改完怎么验证

不用真去群里试，直接本地聊一句，只调一次模型：

```bat
node scripts/try-persona.mjs 阿米娅 "博士，今天好累啊"
node scripts/try-persona.mjs 大肥鱼:傲娇 "你有想我吗"
node scripts/try-persona.mjs 阿米娅 "第一句" "第二句"        :: 多轮
node scripts/try-persona.mjs 阿米娅 "你好" --dump            :: 连 system prompt 一起看
```

不碰数据库、不发消息、只调模型。调人格文字时比在群里试快得多。

---

## 配置项

分两个文件：

- `.env` —— 密钥和连接信息（不进版本库）
- `config/config.json` —— 行为配置（首次启动自动从 `config.example.json` 生成）

常用的几个：

```jsonc
{
  "botName": "大肥鱼",            // 她叫什么，也用于匹配群里的呼叫
  "reply": {
    "groupNeedMention": true,      // 群里必须 @ 或叫名字才回
    "botAliases": ["大肥鱼", "肥鱼"], // 群里叫这些名字也算叫她
    "maxReplyChars": 260,          // 回复长度上限
    "debounceMs": 900,             // 连续消息合并窗口（避免一句句回）
    "maxContextMessages": 24       // 短期上下文条数
  },
  "emotion": {
    "enabled": true,
    "initialFavor": 30,            // 初始好感度
    "updateEveryTurns": 2          // 每几轮做一次情绪/好感度更新（越小越贵）
  },
  "proactive": {
    "enabled": false,              // 主动发言总开关
    "groups": [],                  // 允许主动说话的群号
    "cooldownMinutes": 45,         // 两次主动发言间隔
    "maxPerDay": 3,                // 每天最多几次
    "probability": 0.15            // 满足条件时说话的概率
  },
  "rateLimit": {
    "perUserPerMinute": 6,         // 每人每分钟最多回复次数
    "globalPerMinute": 30          // 全局每分钟上限
  }
}
```

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm start` | 正常启动 |
| `npm run doctor` | 自检：缺什么、连不上什么，直接告诉你 |
| `npm run status` | 看她现在记得谁、好感度多少 |
| `npm run e2e` | 端到端测试（假模型，不需要 QQ 和 key） |
| `npm test` | 单元测试 |
| `npm run mock` | 启动模拟 QQ 服务端，手动输入消息调试 |

`npm run mock` 的交互方式：

```
> 你好                    ← 直接输入 = 私聊
> /g 大家好               ← 群聊（不@她，她应该不理）
> /m 大肥鱼在吗           ← 群聊 @她
> /q                      ← 退出
```

---

## 常见问题

**连不上：`ECONNREFUSED 127.0.0.1:3001`**
NapCat 没登录、或者没开 WebSocket 服务器、或者端口填的不是 3001。用 `npm run doctor` 会直接指出来。

**`401` / `Authentication Fails`**
`.env` 里的 key 错了或没填。注意别把 key 前后空格复制进去。

**群里 @ 了她却不回**
1. 确认 NapCat 的消息格式是 `array`，不是 CQ 码；
2. 确认 `config.guard.groupWhitelist` 是空数组（空 = 所有群）；
3. 看启动日志里有没有 `收到消息 type=group`（有就是决策问题，没有就是链路问题）。

**她说话很机械、像 AI**
九成是 `persona.md` 写得太抽象。照着文件里的示例，把「她会做什么」写成具体动作。

**回复很慢**
`debounceMs`（默认 900ms）会故意等她说完再回；另外 `replyDelayMs` 会模拟打字。想快就调小。

**控制台中文乱码**
Windows 终端编码问题，不影响功能。用 `start.bat` 启动（里面有 `chcp 65001`）就正常了。

**怎么让它开机自启**
用「任务计划程序」新建任务，触发器选「登录时」，操作指向 `start.bat`，起始位置填项目目录。

---

## ⚠️ 风险提示（请一定看）

1. **这是非官方协议接入。** NapCat 走的是 QQ 客户端协议，**有被风控、被冻结的风险**。请**用小号**，不要用你的主号。
2. **不要用它主动私聊陌生人**，也不要群发。这类行为最容易触发风控。默认配置下她只被动响应。
3. **聊天记录存在本地** `data/bot.db`，是明文 SQLite。如果电脑是共用的，注意这一点。
4. **她的话是模型生成的**，可能说错、可能冒犯人。不要让她代你对外做承诺、发表立场。
5. 频率限制（`rateLimit`）默认已经比较保守，**不建议调高**。

---

## 文件结构

```
qq-deepseek-robot/
├── .env                      # 你的密钥（不进版本库）
├── config/
│   ├── config.json           # 行为配置（自动生成）
│   ├── config.example.json   # 默认值参考
│   ├── persona.md            # ★ 主人格：大肥鱼
│   ├── persona.chuanzi.md    # ★ 子人格：串子
│   ├── persona.tsundere.md   # ★ 子人格：傲娇
│   ├── persona.aggressive.md # ★ 子人格：毒舌
│   ├── persona.amiya.md      # ★ 主人格：阿米娅
│   └── amiya.lore.md         # ★ 阿米娅记得的剧情（世界观/主线/支线）
├── assets/
│   ├── avatar.png            # 大肥鱼头像
│   ├── avatar_amiya.png      # 阿米娅头像
│   └── stickers/             # 表情包
├── src/
│   ├── index.js              # 入口
│   ├── config.js             # 配置加载
│   ├── logger.js             # 日志
│   ├── onebot/
│   │   ├── client.js         # OneBot v11 WebSocket 客户端（含重连）
│   │   ├── api.js            # 发消息、换头像、改群名片
│   │   └── parse.js          # 消息段解析
│   ├── llm/
│   │   ├── deepseek.js       # 模型调用（重试/超时/mock）
│   │   └── prompt.js         # 提示词组装（主人格 + 子人格两层）
│   ├── memory/
│   │   ├── db.js             # SQLite 与表结构
│   │   ├── store.js          # 读写与记忆召回
│   │   ├── context.js        # 上下文装配
│   │   └── summarize.js      # 对话摘要 → 长期记忆
│   ├── persona/
│   │   ├── state.js          # 情绪/好感度状态机
│   │   ├── identities.js     # 两层人格与 /persona 命令
│   │   └── appearance.js     # 换头像、改群名片
│   └── brain/
│       ├── reply.js          # 主回复逻辑（决策/防抖/限流/清洗）
│       └── proactive.js      # 主动发言调度
├── scripts/
│   ├── doctor.js             # 自检
│   ├── status.js             # 查看她的记忆
│   ├── e2e.js                # 端到端测试
│   └── mock-onebot.js        # 模拟 QQ 服务端
├── test/unit.test.js         # 单元测试
├── data/                     # 数据库（自动生成）
└── start.bat
```

---

## ⚖️ 版权与免责声明（务必阅读）

**这是一个玩家个人开发的非官方项目，与鹰角网络没有任何合作关系。**

> ### 本项目的全部内容均为二次创作，禁止任何形式的商业使用。

- **《明日方舟》及其全部角色、剧情、美术，著作权归上海鹰角网络科技有限公司所有。**
- 「大肥鱼」人格基于 DeepSeek 品牌形象的社区二创，「阿米娅」人格、剧情知识库、头像与表情基于《明日方舟》——**整个项目都属于二次创作（同人作品）**，包括其中的代码、人设、素材与文档。
- ⚠️ **全部内容禁止商业使用** —— 不得出售、不得作为付费服务的一部分、不得植入广告变现、不得承接商业外包。
- 本项目按「现状」提供，**不对任何使用后果负责**（包括账号被封、数据丢失、AI 说错话等）。
- QQ 接入走的是非官方协议（NapCat），**有封号风险，请用小号**。

完整的授权范围、第三方来源、AI 内容风险、隐私提示与侵权处理方式，见 **[DISCLAIMER.md](DISCLAIMER.md)**。

> 一句话总结：**可以玩，可以改，可以分享 —— 但不能卖。接入 QQ 的风险自负。**

---

## 许可

**全项目：仅限非商业使用** ｜ 完整条款：[LICENSE](LICENSE) ｜ 声明：[DISCLAIMER.md](DISCLAIMER.md)
