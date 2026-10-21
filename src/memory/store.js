import { getDb, tx } from './db.js';
import { createLogger } from '../logger.js';

const log = createLogger('memory');

const STOPWORDS = new Set([
  '我们', '你们', '他们', '什么', '这个', '那个', '就是', '不是', '可以', '一下',
  '现在', '今天', '但是', '所以', '因为', '如果', '还是', '已经', '好像', '然后',
  '真的', '一个', '没有', '知道', '觉得', '时候', '这样', '那样', '自己', '怎么',
]);

/** 中文 2-gram + 英文词的粗糙关键词提取，够做小规模检索。 */
export function keywords(text, max = 14) {
  const set = new Set();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9_+-]{1,}/g) || []) set.add(w);
  for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) {
      const g = run.slice(i, i + 2);
      if (!STOPWORDS.has(g)) set.add(g);
    }
  }
  return [...set].slice(0, max);
}

// ---------- messages ----------

export function saveMessage({
  scope,
  scopeType,
  userId = null,
  groupId = null,
  senderName = null,
  role,
  text,
}) {
  getDb()
    .prepare(
      `INSERT INTO messages (scope, scope_type, user_id, group_id, sender_name, role, text, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(scope),
      String(scopeType),
      userId == null ? null : String(userId),
      groupId == null ? null : String(groupId),
      senderName,
      role,
      text,
      Date.now()
    );
}

export function recentMessages(scope, limit = 30) {
  const rows = getDb()
    .prepare(
      `SELECT role, text, sender_name, ts FROM messages
       WHERE scope = ? ORDER BY ts DESC LIMIT ?`
    )
    .all(String(scope), Math.max(1, limit));
  return rows.reverse();
}

export function messageCount(scope) {
  const r = getDb()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE scope = ?')
    .get(String(scope));
  return Number(r?.n || 0);
}

// ---------- memories ----------

export function addMemory({ subject, content, importance = 0.5, kind = 'fact' }) {
  const text = String(content || '').trim();
  if (!text) return null;
  // 同 subject 下高度重复的就不要了
  const dup = getDb()
    .prepare(
      `SELECT id FROM memories WHERE subject = ? AND content = ? LIMIT 1`
    )
    .get(String(subject), text);
  if (dup) return dup.id;
  const res = getDb()
    .prepare(
      `INSERT INTO memories (subject, kind, content, importance, ts) VALUES (?, ?, ?, ?, ?)`
    )
    .run(String(subject), kind, text, Number(importance), Date.now());
  return Number(res.lastInsertRowid);
}

/**
 * 召回：关键词命中 + 重要度 + 新近度，取 topK。
 * 刻意不做向量检索——个人聊天量级下这是过度设计。
 */
export function recallMemories({ subject, query = '', topK = 6 }) {
  const rows = getDb()
    .prepare(
      `SELECT id, content, importance, ts, last_used FROM memories
       WHERE subject = ? ORDER BY ts DESC LIMIT 300`
    )
    .all(String(subject));
  if (!rows.length) return [];

  const kws = keywords(query);
  const now = Date.now();
  const scored = rows.map((r) => {
    let hits = 0;
    for (const k of kws) if (r.content.includes(k)) hits++;
    const days = (now - r.ts) / 86400000;
    const recency = Math.max(0, 1 - days / 45);
    const score = hits * 2.2 + r.importance * 1.4 + recency * 0.6;
    return { ...r, hits, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // 保留：命中的 + 高重要度的，其余按分数
  const picked = [];
  const seen = new Set();
  for (const r of scored) {
    if (picked.length >= topK) break;
    if (r.hits === 0 && r.importance < 0.6) continue;
    const norm = r.content.replace(/\s+/g, '');
    if (seen.has(norm)) continue;
    seen.add(norm);
    picked.push(r);
  }
  // 万一一条都没有，给最接近的几条
  if (!picked.length) picked.push(...scored.slice(0, Math.min(2, topK)));

  const touch = getDb().prepare('UPDATE memories SET last_used = ? WHERE id = ?');
  for (const r of picked) {
    try {
      touch.run(now, r.id);
    } catch {
      /* ignore */
    }
  }
  return picked.map((r) => ({ id: r.id, content: r.content, importance: r.importance }));
}

export function memoryCount(subject) {
  const r = getDb()
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE subject = ?')
    .get(String(subject));
  return Number(r?.n || 0);
}

// ---------- users ----------

export function getUser(userId) {
  return getDb().prepare('SELECT * FROM users WHERE user_id = ?').get(String(userId)) || null;
}

export function upsertUser({ userId, nick, initialFavor = 30 }) {
  const now = Date.now();
  const existing = getUser(userId);
  if (existing) {
    if (nick && nick !== existing.nick) {
      getDb().prepare('UPDATE users SET nick = ?, last_seen = ? WHERE user_id = ?').run(nick, now, String(userId));
      existing.nick = nick;
    } else {
      getDb().prepare('UPDATE users SET last_seen = ? WHERE user_id = ?').run(now, String(userId));
    }
    return getUser(userId);
  }
  getDb()
    .prepare(
      `INSERT INTO users (user_id, nick, favor, mood, mood_intensity, turns, first_seen, last_seen)
       VALUES (?, ?, ?, '平静', 0.3, 0, ?, ?)`
    )
    .run(String(userId), nick || null, initialFavor, now, now);
  return getUser(userId);
}

export function updateUserState(userId, { favorDelta = 0, mood, moodIntensity, note } = {}) {
  return tx((db) => {
    const u = db.prepare('SELECT * FROM users WHERE user_id = ?').get(String(userId));
    if (!u) return null;
    const favor = Math.max(0, Math.min(100, Number(u.favor) + Number(favorDelta || 0)));
    const nextMood = mood || u.mood;
    const nextIntensity =
      moodIntensity == null ? u.mood_intensity : Math.max(0, Math.min(1, Number(moodIntensity)));
    const nextNote = note ? String(note).slice(0, 120) : u.last_note;
    db.prepare(
      `UPDATE users SET favor = ?, mood = ?, mood_intensity = ?, turns = turns + 1,
       last_note = ?, last_seen = ? WHERE user_id = ?`
    ).run(favor, nextMood, nextIntensity, nextNote, Date.now(), String(userId));
    return db.prepare('SELECT * FROM users WHERE user_id = ?').get(String(userId));
  });
}

export function topUsers(limit = 10) {
  return getDb()
    .prepare('SELECT user_id, nick, favor, turns FROM users ORDER BY favor DESC LIMIT ?')
    .all(limit);
}

// ---------- groups ----------

export function upsertGroup({ groupId, name, meta }) {
  const now = Date.now();
  const existing = getDb().prepare('SELECT * FROM groups WHERE group_id = ?').get(String(groupId));
  if (existing) {
    getDb()
      .prepare('UPDATE groups SET name = COALESCE(?, name), last_active = ?, meta = COALESCE(?, meta) WHERE group_id = ?')
      .run(name || null, now, meta ? JSON.stringify(meta) : null, String(groupId));
    return;
  }
  getDb()
    .prepare('INSERT INTO groups (group_id, name, last_active, meta) VALUES (?, ?, ?, ?)')
    .run(String(groupId), name || null, now, meta ? JSON.stringify(meta) : null);
}

export function touchGroup(groupId, name) {
  try {
    upsertGroup({ groupId, name });
  } catch (err) {
    log.debug(`更新群信息失败：${err.message}`);
  }
}

export function allGroups() {
  return getDb().prepare('SELECT * FROM groups ORDER BY last_active DESC').all();
}

// ---------- kv / proactive ----------

export function kvGet(key, fallback = null) {
  const r = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(String(key));
  if (!r) return fallback;
  try {
    return JSON.parse(r.value);
  } catch {
    return r.value;
  }
}

export function kvSet(key, value) {
  getDb()
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(String(key), JSON.stringify(value));
}

export function logProactive(scope) {
  getDb().prepare('INSERT INTO proactive_log (scope, ts) VALUES (?, ?)').run(String(scope), Date.now());
}

export function proactiveCountSince(scope, sinceTs) {
  const r = getDb()
    .prepare('SELECT COUNT(*) AS n FROM proactive_log WHERE scope = ? AND ts >= ?')
    .get(String(scope), sinceTs);
  return Number(r?.n || 0);
}

export function lastProactiveAt(scope) {
  const r = getDb()
    .prepare('SELECT ts FROM proactive_log WHERE scope = ? ORDER BY ts DESC LIMIT 1')
    .get(String(scope));
  return r ? Number(r.ts) : 0;
}
