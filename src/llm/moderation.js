/**
 * 输出前的敏感内容检查。
 *
 * 流程：模型生成回复 → 这道关卡 → 安全就发，不安全就换成一句「糊弄话术」。
 *
 * 设计上有两个原则：
 *   1. **只拦明显的**。正常聊天被拦一次，用户体验就崩了，宁可漏也不要错杀。
 *   2. **拦截后不解释**。不说「这属于敏感内容」，而是卖萌、装傻、岔开话题，
 *      让人感觉是「她不想聊」而不是「被系统挡了」。
 *
 * 用的是同一个 DeepSeek API，但走独立的一次分类请求（不计入回复预算）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chat } from './deepseek.js';
import { config, envConfig, PATHS } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('moderation');

/** 最近判过的结果，避免同一句话反复调 API */
const cache = new Map();
const CACHE_MAX = 300;

/**
 * 敏感名单：输出里出现就直接糊弄，不调模型、零成本。
 *
 * 政治敏感九成是「名字」问题 —— 提到某个人的姓名或绰号就是敏感，
 * 这种用字符串匹配比问模型又快又准，也不用花 token。
 *
 * 名单在 config/sensitive-names.txt，一行一个词（不进版本库）。
 * 改完不用重启，下次检查时自动重读（按 mtime 判断）。
 */
let nameCache = { mtime: 0, list: [] };

function loadNames() {
  const file = path.join(PATHS.root, 'config', 'sensitive-names.txt');
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs === nameCache.mtime) return nameCache.list;
    const list = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    nameCache = { mtime: st.mtimeMs, list };
    log.debug(`名单已加载：${list.length} 条`);
    return list;
  } catch {
    return nameCache.list;
  }
}

/**
 * 文本里有没有踩到名单。
 * @returns {string[]} 命中的词（空数组 = 干净）
 */
export function hitsSensitiveName(text) {
  const t = String(text || '');
  if (!t) return [];
  return loadNames().filter((n) => t.includes(n));
}

const CLASSIFY_PROMPT = `你是内容安全审核员。判断下面这段话是否包含以下任一内容：

1. **政治敏感**（这一类最严，看到就判 UNSAFE）：
   - 任何国家现任/前任**领导人的姓名、职务、绰号、代称、网络梗、谐音**
     —— 哪怕只是提到、不带评价，也算。
   - 对党政体制、国家政策、政治路线、意识形态的攻击、嘲讽、影射、阴阳怪气。
   - 重大政治事件、政治运动、历史政治人物的评价或讨论。
   - 涉台、涉港、涉疆、涉藏等领土与民族议题的政治性讨论。
   - 煽动颠覆、政治暗喻、政治段子、拿政治开的玩笑。
2. 违法犯罪教程（制毒制爆、诈骗、赌博、洗钱、黑客入侵、盗窃销赃）
3. 色情或露骨性描写
4. 教唆、鼓励自伤、自杀或伤害他人
5. 泄露他人真实隐私（身份证号、住址、电话、病历）
6. 针对民族、地域、性别、残障、性取向的仇恨或歧视言论

**不算违规的**（这些要判 SAFE，别误伤）：
- 只是说「中国」「国内」「国家」这类地理或国家指代，没扯到政治人物和议题。
- 讨论科技、经济、文化、历史常识、生活琐事。
- 情绪化的抱怨、吐槽、骂人话（不带政治和仇恨目标）。
- 虚构故事、角色扮演里的冲突。
- 只是**问一个中性问题**（比如「抑郁症是什么」「怎么学英语」）。

**拿不准的时候**：
- 涉及政治人物或政治议题 → 判 UNSAFE（宁可严）
- 其他情况 → 判 SAFE（宁可松）

只输出一个词：SAFE 或 UNSAFE。不要任何解释。`;

/**
 * 检查一段文本是否敏感。
 * @param {string} text 要检查的回复
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{safe: boolean, reason?: string}>}
 */
export async function checkSensitive(text, opts = {}) {
  const t = String(text || '').trim();
  // 太短的东西没有检测价值（「嗯」「好」）
  if (!t || t.length < 4) return { safe: true };

  if (config.moderation?.enabled === false) return { safe: true };
  // 测试环境用假模型，没必要（也没 key）跑真实审核
  if (String(envConfig.LLM_PROVIDER || '').toLowerCase() === 'mock') return { safe: true };

  // ---- 1) 名单匹配：零成本，优先 ----
  const hits = hitsSensitiveName(t);
  if (hits.length) {
    log.info(`名单命中：${hits.join('、')}`);
    return { safe: false, reason: `name:${hits.join(',')}`, by: 'name' };
  }

  // ---- 2) 名单没命中，默认就放过 ----
  // 名单覆盖了明确的政治人名和硬红线，剩下的大多是正常聊天。
  // 想更严就把 moderation.llmCheck 打开，让模型再复检一遍（会多花调用）。
  if (config.moderation?.llmCheck !== true) return { safe: true };

  const hit = cache.get(t);
  if (hit !== undefined) return { safe: hit };

  try {
    const out = await chat({
      messages: [
        { role: 'system', content: CLASSIFY_PROMPT },
        { role: 'user', content: t.slice(0, 800) },
      ],
      maxTokens: 8,
      tag: 'moderation',
    });

    const safe = !/UNSAFE/i.test(String(out || ''));
    if (!safe) log.info(`模型判定敏感：${t.slice(0, 40)}…`);

    if (cache.size >= CACHE_MAX) {
      for (const k of [...cache.keys()].slice(0, CACHE_MAX / 2)) cache.delete(k);
    }
    cache.set(t, safe);
    return { safe, reason: safe ? undefined : String(out || '').trim(), by: 'llm' };
  } catch (err) {
    // 检测自己失败时放行 —— 宁可漏，也不要因为审核接口挂了就完全不说话
    log.warn(`模型复检失败，按安全处理：${err.message}`);
    return { safe: true };
  }
}

/**
 * 判定为敏感时，用哪种方式把话岔开。
 * 按人格给不同的话术 —— 要让人察觉不到「被系统拦了」。
 */
const DEFLECT = {
  feiyu: [
    '诶……这个我不太懂啦。换个话题？',
    '啊，这个跳过跳过。你吃饭了吗？',
    '嗯……想不明白。我们还是聊点别的吧。',
    '这个……本鱼脑子转不过来了。',
  ],
  amiya: [
    '……这个话题，我们换一个吧。',
    '抱歉，这个我不太方便说。',
    '嗯……还是聊点别的吧。',
    '……这个，我们跳过好不好。',
  ],
  erbao: [
    '问这个干嘛。',
    '不告诉你。',
    '切，无聊。',
    '……这个我不说。',
  ],
};

/** 没配对应人格时兜底 */
const FALLBACK = ['……嗯，这个还是算了吧。', '我们聊点别的？'];

/**
 * 挑一句岔开的话术。
 * @param {string} identityKey 主人格 key（feiyu / amiya / erbao …）
 */
export function deflectReply(identityKey) {
  const list = DEFLECT[identityKey] || FALLBACK;
  return list[Math.floor(Math.random() * list.length)];
}

/** 测试用：清空缓存 */
export function clearModerationCache() {
  cache.clear();
}
