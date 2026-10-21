import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { chat, parseJsonLoose } from '../llm/deepseek.js';
import { getDb } from './db.js';
import { addMemory, kvGet, kvSet } from './store.js';

const log = createLogger('summarize');
const running = new Set();

/**
 * 把较旧的对话压成几条「记忆」，然后推进水位线。
 * 不追求完美摘要，只求下次能想起「这个人之前提过什么」。
 */
export async function maybeSummarize({ scope, subject }) {
  if (!config.memory?.enabled) return;
  if (running.has(scope)) return;
  if (!subject) return;

  const db = getDb();
  const wm = Number(kvGet(`summary_wm:${scope}`, 0));
  const rows = db
    .prepare(
      `SELECT id, role, sender_name, text FROM messages
       WHERE scope = ? AND id > ? ORDER BY id ASC LIMIT 100`
    )
    .all(String(scope), wm);

  const threshold = Number(config.memory.summarizeEveryMessages) || 40;
  if (rows.length < threshold) return;

  running.add(scope);
  try {
    const lastId = rows[rows.length - 1].id;
    const convo = rows
      .map((r) => `${r.role === 'assistant' ? config.botName : r.sender_name || '对方'}: ${r.text}`)
      .join('\n');

    const content = await chat({
      messages: [
        {
          role: 'system',
          content:
            '你是一个记忆整理器。从对话里提炼出关于「对方」的、值得长期记住的事实。\n' +
            '只输出 JSON：{"memories":[{"content":"...","importance":0.6}]}\n' +
            '规则：每条不超过 40 字；只写关于对方的事实、偏好、经历、关系变化；' +
            '不写寒暄；最多 6 条；重复的合并；没有值得记的就给空数组。',
        },
        { role: 'user', content: `对话记录：\n${convo}` },
      ],
      temperature: 0.2,
      maxTokens: 500,
      jsonMode: true,
      tag: 'summarize',
    });

    const parsed = parseJsonLoose(content);
    const list = Array.isArray(parsed) ? parsed : parsed?.memories || [];
    let added = 0;
    for (const item of list) {
      const text = typeof item === 'string' ? item : item?.content;
      if (!text) continue;
      const imp = Number(typeof item === 'object' ? item?.importance : 0.6);
      addMemory({
        subject,
        content: String(text).slice(0, 120),
        importance: Number.isFinite(imp) ? Math.max(0, Math.min(1, imp)) : 0.6,
        kind: 'summary',
      });
      added++;
    }

    kvSet(`summary_wm:${scope}`, lastId);
    log.info(`摘要完成 ${scope}：${rows.length} 条对话 → ${added} 条记忆`);
  } catch (err) {
    log.warn(`摘要失败 ${scope}：${err.message}`);
  } finally {
    running.delete(scope);
  }
}
