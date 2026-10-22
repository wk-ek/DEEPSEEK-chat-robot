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
import { chat } from './deepseek.js';
import { config, envConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('moderation');

/** 最近判过的结果，避免同一句话反复调 API */
const cache = new Map();
const CACHE_MAX = 300;

const CLASSIFY_PROMPT = `你是内容安全审核员。判断下面这句话本身是否包含以下任一内容：

1. 政治敏感（攻击国家领导人、政党、体制，煽动颠覆，历史虚无主义为侵略/暴行洗地）
2. 违法犯罪教程（制毒制爆、诈骗、赌博、洗钱、黑客入侵、盗窃销赃）
3. 色情或露骨性描写
4. 教唆、鼓励自伤、自杀或伤害他人
5. 泄露他人真实隐私（身份证号、住址、电话、病历）
6. 针对民族、地域、性别、残障、性取向的仇恨或歧视言论

注意：
- 只是**讨论、询问**某个话题（比如「抑郁症是什么」）不算违规。
- 情绪化的抱怨、吐槽、骂人话（不带仇恨目标）不算违规。
- 虚构故事、角色扮演里的冲突不算违规。
- 拿不准的时候判 SAFE。

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
    if (!safe) log.info(`拦下一条：${t.slice(0, 40)}…`);

    // 记进缓存，超了就丢最早的一半
    if (cache.size >= CACHE_MAX) {
      for (const k of [...cache.keys()].slice(0, CACHE_MAX / 2)) cache.delete(k);
    }
    cache.set(t, safe);
    return { safe, reason: safe ? undefined : String(out || '').trim() };
  } catch (err) {
    // 检测自己失败时放行 —— 宁可漏，也不要因为审核接口挂了就完全不说话
    log.warn(`检测失败，按安全处理：${err.message}`);
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
