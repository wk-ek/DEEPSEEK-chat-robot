/**
 * 意图识别：分辨「该真干事」和「该糊弄」。
 *
 * 为什么需要：干员的语气本来就短，prompt 里又写了「1~3 句」，结果就是
 * 你说「给我讲个故事」，她回「好呀……想听什么？」——应和但不动手。
 *
 * 但也不能什么都干：她是个 11 岁的干员，不是编程助手。你让她写 Python
 * 脚本，她应该岔开，而不是真给你写。
 *
 * 所以分成四类：
 *   story / poem  要真执行（放宽长度，走云端）
 *   refuse        要糊弄（明显不属于她的事）
 *   chat          正常聊天（现有逻辑）
 *
 * 只用正则，不调模型：这个判断要快（几十 ms）、要确定（同样的话每次同结果），
 * 让模型自己判断会引入不确定性还多花一次调用。
 */

/** 讲故事、说寓言、讲笑话 —— 这类要真的讲出来 */
const STORY_RE = new RegExp(
  [
    '(讲|说|编|来|写|念)\\s*(一|个|段|篇|则)?\\s*(故事|寓言|童话|睡前故事)',
    '睡前故事',
    '哄我睡',
    '(讲|说)\\s*(一|个|个吧)?\\s*笑话',
    '给我讲个',
    '讲点什么',
  ].join('|'),
  'i'
);

/** 写诗、作词、对对联 */
const POEM_RE = new RegExp(
  [
    '(写|作|来|吟)\\s*(一|两)?\\s*(首|句|阙)?\\s*(诗|词|对联|绝句|歌词)',
    '赋诗',
    '(写|编|来|唱)\\s*(一|首|段|两句)?\\s*歌词',
  ].join('|'),
  'i'
);

/** 明显超出人格的请求：写代码、翻译、做题、查资料 */
const REFUSE_RE = new RegExp(
  [
    // 编程
    '写\\s*(一\\s*)?(个|段|下)?\\s*(代码|程序|脚本|函数|算法|正则)',
    '(python|java|javascript|typescript|c\\+\\+|c#|golang|rust|php|ruby|sql|html|css)\\s*(代码|脚本|程序|写法)?',
    '编程',
    '帮我改\\s*(代码|bug)',
    '调试',
    // 翻译
    '(帮我)?\\s*翻译',
    '译成',
    '中译英|英译中',
    // 作业/数学
    '(帮我)?\\s*(做|写|解)\\s*(作业|数学|方程|题目)',
    '解方程',
    '求导|微积分',
    '算一下.{0,6}(等于|多少)',
    // 查资料
    '(帮我)?\\s*(查一下|搜一下|搜一下|百度一下|google一下)',
    '帮我?查(找|询)',
    '(写|生成)\\s*(一\\s*)?(份|个)?\\s*(简历|报告|方案|策划|PPT|表格|文档)',
  ].join('|'),
  'i'
);

/**
 * 判断这一轮该干什么。
 *
 * @param {string} text 用户说的话
 * @returns {{type: 'story'|'poem'|'refuse'|'chat', matched?: string, allowLong?: boolean}}
 */
export function detectIntent(text) {
  const t = String(text || '').trim();
  if (!t) return { type: 'chat' };

  // 拒绝类优先：句子里既提到代码又说「讲故事」的极罕见，
  // 但「给我讲个 python 代码」应该算拒绝而不是故事。
  const refuse = t.match(REFUSE_RE);
  if (refuse) {
    return { type: 'refuse', matched: refuse[0], allowLong: false };
  }

  const story = t.match(STORY_RE);
  if (story) {
    return { type: 'story', matched: story[0], allowLong: true };
  }

  const poem = t.match(POEM_RE);
  if (poem) {
    return { type: 'poem', matched: poem[0], allowLong: true };
  }

  return { type: 'chat' };
}

/** 这类任务要不要强制走云端（本地模型写不出像样的故事） */
export function needsCloud(intent) {
  return intent.type === 'story' || intent.type === 'poem';
}

/** 这类任务要不要提高输出上限 */
export function wantsLongReply(intent) {
  return intent.allowLong === true;
}
