import fs from 'node:fs';
import path from 'node:path';
import { PATHS, config } from '../config.js';
import { MOOD_LABELS, favorTier } from '../persona/state.js';
import { stickerKeysFor, stickerDescFor } from '../persona/identities.js';

/** 人设文件热更新：改文件后最多 1 秒生效，不用重启。主人格和子人格的文件都走这里。 */
const personaCaches = new Map();

function resolvePersonaPath(file) {
  const f = file || config.personaFile || 'config/persona.md';
  return path.isAbsolute(f) ? f : path.join(PATHS.root, f);
}

export function personaText(file = config.personaFile) {
  const abs = resolvePersonaPath(file);
  let c = personaCaches.get(abs);
  if (!c) {
    c = { text: '', mtime: -1, checkedAt: 0 };
    personaCaches.set(abs, c);
  }
  const now = Date.now();
  if (now - c.checkedAt > 1000) {
    c.checkedAt = now;
    try {
      const mtime = fs.statSync(abs).mtimeMs;
      if (mtime !== c.mtime) {
        c.text = fs.readFileSync(abs, 'utf8');
        c.mtime = mtime;
      }
    } catch {
      if (!c.text) c.text = `你叫${config.botName}，一个呆呆的女生。`;
    }
  }
  return c.text;
}

/**
 * 组装 system prompt。两层人设：
 *   identity.personaFile —— 她是谁（底子）
 *   mode.file            —— 她此刻怎么说话（表现），可选
 * 状态与记忆是「此刻的补充」，说话规则放最后（模型对末尾更敏感）。
 */
export function buildSystemPrompt({ state, memories, scope, identity, mode }) {
  const name = identity?.label || config.botName;
  const tier = favorTier(state?.favor ?? config.emotion.initialFavor);
  const mood = MOOD_LABELS[state?.mood] || state?.mood || '平静';

  const parts = [];

  const baseFile = identity?.personaFile || config.personaFile;
  parts.push(`【你是谁】\n${personaText(baseFile)}`);

  // 剧情知识库：不是让模型背设定，是让它「回忆」
  if (identity?.loreFile) {
    parts.push(
      `【你亲身经历过的事】\n${personaText(identity.loreFile)}\n\n` +
        `以上是你的记忆，不是要背诵的资料。别人聊到相关话题时自然地回忆，` +
        `不要主动复述剧情、不要像在念年表。不知道的部分就说不知道。`
    );
  }

  // 子人格是一次「换装」，不换人：明确告诉模型以这一节为准，压住底子里的冲突描述
  if (mode?.file) {
    parts.push(
      `【此刻的样子：${mode.label}】\n${personaText(mode.file)}\n\n` +
        `上面是她的底子，这一节是她此刻说话的样子。两者有出入时，以本节为准。`
    );
  }

  parts.push(
    `【此刻的状态】\n` +
      `你今天的情绪：${mood}。\n` +
      `你对「${state?.nick || '对方'}」的好感度：${Math.round(state?.favor ?? config.emotion.initialFavor)}/100（${tier.desc}）。\n` +
      (tier.behavior ? `在这个距离下，你会：${tier.behavior}\n` : '') +
      (state?.lastNote ? `你记得最近和 ta 聊到：${state.lastNote}\n` : '')
  );

  if (memories?.length) {
    const lines = memories.map((m) => `- ${m.content}`).join('\n');
    parts.push(`【你还记得的事】（自然地用，别生硬复述）\n${lines}`);
  }

  if (scope?.type === 'group') {
    parts.push(
      `【场景】\n` +
        `你在 QQ 群「${scope.groupName || scope.groupId}」里。\n` +
        `刚才可能有好几个人在说话，也可能有人在接别人的话。\n` +
        `你可以回应其中一个人，也可以同时回应好几个人，或者顺着话题跟大家一起说 —— ` +
        `就像真的在群里插话那样。\n` +
        `**不用点名，也不用挨个点评**。想回应谁就对着谁说；不想回应的人可以完全不提。`
    );
  } else {
    parts.push(`【场景】\n你和「${state?.nick || '对方'}」在 QQ 私聊。`);
  }

  parts.push(
    `【说话规则】\n` +
      `1. 只输出你要说的话本身。不要加「${name}：」前缀，不要括号里的动作描写。\n` +
      `2. 不用 markdown、列表、标题；emoji 最多一个。\n` +
      `3. 通常 1~3 句、不超过 ${config.reply.maxReplyChars} 字。对方在讲难过的事时可以稍长，但别变成演讲。\n` +
      `4. 口语中文，像在手机上打字。不用「亲」「宝子」，不说「有什么可以帮你」。\n` +
      `5. 不要重复对方原话来表示你在听。\n` +
      `6. 不知道就说不知道，不要编造自己做过的事。\n` +
      `7. 对方在闹、在开玩笑时可以接梗，但别过度表演。\n` +
      `8. 被问天气时只说体感（挺冷的 / 有点热 / 凉凉的），不要报具体温度数字。\n` +
      `9. **对方明显在开玩笑、逗你、说俏皮话时，你也可以用玩笑接回去** —— 怎么接按你的人设来，` +
      `不要一本正经地解释，也不要用客服腔把梗掐死。\n` +
      `10. 但如果对方在认真说事、在难过、在求助，就不要开玩笑，把话接稳。`
  );

  // 子人格的关键约束放在规则之后再强调一次，位置越靠后越不容易被冲淡
  if (mode?.promptNote) {
    parts.push(`【当前人格的硬要求】\n${mode.promptNote}`);
  }

  // 放在最后：模型对提示词末尾更敏感，表情才容易真的用上
  if (config.stickers?.enabled && config.stickers.list) {
    const keys = stickerKeysFor({ mode, identity });
    if (keys.length) {
      const map = config.stickers.descriptions || {};
      parts.push(
        `【表情包】\n` +
          `你有这几张自己的表情图，在回复最末尾写标记就会变成图片发出去：\n` +
          keys.map((k) => `- [[sticker:${k}]]  ${map[k] || ''}`).join('\n') +
          `\n\n**这一轮只要有情绪反应，就在末尾带一张**，按上面每张图的说明挑最贴的那张。\n` +
          `绝大多数回复都应该带 —— 不带会显得很干、很像在念稿。\n` +
          `**唯一的例外**：对方在讲正经事、难过的事、求助的时候，一张都不要带。\n` +
          `这些是真正的图，不是 emoji。想表达情绪就用这个标记，不要拿 😏😤 这类文字表情凑数。\n` +
          `一轮最多一张，放在回复最末尾。`
      );
    }
  }

  return parts.join('\n\n');
}

/** 把历史记录转成 messages 数组。 */
export function buildMessages({ system, history = [], userContent }) {
  const msgs = [{ role: 'system', content: system }];
  for (const h of history) {
    if (!h?.content) continue;
    msgs.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content });
  }
  if (userContent) msgs.push({ role: 'user', content: userContent });
  return msgs;
}

/** 让她做一次「内省」：更新情绪、好感度，顺手记下新事实。 */
export function buildIntrospectMessages({ state, exchange, personaName }) {
  return [
    {
      role: 'system',
      content:
        `你在扮演「${personaName}」。现在以这个角色的视角，安静地更新你对对方的感觉。\n` +
        `只输出一个 JSON 对象，不要解释、不要代码块。\n` +
        `字段：\n` +
        `- favorDelta: 整数，-3 到 3。对方让你更亲近给正数，让你不舒服给负数，普通闲聊给 0。\n` +
        `- mood: 从 ["平静","开心","低落","困倦","好奇","有点烦","害羞","想念"] 中选一个。\n` +
        `- moodIntensity: 0 到 1 的小数。\n` +
        `- note: 不超过 40 字，记下这轮对话里值得记住的新事实；没有就给空字符串。`,
    },
    {
      role: 'user',
      content:
        `当前好感度：${Math.round(state.favor)}/100，当前情绪：${MOOD_LABELS[state.mood] || '平静'}。\n` +
        `刚才的对话：\n${exchange}\n\n请输出 JSON。`,
    },
  ];
}
