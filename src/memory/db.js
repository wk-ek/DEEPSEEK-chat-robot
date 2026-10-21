import { DatabaseSync } from 'node:sqlite';
import { PATHS } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,
  scope_type  TEXT NOT NULL,
  user_id     TEXT,
  group_id    TEXT,
  sender_name TEXT,
  role        TEXT NOT NULL,
  text        TEXT NOT NULL,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_scope_ts ON messages(scope, ts DESC);

CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'fact',
  content     TEXT NOT NULL,
  importance  REAL NOT NULL DEFAULT 0.5,
  ts          INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject, ts DESC);

CREATE TABLE IF NOT EXISTS users (
  user_id     TEXT PRIMARY KEY,
  nick        TEXT,
  favor       REAL NOT NULL DEFAULT 30,
  mood        TEXT NOT NULL DEFAULT '平静',
  mood_intensity REAL NOT NULL DEFAULT 0.3,
  turns       INTEGER NOT NULL DEFAULT 0,
  last_note   TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  group_id    TEXT PRIMARY KEY,
  name        TEXT,
  last_active INTEGER,
  meta        TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS proactive_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  scope    TEXT NOT NULL,
  ts       INTEGER NOT NULL
);
`;

let db = null;

export function getDb() {
  if (db) return db;
  db = new DatabaseSync(PATHS.db);
  db.exec('PRAGMA journal_mode = WAL;');
  // FULL：每次事务都 fsync 到磁盘。
  // NORMAL 在 WAL 下不保证每次落盘 —— 关窗口强杀进程时，
  // 最近写入的「当前人格」可能丢，重启就退回默认了。
  db.exec('PRAGMA synchronous = FULL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  log.info(`数据库就绪：${PATHS.db}`);
  return db;
}

export function closeDb() {
  try {
    // 把 WAL 里的内容合并回主库，确保进程退出后状态一定还在
    db?.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    /* ignore */
  }
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}

/** 包一层事务，写坏了也不留半条。 */
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      d.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}
