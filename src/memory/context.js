import { config } from '../config.js';
import { recentMessages, recallMemories } from './store.js';
import { getOrCreateUser } from '../persona/state.js';
import { buildSystemPrompt } from '../llm/prompt.js';

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
}) {
  const rows = recentMessages(scope, config.reply.maxContextMessages);

  const last = rows[rows.length - 1];
  const historyRows =
    last && last.role === 'user' && last.text === userText ? rows.slice(0, -1) : rows;

  const history = toChatHistory(historyRows, { isGroup });

  const state = getOrCreateUser({ userId, nick: senderName });

  const memories = config.memory.enabled
    ? recallMemories({
        subject: `user:${userId}`,
        query: userText,
        topK: config.memory.recallTopK,
      })
    : [];

  const system = buildSystemPrompt({
    state,
    memories,
    scope: { type: scopeType, groupName, groupId },
    identity,
    mode,
  });

  const content = isGroup ? `${senderName}: ${userText}` : userText;

  return { system, history, content, memories, state };
}
