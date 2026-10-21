/**
 * 人格的两层结构：
 *
 *   主人格 identity —— 她是「谁」（大肥鱼 / 阿米娅）。全局一份，因为头像和
 *                      QQ 昵称是账号级的，没法按群分开。
 *   子人格 mode     —— 同一角色此刻的「表现」（正常 / 串子 / 傲娇 / 毒舌）。
 *                      按会话隔离，A 群切傲娇不影响 B 群。
 *
 * 这里只放纯函数，不碰数据库 —— 当前状态存在 kv 表里：
 *   persona:identity     主人格 key（全局）
 *   persona:mode:<scope> 子人格 key（按会话，空串 = 正常）
 * 由 reply.js 读写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, PATHS } from '../config.js';

/** 会话里说触发词就能切的子人格。 */
export const TRIGGER_SESSION = 'session';
/** 只能靠 /persona 命令切的子人格（比如还没做完的）。 */
export const TRIGGER_COMMAND = 'command';

/** 触发词最长多少字才当指令；超过就当正常聊天，避免误伤。 */
export const TRIGGER_MAX_CHARS = 20;

/** 没在当前子人格下也要能退出的说法。 */
const DEFAULT_EXIT_KEYWORDS = ['变回来', '正常点', '回默认', '退出人格', '恢复原样', '别演了', '不演了'];

const DEFAULT_COMMAND_PREFIXES = ['/persona', '/人格', '/模式'];

const LIST_WORDS = ['list', '?', '列表', 'help', '帮助'];
const RESET_WORDS = ['off', 'reset', 'default', 'none', '默认', '重置', '关闭', '原样', '正常'];
const IDENTITY_WORDS = ['主人格', '主人', 'main', 'identity'];
const MODE_WORDS = ['子人格', '表现', 'mode'];

/**
 * 「别凶我」不该切到毒舌。触发词前面紧挨着否定词时不算数 ——
 * 只对「进入」生效，因为「别串了」这类退出词本身就以「别」开头。
 */
const NEGATIONS = ['别', '不要', '不用', '不许', '甭'];

const DEFAULT_ENTER_ACK = '好，切过去了。';
const DEFAULT_EXIT_ACK = '嗯……变回来了。';
const DEFAULT_SWITCH_ACK = '我来了。';

function resolveFile(rel) {
  if (!rel) return '';
  return path.isAbsolute(rel) ? rel : path.join(PATHS.root, rel);
}

/** 归一化一个子人格。file 为空表示「不叠加额外表现」，也就是正常状态。 */
function normalizeMode(key, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = String(raw.label || key);
  return {
    key,
    label,
    file: raw.file ? resolveFile(raw.file) : '',
    trigger: String(raw.trigger || TRIGGER_SESSION).toLowerCase(),
    enabled: raw.enabled !== false,
    aliases: [...new Set([...(raw.aliases || []), label, key].map(String).filter(Boolean))],
    enter: (raw.enter || []).map(String).filter(Boolean),
    exit: (raw.exit || []).map(String).filter(Boolean),
    ack: {
      enter: String(raw.ack?.enter || DEFAULT_ENTER_ACK),
      exit: String(raw.ack?.exit || DEFAULT_EXIT_ACK),
    },
    stickerKeys:
      Array.isArray(raw.stickerKeys) && raw.stickerKeys.length
        ? raw.stickerKeys.map(String)
        : key === 'chuanzi'
          ? (config.stickers?.chuanziKeys || []).map(String) // 老配置兼容
          : [],
    promptNote: String(raw.promptNote || '').trim(),
    // 子人格也能改外观：换一张头像、换一个昵称。
    // 不填就继承主人格，退出时恢复。
    avatar: raw.avatar ? resolveFile(raw.avatar) : '',
    nickname: String(raw.nickname || '').trim(),
  };
}

function normalizeIdentity(key, raw) {
  if (!raw || typeof raw !== 'object') return null;

  const modes = [];
  for (const [mk, mv] of Object.entries(raw.modes || {})) {
    const m = normalizeMode(mk, mv);
    if (m) modes.push(m);
  }

  const label = String(raw.label || key);
  const avatarAbs = resolveFile(raw.avatar || '');
  // 头像缺失不算错，跳过换头像就行；这里先判断好，免得到处 existsSync
  const avatarExists = !!avatarAbs && fs.existsSync(avatarAbs);

  return {
    key,
    label,
    enabled: raw.enabled !== false,
    aliases: [...new Set([...(raw.aliases || []), label, key].map(String).filter(Boolean))],
    // 主人格的「变成我」触发词。空数组 = 只能靠 /persona 命令切
    trigger: String(raw.trigger || TRIGGER_SESSION).toLowerCase(),
    enter: (raw.enter || []).map(String).filter(Boolean),
    personaFile: resolveFile(raw.personaFile || config.personaFile),
    // 可选：这个人格「记得的事」（剧情知识库），会拼在人格之后
    loreFile: resolveFile(raw.loreFile || ''),
    avatar: avatarExists ? avatarAbs : '',
    avatarConfigured: avatarAbs,
    nickname: String(raw.nickname || config.botName || label),
    ack: {
      enter: String(raw.ack?.enter || DEFAULT_SWITCH_ACK),
      exit: String(raw.ack?.exit || DEFAULT_EXIT_ACK),
    },
    stickerKeys: Array.isArray(raw.stickerKeys) ? raw.stickerKeys.map(String) : [],
    // 表情包是「大肥鱼」的形象图，换主人格后发出来会串味，所以可整个关掉
    stickersEnabled: raw.stickers !== false,
    modes,
  };
}

/** 「变成 / 切换成 / 当……」这类动词。跟别名组合起来就能认出「变成阿米娅」。 */
const SWITCH_VERBS = ['变成', '变回', '变作', '切换成', '切换到', '换成', '换回', '成为', '当'];

/**
 * 会话里这句话是不是要把她「变成另一个主人格」。
 *
 * 两条路都能命中：
 *   1. 配置里显式写的 enter 触发词（可靠，优先）
 *   2. 「动词 + 别名」的通用组合，比如「变成阿米娅」「切换成大肥鱼」
 *
 * 注意这跟子人格切换是两回事：主人格变更会连带换头像和群名片，代价更大。
 *
 * @returns {object|null} 要切过去的主人格
 */
export function matchIdentitySwitch(text, identities = normalizeIdentities()) {
  const t = String(text || '').trim();
  if (!t || t.length > TRIGGER_MAX_CHARS + 8) return null;

  const usable = identities.filter((i) => i.enabled && i.trigger !== TRIGGER_COMMAND);

  // 1) 显式触发词
  for (const id of usable) {
    if (id.enter.some((k) => t.includes(k) && !negatedAt(t, k))) return id;
  }

  // 2) 动词 + 别名
  for (const id of usable) {
    for (const alias of id.aliases) {
      if (!alias) continue;
      for (const verb of SWITCH_VERBS) {
        const phrase = verb + alias;
        if (t.includes(phrase) && !negatedAt(t, phrase)) return id;
      }
    }
  }

  return null;
}

/** config.persona.identities → 有序数组。老的扁平 modes 结构也能读。 */
export function normalizeIdentities(personaCfg = config.persona) {
  const out = [];

  for (const [key, raw] of Object.entries(personaCfg?.identities || {})) {
    const id = normalizeIdentity(key, raw);
    if (id) out.push(id);
  }

  // 完全没配 identities 时，把当时的单人格配置当成一个主人格，别直接崩
  if (!out.length && personaCfg?.modes) {
    const fallback = normalizeIdentity('default', {
      label: config.botName,
      personaFile: config.personaFile,
      nickname: config.botName,
      modes: personaCfg.modes,
    });
    if (fallback) out.push(fallback);
  }

  return out;
}

/** 默认主人格：第一个启用的，没有就第一个。 */
export function defaultIdentity(identities = normalizeIdentities()) {
  return identities.find((i) => i.enabled) || identities[0] || null;
}

/** 按 key / label / 别名找主人格。 */
export function findIdentity(token, identities = normalizeIdentities()) {
  const t = String(token || '').trim().toLowerCase();
  if (!t) return null;
  return identities.find((i) => i.aliases.some((a) => a.toLowerCase() === t)) || null;
}

/** 在某个主人格下按 key / label / 别名找子人格。 */
export function findMode(identity, token) {
  const t = String(token || '').trim().toLowerCase();
  if (!t) return null;
  return (identity?.modes || []).find((m) => m.aliases.some((a) => a.toLowerCase() === t)) || null;
}

/**
 * 取子人格。空 key 或找不到都返回 null —— null 的含义是「正常状态，
 * 不叠加额外的表现文件」，不是错误。
 */
export function modeOf(identity, modeKey) {
  const key = String(modeKey || '').trim();
  if (!key) return null;
  return (identity?.modes || []).find((m) => m.key === key) || null;
}

/** 会话里这句话是不是要退出当前子人格。 */
export function matchGlobalExit(text, personaCfg = config.persona) {
  const t = String(text || '').trim();
  if (!t || t.length > TRIGGER_MAX_CHARS) return false;
  const words =
    Array.isArray(personaCfg?.exitKeywords) && personaCfg.exitKeywords.length
      ? personaCfg.exitKeywords
      : DEFAULT_EXIT_KEYWORDS;
  return words.map(String).some((k) => k && t.includes(k));
}

/** 触发词前面是不是紧挨着否定词。 */
function negatedAt(text, keyword) {
  const i = text.indexOf(keyword);
  if (i <= 0) return false;
  return NEGATIONS.some((n) => text.slice(0, i).endsWith(n));
}

/**
 * 会话识别：这句话是不是某个子人格的开关词。
 * 先扫所有「进入」再扫所有「退出」，免得两个子人格的关键词互相抢。
 * trigger = command 的子人格永远不参与。
 *
 * @returns {{mode: object, action: 'enter'|'exit'}|null}
 */
export function matchSessionMode(text, identity) {
  const t = String(text || '').trim();
  if (!t || t.length > TRIGGER_MAX_CHARS) return null;

  const usable = (identity?.modes || []).filter(
    (m) => m.enabled && m.trigger !== TRIGGER_COMMAND
  );

  for (const m of usable) {
    if (m.enter.some((k) => t.includes(k) && !negatedAt(t, k))) {
      return { mode: m, action: 'enter' };
    }
  }
  for (const m of usable) {
    if (m.exit.some((k) => t.includes(k))) return { mode: m, action: 'exit' };
  }
  return null;
}

/** 命令前缀，可在 config.persona.commands.prefixes 改。 */
export function commandPrefixes(personaCfg = config.persona) {
  const p = personaCfg?.commands?.prefixes;
  return Array.isArray(p) && p.length ? p.map(String) : DEFAULT_COMMAND_PREFIXES;
}

/**
 * 解析 /persona 命令。
 *   "/persona"            → { rest: '' }       列表
 *   "/persona 阿米娅"      → { rest: '阿米娅' }  切过去
 *   "/人格默认"            → { rest: '默认' }
 *   不是命令              → null
 */
export function parsePersonaCommand(text, personaCfg = config.persona) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (personaCfg?.commands?.enabled === false) return null;

  const lower = raw.toLowerCase();
  for (const prefix of commandPrefixes(personaCfg)) {
    const p = prefix.toLowerCase();
    if (!p || !lower.startsWith(p)) continue;
    return { prefix, rest: raw.slice(prefix.length).trim() };
  }
  return null;
}

/**
 * 命令参数解析结果：
 *   list                              列出现有人格
 *   reset                             回正常
 *   identity + token                  指定切主人格
 *   mode     + token                  指定切子人格
 *   auto     + token                  没指定层，先按主人格再按子人格找
 */
export function parseCommandArg(rest) {
  const raw = String(rest || '').trim();
  if (!raw) return { action: 'list' };

  const lower = raw.toLowerCase();
  if (LIST_WORDS.includes(lower)) return { action: 'list' };
  if (RESET_WORDS.includes(lower)) return { action: 'reset' };

  for (const w of IDENTITY_WORDS) {
    if (!lower.startsWith(w)) continue;
    const token = raw.slice(w.length).trim();
    if (token) return { action: 'identity', token };
  }
  for (const w of MODE_WORDS) {
    if (!lower.startsWith(w)) continue;
    const token = raw.slice(w.length).trim();
    if (token) return { action: 'mode', token };
  }

  return { action: 'auto', token: raw };
}

/** /persona 的列表回复。要短，QQ 消息不能太长。 */
export function describePersona(identities, curIdentity, curMode) {
  const lines = [];
  lines.push(`现在：${curIdentity?.label || '?'} · ${curMode?.label || '正常'}`);

  const ids = identities.map((i) => (i.enabled ? i.label : `${i.label}（未启用）`));
  lines.push(`主人格：${ids.join('、')}`);

  const modes = (curIdentity?.modes || []).filter((m) => m.enabled).map((m) => m.label);
  if (modes.length) lines.push(`子人格：正常、${modes.join('、')}`);

  lines.push('用法：/persona 名字 切换，/persona 默认 回正常');
  return lines.join('\n');
}

/**
 * 这套人格该用哪几个表情。
 * 优先级：子人格 → 主人格 → config.stickers.defaultKeys → 全部。
 */
export function stickerKeysFor({ mode = null, identity = null, stickerCfg = config.stickers } = {}) {
  const all = Object.keys(stickerCfg?.list || {});
  if (!all.length) return [];
  // 主人格明确关掉表情包（比如形象对不上），就别硬塞
  if (identity && identity.stickersEnabled === false) return [];

  const pick = (list) => (Array.isArray(list) ? all.filter((k) => list.includes(k)) : []);

  for (const candidate of [mode?.stickerKeys, identity?.stickerKeys, stickerCfg?.defaultKeys]) {
    const keys = pick(candidate);
    if (keys.length) return keys;
  }
  return all;
}

/** 表情标记的一句话说明，比如 happy=开心/被夸，sleepy=困/想睡。 */
export function stickerDescFor(keys, stickerCfg = config.stickers) {
  const map = stickerCfg?.descriptions || {};
  return keys.map((k) => (map[k] ? `${k}=${map[k]}` : k)).join('，');
}
