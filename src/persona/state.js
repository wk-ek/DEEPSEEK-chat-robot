import { getDb } from '../memory/db.js';
import { config } from '../config.js';

export const MOOD_LABELS = {
  calm: '平静',
  happy: '开心',
  low: '低落',
  sleepy: '困倦',
  curious: '好奇',
  annoyed: '有点烦',
  shy: '害羞',
  miss: '想念',
};

const MOOD_KEYS = Object.keys(MOOD_LABELS);

export function normalizeMood(mood) {
  if (!mood) return 'calm';
  const s = String(mood).trim();
  if (MOOD_KEYS.includes(s)) return s;
  for (const [k, v] of Object.entries(MOOD_LABELS)) {
    if (v === s) return k;
  }
  return 'calm';
}

/** 好感度分段 → 关系描述 + 行为提示。这是让她「越聊越熟」的杠杆。 */
export function favorTier(favor) {
  const f = Number(favor) || 0;
  if (f < 20)
    return {
      desc: '戒备、疏离',
      behavior: '礼貌但话很少，不主动追问，不透露自己的事。',
    };
  if (f < 40)
    return {
      desc: '刚认识',
      behavior: '客气、克制，回应简短，偶尔反问一句。',
    };
  if (f < 60)
    return {
      desc: '有点熟了',
      behavior: '语气放松一点，愿意聊自己的小事，会记住对方说过的话。',
    };
  if (f < 80)
    return {
      desc: '朋友',
      behavior: '会开玩笑，会主动关心，说话带点懒散和真实情绪。',
    };
  return {
    desc: '很亲近',
    behavior: '话变多，会撒娇、会承认想念、会在意对方回不回消息。',
  };
}

export function getOrCreateUser({ userId, nick }) {
  const db = getDb();
  const uid = String(userId);
  let row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(uid);
  const now = Date.now();
  if (!row) {
    db.prepare(
      `INSERT INTO users (user_id, nick, favor, mood, mood_intensity, turns, first_seen, last_seen)
       VALUES (?, ?, ?, 'calm', 0.3, 0, ?, ?)`
    ).run(uid, nick || null, Number(config.emotion.initialFavor) || 30, now, now);
    row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(uid);
  } else if (nick && nick !== row.nick) {
    db.prepare('UPDATE users SET nick = ? WHERE user_id = ?').run(nick, uid);
    row.nick = nick;
  }
  return {
    userId: uid,
    nick: row.nick || `用户${uid}`,
    favor: Number(row.favor),
    mood: normalizeMood(row.mood),
    moodIntensity: Number(row.mood_intensity),
    resentment: Number(row.resentment ?? 0),
    turns: Number(row.turns),
    lastNote: row.last_note || '',
  };
}

/** 应用一次内省结果：好感度增减、情绪、turns+1。 */
/** 怨气的两个阈值。超过 hard 就不再给正式回复。 */
export const RESENTMENT = {
  mark: Number(config.emotion?.resentmentMark) || 60,
  hard: Number(config.emotion?.resentmentHard) || 85,
};

/**
 * 累计怨气。被玩弄、刁难时加，正常相处时缓慢消退。
 * 不在这里写库 —— applyIntrospection 会一起落盘。
 */
export function bumpResentment(current, delta) {
  return Math.max(0, Math.min(100, Number(current || 0) + Number(delta || 0)));
}

/**
 * 根据怨气值给出「此刻该用什么态度对这个人」。
 * @returns {{level:'normal'|'annoyed'|'refuse', hint:string}}
 */
export function resentmentLevel(resentment) {
  const r = Number(resentment || 0);
  if (r >= RESENTMENT.hard) {
    return {
      level: 'refuse',
      hint: '你对这个人已经很不耐烦了，不想再认真跟他说话。',
    };
  }
  if (r >= RESENTMENT.mark) {
    return {
      level: 'annoyed',
      hint:
        '你对这个人有情绪：他一直在拿你寻开心、让你为难。' +
        '回话可以带点气、带点委屈，句子更短，别像平时那么热情；但不要骂人，也不要翻旧账。',
    };
  }
  return { level: 'normal', hint: '' };
}

export function applyIntrospection(userId, result) {
  if (!result) return null;
  const db = getDb();
  const uid = String(userId);
  const row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(uid);
  if (!row) return null;

  let delta = Number(result.favorDelta ?? 0);

  // 怨气：这轮如果对方在故意玩弄、刁难，就明显往上涨；
  // 正常聊则缓慢回落（人不会一直记恨，但也不是一次就忘）。
  const wasMistreated = result.mistreat === true;
  const prevResentment = Number(row.resentment ?? 0);
  const resentment = bumpResentment(prevResentment, wasMistreated ? 20 : -1.5);
  // 第一次越过「标记线」时记下时间，方便以后说「我记得你」
  const mistreatedAt =
    wasMistreated && prevResentment < RESENTMENT.mark && resentment >= RESENTMENT.mark
      ? Date.now()
      : row.mistreated_at;
  if (!Number.isFinite(delta)) delta = 0;
  delta = Math.max(-3, Math.min(3, delta));

  const favor = Math.max(0, Math.min(100, Number(row.favor) + delta));
  const mood = normalizeMood(result.mood || row.mood);
  let intensity = Number(result.moodIntensity ?? row.mood_intensity);
  if (!Number.isFinite(intensity)) intensity = 0.3;
  intensity = Math.max(0, Math.min(1, intensity));
  const note = result.note ? String(result.note).slice(0, 120) : row.last_note;

  db.prepare(
    `UPDATE users SET favor = ?, mood = ?, mood_intensity = ?, resentment = ?, mistreated_at = ?, turns = turns + 1,
     last_note = ?, last_seen = ? WHERE user_id = ?`
  ).run(favor, mood, intensity, resentment, mistreatedAt ?? null, note, Date.now(), uid);

  const after = db.prepare('SELECT * FROM users WHERE user_id = ?').get(uid);
  return {
    userId: uid,
    nick: after.nick || `用户${uid}`,
    favor: Number(after.favor),
    mood: normalizeMood(after.mood),
    moodIntensity: Number(after.mood_intensity),
    resentment: Number(after.resentment ?? 0),
    mistreatedAt: after.mistreated_at ? Number(after.mistreated_at) : null,
    turns: Number(after.turns),
    lastNote: after.last_note || '',
    favorDelta: delta,
  };
}

/** 纯规则兜底：模型内省失败时也要有一点变化，否则她会像个死人。 */
export function heuristicDelta(text) {
  const t = String(text || '');
  let delta = 0;
  if (/(谢谢|喜欢你|想你|晚安|辛苦|抱抱|好棒|可爱)/.test(t)) delta += 1;
  if (/(滚|闭嘴|烦|讨厌|傻|蠢)/.test(t)) delta -= 2;
  if (t.length > 60) delta += 0.2;
  return Math.max(-2, Math.min(2, delta));
}
