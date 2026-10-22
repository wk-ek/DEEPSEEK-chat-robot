import { config, PATHS } from '../config.js';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { extractText, isAt, stripAt, mentionsName } from '../onebot/parse.js';
import { assembleContext, scopeOf } from '../memory/context.js';
import { buildMessages, buildIntrospectMessages } from '../llm/prompt.js';
import { chat, parseJsonLoose, estimateTokens } from '../llm/deepseek.js';
import { checkSensitive, deflectReply } from '../llm/moderation.js';
import { searchWeb, formatResults, fetchWeather, extractCity, cleanQuery } from '../search/search.js';
import { checkBudget, addDailyUsed, getDailyUsed } from '../search/budget.js';
import { applyIntrospection, heuristicDelta, getOrCreateUser, resentmentLevel, RESENTMENT, detectApology, applyApology } from '../persona/state.js';
import {
  normalizeIdentities,
  defaultIdentity,
  findIdentity,
  findMode,
  modeOf,
  matchGlobalExit,
  matchSessionMode,
  matchIdentitySwitch,
  parsePersonaCommand,
  parseCommandArg,
  describePersona,
  stickerKeysFor,
} from '../persona/identities.js';
import { applyIdentityAppearance, applyGroupCardOnly } from '../persona/appearance.js';
import { saveMessage, addMemory, touchGroup, recentMessages, kvGet, kvSet } from '../memory/store.js';
import { maybeSummarize } from '../memory/summarize.js';

const log = createLogger('brain');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ONLY_AT_LINES = ['嗯？', '怎么了。', '在。', '你说。', '叫我干嘛。'];

// 让她闭嘴的说法（必须配合 @ 或叫名字才生效，避免误伤正常聊天）
const MUTE_KEYWORDS = [
  '别说话', '闭嘴', '安静', '别吵', '别插嘴', '不要说话', '不许说话',
  '别说了', '消停', '别出声', '嘘', '先别说', '别吭声',
];

const MUTE_ACK = ['……哦。', '……好嘛。', '嗯。那我安静待着。', '……行吧。'];

// 搜不到 / 超预算时的兜底：她不知道，而且很饿
const HUNGRY_LINES = [
  '我不知道……但是我很饿，需要白饭。',
  '这个我查不到。有白饭吗，先给我一碗。',
  '嗯……不知道诶。我好饿，要吃白饭。',
  '想不出来。肚子在叫了，白饭白饭。',
];

/** 这是不是一句需要查实时信息的话。 */
function shouldSearch(text) {
  const t = String(text || '').trim();
  if (t.length < 2 || t.length > 200) return false;
  return (config.search?.keywords || []).some((k) => k && t.includes(k));
}

/**
 * 对方是不是在「要表情包」。
 * 只认带动词的说法（发/来/要/给/整…），单纯夸「这个表情包好可爱」不算。
 */
export function isStickerRequest(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 40) return false;
  // 动词 + 最多两个字 + 表情/图/贴纸（容许「发一个」「整一张」这种）
  if (/(发|来|要|给|整|搞|出|甩|奖)[个张一两个张呢]?.{0,2}(表情|图|贴纸)/.test(t)) return true;
  if (/表情包?\s*(呢|来|给我|看看|一个)/.test(t)) return true;
  return false;
}

/**
 * 被要表情包时她愿不愿意给。
 * 心情好、关系熟的时候更愿意；烦了、低落时就小气一点。
 */
export function stickerWilling(state) {
  const mood = String(state?.mood || 'calm');
  const favor = Number(state?.favor ?? 30);
  let p = 0.55;
  const table = { happy: 0.9, shy: 0.8, miss: 0.75, curious: 0.7, calm: 0.6, sleepy: 0.4, annoyed: 0.2, low: 0.15 };
  if (table[mood] !== undefined) p = table[mood];
  if (favor >= 60) p += 0.15;
  else if (favor < 20) p -= 0.2;
  return Math.random() < Math.min(0.95, Math.max(0.05, p));
}

/**
 * 这一轮要不要处理「对方在要表情包」这件事。
 * 抽出来是为了让 try-persona 那种独立工具也能走同一套判断，测试才准。
 *
 * @returns {{want: boolean, willing: boolean|null, directive: string}}
 */
export function planStickerReply(text, state) {
  if (!isStickerRequest(text)) return { want: false, willing: null, directive: '' };

  const willing = stickerWilling(state);
  const directive = willing
    ? '对方在要表情包。你现在心情不错，愿意给他看一张 —— 在回复末尾带上你最想给的那张，' +
      '不用多解释，也不用说「好吧我发你」这种话，自然地给就行。'
    : '对方在要表情包。你现在**不想发**。\n' +
      '必须用一句话**明确拒绝**（比如「……现在不想发。」「不给。」「我今天不太想发这个。」），' +
      '可以带点小情绪或者找个借口，但要让对方一眼看出你**不打算发**——' +
      '不要含糊、不要反问之后又给。\n' +
      '**这一轮绝对不要带表情标记。**';

  return { want: true, willing, directive };
}

/** 通用关键词匹配：太长的句子不算，避免误伤正常聊天。 */
function matchKeywords(text, keywords, maxLen = 16) {
  const t = String(text || '').trim();
  if (!t || t.length > maxLen) return false;
  return (keywords || []).some((k) => k && t.includes(k));
}

/** 判断是不是一句「别说话」的指令。 */
export function isMuteCommand(text) {
  return matchKeywords(text, MUTE_KEYWORDS, 16);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把模型输出洗成一条能直接发出去的 QQ 消息。 */
export function sanitizeReply(raw, botName = config.botName, maxChars = config.reply.maxReplyChars) {  if (!raw) return '';
  let t = String(raw).replace(/\r/g, '').trim();

  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/^#{1,6}\s*/gm, '');
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/__(.+?)__/g, '$1');

  // 去掉「大肥鱼：」这类前缀
  for (const n of [botName, ...(config.reply.botAliases || []), '她']) {
    if (!n) continue;
    t = t.replace(new RegExp(`^${escapeRegExp(n)}\\s*[:：]\\s*`), '');
  }

  // 去掉开头的动作描写（她他/微笑/叹气……）
  t = t.replace(/^[（(][^）)]{0,30}[）)]\s*/, '');
  // 去掉包裹整个回复的引号
  t = t.replace(/^["“「『]+/, '').replace(/["”」』]+$/, '');

  t = t.replace(/\n{3,}/g, '\n\n').trim();

  if (t.length > maxChars * 2) t = t.slice(0, maxChars * 2).trim() + '…';
  return t;
}

/** 从回复里抠出 [[sticker:xxx]] 标记，返回纯文本 + 表情图片绝对路径。 */
export function extractSticker(text) {
  const cfg = config.stickers || {};
  const list = cfg.list || {};
  const dir = cfg.dir || 'assets/stickers';
  let sticker = null;

  const clean = String(text || '')
    .replace(/\[\[sticker:([a-zA-Z0-9_-]+)\]\]/gi, (_, key) => {
      const file = list[key] || list[key.toLowerCase()];
      if (!sticker && file) sticker = path.join(PATHS.root, dir, file);
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return { text: clean, sticker };
}

/** 简易滑动窗口限流。 */
class RateLimiter {
  constructor({ perUserPerMinute, globalPerMinute }) {
    this.perUser = perUserPerMinute;
    this.global = globalPerMinute;
    this.userHits = new Map();
    this.globalHits = [];
  }

  #prune(list, now) {
    const cutoff = now - 60000;
    while (list.length && list[0] < cutoff) list.shift();
  }

  allow(userId) {
    const now = Date.now();
    this.#prune(this.globalHits, now);
    if (this.globalHits.length >= this.global) return false;

    let list = this.userHits.get(userId);
    if (!list) {
      list = [];
      this.userHits.set(userId, list);
    }
    this.#prune(list, now);
    if (list.length >= this.perUser) return false;

    list.push(now);
    this.globalHits.push(now);
    return true;
  }
}

/** 按会话限流（给上下文判定用，避免群里每条消息都去问一次模型）。 */
class ScopeThrottle {
  constructor(perMinute) {
    this.perMinute = Math.max(1, Number(perMinute) || 8);
    this.hits = new Map();
  }

  allow(key) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < 60000);
    if (list.length >= this.perMinute) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

export class Brain {
  constructor({ api, getSelfId }) {
    this.api = api;
    this.getSelfId = getSelfId;
    this.buffers = new Map();
    this.limiter = new RateLimiter({
      perUserPerMinute: config.rateLimit.perUserPerMinute,
      globalPerMinute: config.rateLimit.globalPerMinute,
    });
    this.contextThrottle = new ScopeThrottle(config.reply.contextCheckPerMinute);
    // 机器人自动发出的消息（id + 内容快照），用于和「主人手动发言」区分
    this.sentIds = new Set();
    this.pendingTexts = [];
    // 换外观（头像/名片）是慢操作，串起来做，避免连点切换时互相覆盖
    this.appearanceQueue = Promise.resolve();
  }

  /** 记录一次自动发送，供 #onSelfMessage 排除。 */
  markSent(text, messageId) {
    if (messageId != null) this.sentIds.add(String(messageId));
    this.pendingTexts.push({ text: String(text || '').trim(), ts: Date.now() });
    if (this.pendingTexts.length > 50) this.pendingTexts.shift();
    if (this.sentIds.size > 500) {
      for (const id of [...this.sentIds].slice(0, 250)) this.sentIds.delete(id);
    }
  }

  /**
   * 处理「机器人这个号自己发出的消息」（post_type = message_sent）。
   * 必须区分两种来源：
   *   1. 机器人调接口自动发的 → 忽略，否则会自己跟自己对话
   *   2. 主人用手机/其他设备手动发的 → 记进上下文，让她知道「这是我说的」
   */
  #onSelfMessage(ev) {
    const selfId = this.getSelfId();
    const id = ev.message_id != null ? String(ev.message_id) : '';
    const text = (extractText(ev.message) || '').trim();

    // 1) 明确是机器人自动发的
    if (id && this.sentIds.has(id)) {
      this.sentIds.delete(id);
      log.debug(`忽略自动发送的消息 ${id}`);
      return;
    }

    // 2) 兜底：接口返回晚于事件时，用「内容 + 时间」认出来
    const now = Date.now();
    const hit = this.pendingTexts.findIndex((p) => p.text === text && now - p.ts < 15000);
    if (hit !== -1) {
      this.pendingTexts.splice(hit, 1);
      log.debug('忽略自动发送的消息（内容匹配）');
      return;
    }

    // 3) 剩下的就是主人手动发言
    if (!config.selfMessage?.enabled) return;
    if (!text) return;

    const isGroup = ev.message_type === 'group';
    const selfUin = String(ev.user_id ?? selfId ?? '');
    const peer = isGroup ? null : String(ev.target_id ?? '');
    if (!isGroup && !peer) {
      log.debug('自己发的私聊消息没有 target_id，跳过');
      return;
    }
    const scope = isGroup ? `group:${ev.group_id}` : `private:${peer}`;

    saveMessage({
      scope,
      scopeType: isGroup ? 'group' : 'private',
      userId: selfUin,
      groupId: isGroup ? String(ev.group_id) : null,
      senderName: config.selfMessage.senderName || '主人',
      role: 'user',
      text,
    });

    log.info(`主人用账号发言（${isGroup ? '群 ' + ev.group_id : '私聊'}）：${text.slice(0, 40)}`);
  }

  /**
   * 群聊里没 @ 也没叫名字时，判断这句是不是在跟她说话。
   * 两个前提：她最近在群里说过话（否则没有「上下文」可言），且没超判定频率。
   */
  async #isTalkingToMe(ctx) {
    const windowMs = Number(config.reply.contextWindowMs) || 300000;
    const since = Date.now() - windowMs;

    const rows = recentMessages(ctx.scope, 12).filter((r) => Number(r.ts) >= since);
    if (!rows.some((r) => r.role === 'assistant')) return false;

    if (!this.contextThrottle.allow(ctx.scope)) {
      log.debug('上下文判定太频繁，跳过');
      return false;
    }

    const convo = rows
      .slice(-6)
      .map((r) => `${r.role === 'assistant' ? config.botName : r.sender_name || '某人'}: ${r.text}`)
      .join('\n');

    try {
      const ans = await chat({
        messages: [
          {
            role: 'system',
            content:
              '你是群聊对话判定器。看最近的群聊记录，判断最后一条消息是不是在跟指定的机器人说话。' +
              '只输出一个词：yes 或 no。不要解释。',
          },
          {
            role: 'user',
            content:
              `机器人的名字叫「${config.botName}」。\n\n最近的群聊：\n${convo}\n\n` +
              `最新消息（${ctx.senderName}）：${ctx.text}\n\n` +
              `问题：这条最新消息是在跟「${config.botName}」说话吗？\n` +
              `判定规则：\n` +
              `- 在回应它刚说的话、直接问它、用「你」指它 → yes\n` +
              `- 在跟群里其他人说话、自言自语、跟它无关 → no\n` +
              `- 拿不准就 no`,
          },
        ],
        temperature: 0,
        maxTokens: 8,
        tag: 'context-check',
      });
      return /^yes/i.test(String(ans).trim());
    } catch (err) {
      log.debug(`上下文判定失败：${err.message}`);
      return false;
    }
  }

  async onEvent(ev) {
    try {
      if (ev.post_type === 'message_sent') {
        this.#onSelfMessage(ev);
        return;
      }
      if (ev.post_type !== 'message') return;
      if (ev.message_type !== 'private' && ev.message_type !== 'group') return;
      await this.#onMessage(ev);
    } catch (err) {
      log.error(`处理事件失败：${err.message}`, err.stack);
    }
  }

  #ignored(ev, isGroup, userId, groupId) {
    const g = config.guard || {};
    if (g.ignoreOtherBots && ev.sender?.is_bot) return true;
    if ((g.blacklistUserIds || []).map(String).includes(String(userId))) return true;
    const wl = (g.groupWhitelist || []).map(String);
    if (isGroup && wl.length && !wl.includes(String(groupId))) return true;
    return false;
  }

  async #onMessage(ev) {
    const selfId = this.getSelfId();
    const isGroup = ev.message_type === 'group';
    const userId = String(ev.user_id);
    const groupId = isGroup ? String(ev.group_id) : null;

    log.debug(`收到消息 type=${ev.message_type} user=${userId} raw=${JSON.stringify(ev.message).slice(0, 200)}`);

    if (selfId && userId === String(selfId)) return;
    if (this.#ignored(ev, isGroup, userId, groupId)) return;

    const senderName = ev.sender?.card || ev.sender?.nickname || `用户${userId}`;
    if (isGroup) {
      touchGroup(groupId, ev.group_name || undefined);
    }

    const atMe = isAt(ev.message, selfId);
    const text = (stripAt(ev.message, selfId) || extractText(ev.message) || '').slice(
      0,
      config.guard?.maxInputChars || 2000
    );
    // 叫名字也要认当前主人格的别名 —— 切成阿米娅以后，「阿米娅在吗」也得算叫她
    const scopeKey = scopeOf({ type: isGroup ? 'group' : 'private', userId, groupId });
    const activeIdentity = this.#personaState(scopeKey).identity;
    const nameAliases = [
      ...new Set([...(config.reply.botAliases || []), ...((activeIdentity && activeIdentity.aliases) || [])]),
    ];
    const nameMention = mentionsName(text, nameAliases);

    const ctx = {
      ev,
      isGroup,
      userId,
      groupId,
      senderName,
      text,
      atMe,
      nameMention,
      scope: scopeKey,
      scopeType: isGroup ? 'group' : 'private',
      groupName: ev.group_name,
    };

    const muteKey = `mute:${ctx.scope}`;
    const muteEnabled = config.mute?.enabled !== false;

    // 1) 「别说话」指令：回一句确认，然后闭嘴
    if (muteEnabled && (atMe || nameMention) && isMuteCommand(text)) {
      if (text) {
        saveMessage({
          scope: ctx.scope,
          scopeType: ctx.scopeType,
          userId,
          groupId,
          senderName,
          role: 'user',
          text,
        });
      }
      kvSet(muteKey, 1);
      log.info(`进入静默：${ctx.scope}（${senderName}: ${text}）`);
      const ack = MUTE_ACK[Math.floor(Math.random() * MUTE_ACK.length)];
      await this.#deliver(ctx, ack, {});
      return;
    }

    // 2) 静默中：不判定上下文、不理任何人；只有再 @ 她（或叫她名字）才解除
    if (muteEnabled && kvGet(muteKey, 0)) {
      const resume = config.mute?.autoResumeOnAt !== false && (atMe || nameMention);
      if (resume) {
        kvSet(muteKey, 0);
        log.info(`解除静默：${ctx.scope}（${senderName} 叫了她）`);
      } else {
        if (text) {
          saveMessage({
            scope: ctx.scope,
            scopeType: ctx.scopeType,
            userId,
            groupId,
            senderName,
            role: 'user',
            text,
          });
        }
        log.debug(`静默中，忽略：${String(text).slice(0, 30)}`);
        return;
      }
    }

    // 3) 人格：/persona 命令 > 全局退出词 > 会话识别触发词
    const switched = this.#handlePersona(ctx);
    if (switched) {
      if (text) {
        saveMessage({
          scope: ctx.scope,
          scopeType: ctx.scopeType,
          userId,
          groupId,
          senderName,
          role: 'user',
          text,
        });
      }
      await this.#deliver(ctx, switched.ack, {});
      return;
    }

    let needReply;
    if (!isGroup) needReply = !!config.reply.privateAlwaysReply;
    else if (atMe || nameMention) needReply = true;
    else needReply = !config.reply.groupNeedMention;

    // 群里没被叫到：再看一眼上下文，判断这句是不是在跟她说话
    if (!needReply && isGroup && text && config.reply.groupContextReply) {
      needReply = await this.#isTalkingToMe(ctx);
      if (needReply) {
        log.info(`上下文判定 → 在跟她说（${senderName}: ${text.slice(0, 30)}）`);
      }
    }

    // 没被叫到：只记录，作为上下文，不回复
    if (!needReply) {
      if (text) {
        saveMessage({
          scope: ctx.scope,
          scopeType: ctx.scopeType,
          userId,
          groupId,
          senderName,
          role: 'user',
          text,
        });
      }
      return;
    }

    if (!text && !atMe) return;
    this.#enqueue(ctx);
  }

  /**
   * 读当前会话的人格状态。
   * 主人格是全局的（头像只有一个），子人格按会话来。
   * 老版本把子人格直接存在 `persona:<scope>`，这里顺手兼容一下。
   */
  #personaState(scope) {
    const identities = normalizeIdentities();

    // 主人格分两级：
    //   persona:identity:<scope>  这个群/会话单独指定的（优先级高）
    //   persona:identity          全局默认
    // 没指定就回落到全局；全局也没有就用默认人格。
    const scopedKey = String(kvGet(`persona:identity:${scope}`, '') || '');
    const globalKey = String(kvGet('persona:identity', '') || '');
    const idKey = scopedKey || globalKey;
    const identity = (idKey ? findIdentity(idKey, identities) : null) || defaultIdentity(identities);

    const modeKey = String(
      kvGet(`persona:mode:${scope}`, '') || kvGet(`persona:${scope}`, '') || ''
    );
    const mode = modeOf(identity, modeKey);

    return { identities, identity, modeKey, mode, scoped: !!scopedKey, scopedKey, globalKey };
  }

  /** 子人格落库（空串 = 回正常），顺便清掉旧键。 */
  #setMode(scope, key) {
    kvSet(`persona:mode:${scope}`, String(key || ''));
    kvSet(`persona:${scope}`, '');
  }

  /**
   * 人格切换。三个入口，优先级从高到低：
   *   1. /persona 强制命令 —— 唯一能换主人格的入口（阿米娅就这么进）
   *   2. 全局退出词（正常点 / 变回来 ……）—— 只在已经处于某子人格时才生效
   *   3. 会话识别触发词（当<子人格> / <某>模式 ……）—— 只切子人格，不换人
   *
   * 群里必须 @ 她或叫名字才认，否则路人一句话就能把整个群的人格改了。
   * @returns {{ack: string}|null} 处理了就返回要说的那句，没碰就返回 null。
   */
  #handlePersona(ctx) {
    const text = String(ctx.text || '').trim();
    if (!text) return null;

    // 群聊里默认必须 @ 她或叫名字，否则路人一句话就能改全群的人格。
    // 但主人（guard.ownerUserIds）例外 —— 他说「切换成某人格」就是真要切，
    // 不该逼他每次先打个 @。
    const owners = (config.guard?.ownerUserIds || []).map(Number);
    const isOwner = owners.includes(Number(ctx.userId));
    if (ctx.isGroup && !ctx.atMe && !ctx.nameMention && !isOwner) return null;

    const state = this.#personaState(ctx.scope);
    const { identities, identity, mode: curMode } = state;

    // 1) 强制命令
    const cmd = parsePersonaCommand(text);
    if (cmd) {
      return this.#runPersonaCommand({ cmd, identities, identity, curMode, ctx });
    }

    // 2) 说话里让她「变成另一个人」——这是主人格切换，会连带换头像和群名片
    const wantIdentity = matchIdentitySwitch(text, identities);
    if (wantIdentity) {
      return this.#switchIdentity({ target: wantIdentity, identity, ctx });
    }

    // 3) 全局退出词：任何子人格下都管用，否则切了别的就退不出来
    if (curMode && matchGlobalExit(text)) {
      this.#setMode(ctx.scope, '');
      this.#applyModeLook({ identity, mode: null, prevMode: curMode });
      log.info(`子人格 → 正常：${ctx.scope}（${ctx.senderName}：${text.slice(0, 20)}）`);
      return { ack: curMode.ack.exit };
    }

    // 4) 子人格会话识别：只在当前主人格的子人格里找
    const hit = matchSessionMode(text, identity);
    if (!hit) return null;

    const mode = hit.mode;
    if (hit.action === 'enter') {
      this.#setMode(ctx.scope, mode.key);
      this.#applyModeLook({ identity, mode, prevMode: curMode });
      log.info(
        `子人格 → ${mode.label}：${ctx.scope}（${ctx.senderName}：${text.slice(0, 20)}）`
      );
      return { ack: mode.ack.enter };
    }

    // 退出：只有正处在那个子人格里才算，免得一句「不X了」把别的子人格也关了
    if (curMode?.key !== mode.key) return null;
    this.#setMode(ctx.scope, '');
    this.#applyModeLook({ identity, mode: null, prevMode: curMode });
    log.info(`子人格 → 正常：${ctx.scope}（${ctx.senderName}：${text.slice(0, 20)}）`);
    return { ack: mode.ack.exit };
  }

  /** 执行一条 /persona 命令。 */
  #runPersonaCommand({ cmd, identities, identity, curMode, ctx }) {
    const { action, token } = parseCommandArg(cmd.rest);

    if (action === 'list') {
      return { ack: describePersona(identities, identity, curMode, { isGroup: ctx.isGroup, scoped: !!kvGet(`persona:identity:${ctx.scope}`, '') }) };
    }

    if (action === 'reset') {
      if (!curMode) return { ack: '已经是正常状态了。' };
      this.#setMode(ctx.scope, '');
      this.#applyModeLook({ identity, mode: null, prevMode: curMode });
      log.info(`子人格 → 正常（命令）：${ctx.scope}`);
      return { ack: curMode.ack.exit };
    }

    // 明确指定了层，就只往那一层找
    if (action === 'identity') {
      const target = findIdentity(token, identities);
      if (!target) return { ack: `没有叫「${token}」的主人格。\n${describePersona(identities, identity, curMode, { isGroup: ctx.isGroup, scoped: !!kvGet(`persona:identity:${ctx.scope}`, '') })}` };
      return this.#switchIdentity({ target, identity, ctx });
    }
    if (action === 'mode') {
      const target = findMode(identity, token);
      if (!target) return { ack: `${identity.label}没有「${token}」这个子人格。\n${describePersona(identities, identity, curMode, { isGroup: ctx.isGroup, scoped: !!kvGet(`persona:identity:${ctx.scope}`, '') })}` };
      return this.#switchMode({ target, curMode, ctx });
    }

    // 没指定层：先认主人格（换人影响大，意图更明确），再认子人格
    const asIdentity = findIdentity(token, identities);
    if (asIdentity) return this.#switchIdentity({ target: asIdentity, identity, ctx });

    const asMode = findMode(identity, token);
    if (asMode) return this.#switchMode({ target: asMode, curMode, ctx });

    return {
      ack: `没有「${token}」这个人格。\n${describePersona(identities, identity, curMode, { isGroup: ctx.isGroup, scoped: !!kvGet(`persona:identity:${ctx.scope}`, '') })}`,
    };
  }

  /**
   * 子人格可以带自己的脸和名字（比如换一张头像、群名片改成「XX-另一面」）。
   * 切进去、退出来时按需重设外观；普通子人格没有这几项就直接跳过，不打扰头像。
   */
  #applyModeLook({ identity, mode, prevMode }) {
    if (!identity) return;
    const touched = mode?.avatar || mode?.nickname || prevMode?.avatar || prevMode?.nickname;
    if (!touched) return;

    this.appearanceQueue = this.appearanceQueue
      .then(() =>
        applyIdentityAppearance({
          api: this.api,
          identity,
          mode: mode || null, // 传 null = 回到主人格的样子
          selfId: this.getSelfId(),
        })
      )
      .catch((err) => log.warn(`切换外观失败：${err.message}`));
  }

  /** 切子人格：影响当前会话；带外观的子人格会顺带换脸换名。 */
  #switchMode({ target, curMode, ctx, identity }) {
    if (!target.enabled) return { ack: `${target.label}还没上线，先占着位置。` };
    if (curMode?.key === target.key) return { ack: `已经是${target.label}了。` };

    this.#setMode(ctx.scope, target.key);
    this.#applyModeLook({ identity, mode: target, prevMode: curMode });
    log.info(`子人格 → ${target.label}（命令）：${ctx.scope}`);
    return { ack: target.ack.enter };
  }

  /**
   * 切主人格：全局生效，还要换头像和群名片。
   * 外观是慢操作（多群要逐个改），所以先回话、后台再改，不让人干等。
   */
  #switchIdentity({ target, identity, ctx }) {
    if (!target.enabled) {
      return { ack: `${target.label}还没上线，先占着位置。` };
    }
    if (target.key === identity?.key) {
      return { ack: `已经是${target.label}了。` };
    }

    // 群聊里切换 = 只改这个群；私聊切换 = 改全局默认。
    // 这样一个群可以是阿米娅、另一个群是二宝，互不影响。
    const scopedOnly = ctx.isGroup;
    kvSet(scopedOnly ? `persona:identity:${ctx.scope}` : 'persona:identity', target.key);

    // 新主人格没有这个子人格的话，回落到正常，免得上一个角色的表现串到这边
    const curModeKey = String(kvGet(`persona:mode:${ctx.scope}`, '') || '');
    if (curModeKey && !modeOf(target, curModeKey)) {
      this.#setMode(ctx.scope, '');
    }

    log.info(
      `主人格 → ${target.label}：${scopedOnly ? `仅本群（${ctx.scope}）` : '全局'}，` +
        `由 ${ctx.senderName} 触发`
    );

    if (scopedOnly) {
      // 只换这个群的名片。头像属于账号级，改了所有群一起变 ——
      // 既然是「一个群一个样」，就不动头像，靠群名片区分。
      this.appearanceQueue = this.appearanceQueue
        .then(() =>
          applyGroupCardOnly({
            api: this.api,
            groupId: ctx.groupId,
            selfId: this.getSelfId(),
            identity: target,
          })
        )
        .catch((err) => log.warn(`改群名片失败：${err.message}`));
    } else {
      // 全局切换：换头像 + 逐群改名片
      this.appearanceQueue = this.appearanceQueue
        .then(() =>
          applyIdentityAppearance({ api: this.api, identity: target, selfId: this.getSelfId() })
        )
        .catch((err) => log.warn(`切换外观失败：${err.message}`));
    }

    return { ack: target.ack.enter };
  }

  /**
   * 把待回复的消息攒起来，合并成一次请求。
   *
   * 群聊按「整个会话」合并 —— 几个人接连说话时会合成一次回复，她可以一起回应；
   * 私聊仍然按人。每条消息都保留说话人，回复时才分得清谁说的。
   */
  #enqueue(ctx) {
    const key = ctx.isGroup ? ctx.scope : `${ctx.scope}:${ctx.userId}`;
    let buf = this.buffers.get(key);
    if (!buf) {
      buf = { ctx, items: [], timer: null, atMe: ctx.atMe };
      this.buffers.set(key, buf);
    }
    if (ctx.text) {
      buf.items.push({
        userId: ctx.userId,
        senderName: ctx.senderName,
        text: ctx.text,
        atMe: !!ctx.atMe,
      });
    }
    buf.atMe = buf.atMe || ctx.atMe;

    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      this.buffers.delete(key);
      this.#flush(buf).catch((err) => log.error(`回复失败：${err.message}`, err.stack));
    }, config.reply.debounceMs);
  }

  /**
   * 联网搜索一次，并把结果 tokens 计入当日预算。
   * 任何失败（被反爬、无结果、超限）都返回 ok:false，由调用方回「饿」话术。
   */
  async #trySearch(text) {
    const cfg = config.search || {};
    const maxPerQuery = Number(cfg.maxTokensPerQuery) || 100000;
    const maxPerDay = Number(cfg.maxTokensPerDay) || 5000000;

    // 天气类问题优先走专用源，比抓网页准
    let block = '';
    let queryUsed = '';
    if (/天气|气温|温度|冷不冷|热不热|下雨|下雪/.test(text)) {
      const city = extractCity(text);
      if (city) {
        const weather = await fetchWeather(city);
        if (weather) {
          block = `【实时天气】${weather}`;
          queryUsed = `weather:${city}`;
          log.debug(`天气查询命中：${city} → ${weather}`);
        } else {
          // 天气源没认出来，用清洗过的城市名再搜一次，比原句准
          log.debug(`天气源未命中「${city}」，改用网页搜索`);
          const res = await searchWeb(`${city} 天气 温度`, {
            maxResults: Number(cfg.maxResults) || 5,
            timeoutMs: Number(cfg.timeoutMs) || 12000,
          });
          block = formatResults({ ...res, query: `${city} 天气 温度` });
          queryUsed = `${city} 天气 温度`;
        }
      }
    }

    // 天气没命中（或本来就不是天气问题）再走网页搜索
    if (!block) {
      let q = cleanQuery(text) || text;
      // 问新闻时补个「最新」，否则搜出来都是网站首页
      if (/新闻|资讯|最新/.test(text) && !/最新/.test(q)) q += ' 最新';
      queryUsed = q;
      const res = await searchWeb(q, {
        maxResults: Number(cfg.maxResults) || 5,
        timeoutMs: Number(cfg.timeoutMs) || 12000,
      });
      block = formatResults({ ...res, query: q });
      if (!block) {
        log.info(`搜索无结果：${text.slice(0, 20)}${res.error ? '（' + res.error + '）' : ''}`);
        return { ok: false };
      }
    }

    const tokens = estimateTokens(block);
    const budget = checkBudget({ estimatedTokens: tokens, maxPerQuery, maxPerDay });
    if (!budget.ok) {
      log.warn(
        `搜索超预算（${budget.reason}）：本次约 ${tokens} tokens，今日 ${budget.used}/${budget.limit}`
      );
      return { ok: false };
    }

    addDailyUsed(tokens);
    log.info(
      `搜索「${queryUsed || text.slice(0, 20)}」→ 约 ${tokens} tokens（今日 ${getDailyUsed()}/${maxPerDay}）`
    );

    // 明确的约束：只准依据资料回答，不许编造搜索过程
    const note =
      '\n\n【注意】以上是刚联网查到的资料。只依据这些资料回答；' +
      '资料里没有的内容就直说没查到，不要编造搜索过程或搜索结果。';
    return { ok: true, block: block + note };
  }

  async #flush(buf) {
    const { ctx } = buf;
    const items = (buf.items || []).filter((it) => it && it.text);

    if (!this.limiter.allow(ctx.userId)) {
      log.warn(`限流：${ctx.userId} 触发频率限制，跳过`);
      return;
    }

    // 每个人的话单独入库，保留真实说话人（多人时不能混成一条）
    for (const it of items) {
      saveMessage({
        scope: ctx.scope,
        scopeType: ctx.scopeType,
        userId: it.userId,
        groupId: ctx.groupId,
        senderName: it.senderName,
        role: 'user',
        text: it.text,
      });
    }

    if (!items.length) {
      // 只 @ 不说话
      saveMessage({
        scope: ctx.scope,
        scopeType: ctx.scopeType,
        userId: ctx.userId,
        groupId: ctx.groupId,
        senderName: ctx.senderName,
        role: 'user',
        text: '@',
      });
      const line = ONLY_AT_LINES[Math.floor(Math.random() * ONLY_AT_LINES.length)];
      await this.#deliver(ctx, line, {});
      return;
    }

    // 这次要回应几个人
    const speakers = [...new Set(items.map((it) => it.userId))];
    const multi = speakers.length > 1;

    // 多人时把每句话都带上说话人，模型才分得清谁在说
    const userText = items.map((it) => it.text).join('\n');
    const speech = multi
      ? items.map((it) => `${it.senderName}: ${it.text}`).join('\n')
      : userText;

    const started = Date.now();
    // 当前会话用哪套人设：主人格定「谁」，子人格定「什么样子」
    const { identity, mode } = this.#personaState(ctx.scope);

    // 先取一次这个人的状态：怨气、心情、好感都靠它决定这一轮的态度
    const preState = getOrCreateUser({ userId: ctx.userId, nick: ctx.senderName });

    // 对方在认错的话，先把怨气消一点 —— 但效果是打折的，
    // 免得「欺负 → 道歉 → 再欺负」变成无限循环。
    const apologyScore = detectApology(userText);
    if (apologyScore > 0 && preState.resentment > 0) {
      const r = applyApology(ctx.userId, apologyScore);
      if (r) {
        log.info(
          `认错缓解怨气：${r.before.toFixed(0)} → ${r.resentment.toFixed(0)}（-${r.relief.toFixed(1)}，` +
            `真诚度 ${apologyScore.toFixed(2)}，本串第 ${r.times} 次）`
        );
        preState.resentment = r.resentment;
      }
    }

    // 怨气到顶了：不调模型，直接回一句「不想理」。
    // 放在最前面，省一次 API 调用，也确保她不会被自己的话术绕回去。
    const anger = resentmentLevel(preState.resentment);
    if (anger.level === 'refuse') {
      log.info(`怨气值 ${preState.resentment.toFixed(0)}，拒绝回复 ${ctx.senderName}`);
      await this.#deliver(ctx, '(不想理你)', {});
      return;
    }
    // 怨气偏高但还没到底：这一轮的语气要带气
    const angerHint = anger.level === 'annoyed' ? anger.hint : '';
    if (angerHint) {
      log.debug(`怨气值 ${preState.resentment.toFixed(0)}，本轮语气带气`);
    }
    const stickerPlan = planStickerReply(userText, preState);
    const wantSticker = stickerPlan.want;
    const stickerWillingNow = stickerPlan.willing;
    const stickerDirective = stickerPlan.directive;
    if (wantSticker) {
      log.debug(`被要表情包 → ${stickerWillingNow ? '愿意' : '不愿意'}（心情 ${preState.mood}，好感 ${preState.favor}）`);
    }

    const assembled = assembleContext({
      scope: ctx.scope,
      scopeType: ctx.scopeType,
      userId: ctx.userId,
      senderName: ctx.senderName,
      userText,
      isGroup: ctx.isGroup,
      groupName: ctx.groupName,
      groupId: ctx.groupId,
      identity,
      mode,
      // 刚存进去的这几条要从历史里排除，否则会重复喂给模型
      skipTail: items.length,
      contentOverride: ctx.isGroup ? speech : userText,
      stickerDirective,
      angerHint,
    });

    // 需要实时信息时联网查一下；超预算或查不到就用「饿」话术兜底
    let searchBlock = '';
    if (config.search?.enabled && shouldSearch(userText)) {
      const got = await this.#trySearch(userText);
      if (!got.ok) {
        const line = HUNGRY_LINES[Math.floor(Math.random() * HUNGRY_LINES.length)];
        await this.#deliver(ctx, line, {});
        return;
      }
      searchBlock = got.block;
    }

    const messages = buildMessages({
      system: searchBlock ? `${assembled.system}\n\n${searchBlock}` : assembled.system,
      history: assembled.history,
      userContent: assembled.content,
    });

    let raw;
    try {
      raw = await chat({ messages, maxTokens: 500, tag: 'reply' });
    } catch (err) {
      log.error(`模型调用失败：${err.message}`);
      return;
    }

    const rawReply = sanitizeReply(raw, identity?.label || config.botName);
    let { text: reply, sticker } = extractSticker(rawReply);

    // 出口把关：这一段内容安不安全？
    // 不安全就把整段换成一句岔开的话（不解释、不说「这属于敏感内容」），
    // 让人感觉是「她不想聊」而不是「被系统挡了」。
    if (reply) {
      const verdict = await checkSensitive(reply);
      if (!verdict.safe) {
        log.warn(
          `回复被判敏感，已替换：${reply.slice(0, 50)}…（判定：${String(verdict.reason || '').slice(0, 20)}）`
        );
        reply = deflectReply(identity?.key);
        sticker = null;
        // 这轮不记记忆、不做内省，免得把敏感内容带进长期状态
        await this.#deliver(ctx, reply, {});
        return;
      }
    }

    // 被要表情包时兜底：答应的必须真给一张，拒绝的绝不能偷塞一张
    if (wantSticker) {
      if (stickerWillingNow) {
        if (!sticker) {
          const keys = stickerKeysFor({ mode, identity });
          const pick = keys[Math.floor(Math.random() * keys.length)];
          const file = pick ? config.stickers?.list?.[pick] : '';
          if (file) {
            sticker = path.join(PATHS.root, config.stickers.dir || 'assets/stickers', file);
            log.info(`她答应了但没带表情，补一张随机的：${pick}`);
          }
        }
      } else if (sticker) {
        log.info('她说了不愿意，去掉模型自作主张加的表情');
        sticker = null;
      }
    }

    if (!reply && !sticker) {
      log.warn('模型返回空内容，跳过');
      return;
    }

    log.info(
      `${ctx.isGroup ? '群' + ctx.groupId : '私聊'} ${ctx.senderName}: ` +
        `${userText.replace(/\n/g, " / ").slice(0, 40)} → ${reply.slice(0, 40)}` +
        `${sticker ? ' [表情包]' : ''} ` +
        `(${Date.now() - started}ms)`
    );

    await this.#deliver(ctx, reply, {
      replyMsgId: ctx.isGroup ? ctx.ev.message_id : undefined,
      sticker,
    });

    // 后台更新情绪/好感度 + 记忆，不阻塞下一句
    this.#introspect({
      userId: ctx.userId,
      userText,
      replyText: reply,
      state: assembled.state,
      personaName: identity?.label || config.botName,
    }).catch((err) => log.warn(`内省失败：${err.message}`));

    if (!ctx.isGroup) {
      maybeSummarize({ scope: ctx.scope, subject: `user:${ctx.userId}` }).catch(() => {});
    }
  }

  async #deliver(ctx, text, { replyMsgId, sticker } = {}) {
    // 打字延迟：按字数，夹在配置区间内
    const [minD, maxD] = config.reply.replyDelayMs || [300, 1600];
    const target = Math.min(maxD, Math.max(minD, 60 * text.length + 250));
    const delay = target * (0.6 + Math.random() * 0.6);
    await sleep(delay);

    let res;
    try {
      if (ctx.isGroup) {
        // 默认「直接接话」：不 @ 人、也不引用回复，像群里正常聊天那样
        const atSender = config.reply.groupAtSender === true;
        const quote = config.reply.quoteReply === true;
        res = await this.api.sendGroup(ctx.groupId, text, {
          atUserId: atSender ? ctx.userId : undefined,
          replyMsgId: quote ? replyMsgId : undefined,
          sticker,
        });
      } else {
        res = await this.api.sendPrivate(ctx.userId, text, { sticker });
      }
    } catch (err) {
      log.error(`发送失败：${err.message}`);
      return;
    }

    // 记下来，避免 NapCat 把这条回推成 message_sent 时被当成主人发言
    this.markSent(text, res?.data?.message_id);

    // 用当前主人格的名字存，切过人格后历史记录里的人才对得上
    const { identity } = this.#personaState(ctx.scope);

    saveMessage({
      scope: ctx.scope,
      scopeType: ctx.scopeType,
      userId: ctx.userId,
      groupId: ctx.groupId,
      senderName: identity?.label || config.botName,
      role: 'assistant',
      text: text || '[表情包]',
    });
  }

  async #introspect({ userId, userText, replyText, state, personaName }) {
    if (!config.emotion?.enabled) return;

    const every = Math.max(1, Number(config.emotion.updateEveryTurns) || 1);
    const doLlm = Number(state?.turns || 0) % every === 0;

    let result = null;
    if (doLlm) {
      try {
        const content = await chat({
          messages: buildIntrospectMessages({
            state,
            exchange: `对方: ${userText}\n你: ${replyText}`,
            personaName: personaName || config.botName,
          }),
          temperature: 0.3,
          maxTokens: 200,
          jsonMode: true,
          tag: 'introspect',
        });
        result = parseJsonLoose(content);
      } catch (err) {
        log.warn(`内省调用失败：${err.message}`);
      }
    }

    if (!result) {
      result = {
        favorDelta: heuristicDelta(userText),
        mood: state?.mood || 'calm',
        moodIntensity: state?.moodIntensity ?? 0.3,
        note: '',
      };
    }

    const after = applyIntrospection(userId, result);
    if (result.note) {
      addMemory({
        subject: `user:${userId}`,
        content: String(result.note),
        importance: 0.7,
        kind: 'event',
      });
    }
    if (after && after.favorDelta !== 0) {
      log.debug(`好感度 ${state?.favor} → ${after.favor} (${after.favorDelta > 0 ? '+' : ''}${after.favorDelta})`);
    }
  }
}
