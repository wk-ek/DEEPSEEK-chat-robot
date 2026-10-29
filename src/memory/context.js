import fs from 'node:fs';
import { config } from '../config.js';
import { recentMessages, recallMemories } from './store.js';
import { getOrCreateUser } from '../persona/state.js';
import { buildSystemPrompt } from '../llm/prompt.js';
import { detectIntent, needsCloud, wantsLongReply } from '../brain/intent.js';
import { loadProfile, renderLitePersona } from '../llm/lite-persona.js';
import { recallLore, defaultLorePath } from './lore.js';
import { buildIndex, search as kbSearch, defaultKbPath } from './kb.js';

/** 会话键：私聊按人，群聊按群。 */
export function scopeOf({ type, userId, groupId }) {
  return type === 'group' ? `group:${groupId}` : `private:${userId}`;
}

/** DB 行 → chat messages。群聊里每条都带昵称，模型才知道谁在说话。 */
export function toChatHistory(rows, { isGroup }) {
  return rows.map((r) => ({
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content:
      r.role === 'assistant'
        ? r.text
        : isGroup
          ? `${r.sender_name || '某人'}: ${r.text}`
          : r.text,
  }));
}

/**
 * 组装一次回复所需的全部上下文：
 * 历史（剔除当前这句，避免重复喂）+ 记忆 + 状态 + system prompt + 当前内容。
 *
 * @param {number} [skipTail] 直接跳过最近 N 条（多人同时说话时用，比按文本匹配可靠）
 * @param {string} [contentOverride] 直接用这段文本作为「当前内容」（多人合并时已自带说话人）
 */
export function assembleContext({
  scope,
  scopeType,
  userId,
  senderName,
  userText,
  isGroup,
  groupName,
  groupId,
  identity,
  mode,
  skipTail = 0,
  contentOverride,
  stickerDirective,
  angerHint,
}) {
  const rows = recentMessages(scope, config.reply.maxContextMessages);

  let historyRows;
  if (skipTail > 0) {
    historyRows = rows.slice(0, Math.max(0, rows.length - skipTail));
  } else {
    // 单人的情况：按内容匹配剔除最后那一句
    const last = rows[rows.length - 1];
    historyRows = last && last.role === 'user' && last.text === userText ? rows.slice(0, -1) : rows;
  }

  const history = toChatHistory(historyRows, { isGroup });

  const state = getOrCreateUser({ userId, nick: senderName });

  const memories = config.memory.enabled
    ? recallMemories({
        subject: `user:${userId}`,
        query: userText,
        topK: config.memory.recallTopK,
      })
    : [];

  // ---- 精简人格：只给阿米娅这类配了档案的角色用 ----
  // 用结构化档案 + 按需检索的 lore，替代整段 persona.md / lore.md
  let lite = null;
  if (identity?.liteProfile) {
    const profile = loadProfile(identity.liteProfile);
    if (profile) {
      const loreFile = identity.loreFile ? defaultLorePath(identity.loreFile) : null;
      const hits = loreFile ? recallLore(loreFile, userText, 2, 2) : [];
      const text = renderLitePersona(profile, hits, state);
      if (text) lite = { text, loreCount: hits.length };
    }
  }

  // ---- 意图识别：这一轮是要聊天、讲故事，还是该糊弄 ----
  // 讲故事这类必须真的干活（放宽长度、走云端），
  // 写代码这类要岔开（她不是编程助手）。
  const intent = detectIntent(userText);
  const wantsLong = wantsLongReply(intent);
  const forceCloud = needsCloud(intent);

  // ---- 知识库检索（Stage 1 数据当数据库）----
  // 只在配了 liteProfile 的人格上启用，大肥鱼这种原创人格不该知道明日方舟设定
  let kbHits = [];
  if (identity?.liteProfile) {
    try {
      const kbPath = defaultKbPath();
      if (fs.existsSync(kbPath)) {
        buildIndex(kbPath);
        kbHits = kbSearch(userText, { topK: 2, minScore: 0.5 });
      }
    } catch (err) {
      // 检索失败不该影响正常回复
    }
  }

  const system = buildSystemPrompt({
    state,
    memories,
    scope: { type: scopeType, groupName, groupId },
    identity,
    mode,
    stickerDirective,
    angerHint,
    lite,
    kbHits,
    task: intent,
  });

  const content = contentOverride || (isGroup ? `${senderName}: ${userText}` : userText);

  return { system, history, content, memories, state, kbHits, intent, wantsLong, forceCloud };
}
