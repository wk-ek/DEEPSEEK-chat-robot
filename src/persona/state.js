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
    turns: Number(row.turns),
    lastNote: row.last_note || '',
  };
}

/** 应用一次内省结果：好感度增减、情绪、turns+1。 */
export function applyIntrospection(userId, result) {
  if (!result) return null;
  const db = getDb();
  const uid = String(userId);
  const row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(uid);
  if (!row) return null;

  let delta = Number(result.favorDelta ?? 0);
  if (!Number.isFinite(delta)) delta = 0;
  delta = Math.max(-3, Math.min(3, delta));

  const favor = Math.max(0, Math.min(100, Number(row.favor) + delta));
  const mood = normalizeMood(result.mood || row.mood);
  let intensity = Number(result.moodIntensity ?? row.mood_intensity);
  if (!Number.isFinite(intensity)) intensity = 0.3;
  intensity = Math.max(0, Math.min(1, intensity));
  const note = result.note ? String(result.note).slice(0, 120) : row.last_note;

  db.prepare(
    `UPDATE users SET favor = ?, mood = ?, mood_intensity = ?, turns = turns + 1,
     last_note = ?, last_seen = ? WHERE user_id = ?`
  ).run(favor, mood, intensity, note, Date.now(), uid);

  const after = db.prepare('SELECT * FROM users WHERE user_id = ?').get(uid);
  return {
    userId: uid,
    nick: after.nick || `用户${uid}`,
    favor: Number(after.favor),
    mood: normalizeMood(after.mood),
    moodIntensity: Number(after.mood_intensity),
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
