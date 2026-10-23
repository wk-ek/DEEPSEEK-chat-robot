/**
 * 「精简人格」的 prompt 构建器。
 *
 * 原来的做法是把 persona.md（11KB）和 lore.md（3.4KB）整段塞进 system prompt，
 * 一次就是 6000 tokens。问题不在贵，在于**信息越多，人格越不稳**——
 * 模型要在一堆不相关的内容里找该用的部分。
 *
 * 这里换成：
 *   结构化档案（profile.json，按字段取）+ 检索到的 lore 片段（按需取）
 * 目标是 1000 字符以内，只留「这一轮真的用得上」的东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('persona:lite');

const cache = new Map();

/** 读 profile.json（按 mtime 缓存） */
export function loadProfile(relPath) {
  const file = path.isAbsolute(relPath) ? relPath : path.join(PATHS.root, relPath);
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.profile;
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.set(file, { mtime: st.mtimeMs, profile });
    return profile;
  } catch (err) {
    log.warn(`读人格档案失败 ${relPath}：${err.message}`);
    return null;
  }
}

/**
 * 把档案渲染成紧凑的 prompt 片段。
 *
 * @param {object} profile      loadProfile 的结果
 * @param {object[]} loreHits   recallLore 的结果（可能为空）
 * @param {object} state        运行时状态（好感/心情）
 * @returns {string}
 */
export function renderLitePersona(profile, loreHits = [], state = {}) {
  if (!profile) return '';
  const out = [];
  const id = profile.identity || {};
  const voice = profile.voice || {};

  // ---- 身份：一句话说清楚她是谁 ----
  const bits = [];
  if (id.name) bits.push(id.name);
  if (id.age) bits.push(`${id.age}岁`);
  if (id.race) bits.push(id.race);
  if (id.role) bits.push(id.role);
  out.push(`【你是谁】\n${bits.join('，')}。` +
    (id.address ? `叫对方「${id.address}」，用「您」。` : ''));

  // ---- 性格：只留最核心的几条 ----
  if (Array.isArray(profile.core) && profile.core.length) {
    out.push(`【你的底色】\n${profile.core.map((c) => `- ${c}`).join('\n')}`);
  }

  // ---- 声音：这是最能「像人」的部分，值得占篇幅 ----
  const vlines = [];
  if (voice.avgLen) vlines.push(`平均 ${voice.avgLen} 个字一句`);
  if (voice.ellipsisRate) vlines.push(`${Math.round(voice.ellipsisRate * 100)}% 的话里有「……」`);
  if (voice.filler?.length) vlines.push(`常说：${voice.filler.join(' / ')}`);
  if (voice.habit?.length) vlines.push(...voice.habit.map((h) => `- ${h}`));
  if (voice.never?.length) vlines.push(`**不说**：${voice.never.join('、')}`);
  if (vlines.length) out.push(`【你说话的样子】\n${vlines.join('。\n').replace(/。。/g, '。')}`);

  // ---- 反应：按场景的固定动作，比形容词有用 ----
  if (profile.reactions) {
    const lines = Object.entries(profile.reactions).map(
      ([k, v]) => `${k} → ${Array.isArray(v) ? v.join(' → ') : v}`
    );
    out.push(`【你怎么反应】\n${lines.join('\n')}`);
  }

  // ---- 边界 ----
  if (Array.isArray(profile.boundaries) && profile.boundaries.length) {
    out.push(`【不能做的】\n${profile.boundaries.map((b) => `- ${b}`).join('\n')}`);
  }

  // ---- 检索到的经历：只放相关的 ----
  if (loreHits.length) {
    const body = loreHits.map((h) => `【${h.title}】\n${h.body}`).join('\n\n');
    out.push(`【你亲身经历过的事（这段跟现在的对话有关）】\n${body}`);
  }

  return out.join('\n\n');
}

/** 测试用：清缓存 */
export function clearProfileCache() {
  cache.clear();
}
