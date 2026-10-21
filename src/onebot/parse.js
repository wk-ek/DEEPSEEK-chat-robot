/** 消息段解析：把 OneBot 的 message（数组或 CQ 码字符串）统一成可读结构。 */

/** 把字符串 CQ 码粗略解析成段数组；已经是数组就原样返回。 */
export function toSegments(message) {
  if (Array.isArray(message)) return message;
  if (typeof message !== 'string') return [];
  const segs = [];
  const re = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(message)) !== null) {
    if (m.index > last) segs.push({ type: 'text', data: { text: message.slice(last, m.index) } });
    const data = {};
    const kv = m[2].replace(/^,/, '');
    for (const pair of kv.split(',')) {
      if (!pair) continue;
      const i = pair.indexOf('=');
      if (i === -1) continue;
      data[pair.slice(0, i)] = pair
        .slice(i + 1)
        .replace(/&#44;/g, ',')
        .replace(/&#91;/g, '[')
        .replace(/&#93;/g, ']')
        .replace(/&amp;/g, '&');
    }
    segs.push({ type: m[1], data });
    last = re.lastIndex;
  }
  if (last < message.length) segs.push({ type: 'text', data: { text: message.slice(last) } });
  return segs;
}

/** 提取纯文本，图片/表情转成占位标记，@ 转成 @昵称。 */
export function extractText(message) {
  const segs = toSegments(message);
  let out = '';
  for (const seg of segs) {
    switch (seg.type) {
      case 'text':
        out += seg.data?.text ?? '';
        break;
      case 'at':
        out += `@${seg.data?.name || seg.data?.qq || '某人'} `;
        break;
      case 'image':
        out += '[图片]';
        break;
      case 'face':
        out += '[表情]';
        break;
      case 'mface':
        out += '[表情包]';
        break;
      case 'record':
      case 'video':
      case 'file':
        out += `[${seg.type}]`;
        break;
      case 'reply':
        break;
      case 'forward':
        out += '[合并转发]';
        break;
      default:
        break;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** 是否 @ 了我 */
export function isAt(message, selfId) {
  if (!selfId) return false;
  return toSegments(message).some(
    (s) => s.type === 'at' && String(s.data?.qq) === String(selfId)
  );
}

/** 去掉 @我 的部分，得到真正要说的话 */
export function stripAt(message, selfId) {
  const segs = toSegments(message)
    .filter((s) => !(s.type === 'at' && String(s.data?.qq) === String(selfId)))
    .map((s) => {
      if (s.type === 'text') return { type: 'text', data: { text: s.data?.text ?? '' } };
      if (s.type === 'image') return { type: 'text', data: { text: '[图片]' } };
      return null;
    })
    .filter(Boolean);
  const text = segs.map((s) => s.data.text).join('');
  return text.replace(/\s+/g, ' ').trim();
}

/** 群聊里拼一行上下文："昵称: 内容" （不要 @ 噪声） */
export function toContextLine({ senderName, text, time }) {
  const who = senderName || '某人';
  const hhmm = time ? new Date(time * 1000).toTimeString().slice(0, 5) : '';
  return hhmm ? `[${hhmm}] ${who}: ${text}` : `${who}: ${text}`;
}

/** 文本里是否提到了她的名字 */
export function mentionsName(text, aliases) {
  if (!text || !aliases?.length) return false;
  const lower = text.toLowerCase();
  return aliases.some((a) => a && lower.includes(String(a).toLowerCase()));
}

/** 消息里有没有图片（决定要不要让模型知道 "对方发了图"） */
export function hasImage(message) {
  return toSegments(message).some((s) => s.type === 'image');
}
