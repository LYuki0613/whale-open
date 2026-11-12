// 配置加载 + SQLite 连接 + 建表迁移。
// 数据根、库文件、各层目录都在这里统一解析（支持配置里的 {dataRoot} 占位符）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CODE_ROOT = path.resolve(HERE, '..');
export const CONFIG_FILE = path.join(CODE_ROOT, 'config.json');

/** 读配置并把 {dataRoot} 占位符展开成绝对路径。 */
export function loadConfig() {
  // 没有 config.json 时按空配置跑：dataRoot 落在代码目录下的 data/。
  // 想改行为就 cp config.example.json config.json 再改。
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) {
    // 没有 config.json 是正常的（按默认值跑）；有但读不了就要喊出来，
    // 否则用户会以为配置生效了，其实全是默认值。
    if (fs.existsSync(CONFIG_FILE)) {
      console.warn('[config] config.json 解析失败，按默认值运行：' + (e?.message ?? e));
      console.warn('[config] 常见原因：BOM 头（用记事本另存为 UTF-8 会加）、中文引号、多余逗号');
    }
  }
  const dataRoot = raw.system?.dataRoot || path.join(CODE_ROOT, 'data');
  const expand = (v) => (typeof v === 'string' ? v.replaceAll('{dataRoot}', dataRoot) : v);
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'string' ? expand(v) : walk(v);
      return out;
    }
    return o;
  };
  const cfg = walk(raw);
  cfg.system = cfg.system ?? {};
  cfg.system.dataRoot = dataRoot;
  return cfg;
}

export function ensureDirs(cfg) {
  const root = cfg.system.dataRoot;
  for (const d of ['memory', 'memory/archive', 'emotion', 'life', 'life/notes/long', 'life/notes/tmp', 'expression', 'feedback', 'feedback/eval', 'feedback/reports', 'logs', 'backups']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  rid            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT    NOT NULL UNIQUE,
  kind           TEXT    NOT NULL,
  text           TEXT    NOT NULL,
  importance     REAL    NOT NULL DEFAULT 0.5,
  valence        REAL    NOT NULL DEFAULT 0,
  confidence     REAL    NOT NULL DEFAULT 0.7,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_access    INTEGER,
  access_count   INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'active',
  source         TEXT    NOT NULL,
  visibility     TEXT    NOT NULL DEFAULT 'private',
  meta           TEXT    NOT NULL DEFAULT '{}',
  embedding      BLOB,
  embed_model    TEXT,
  merged_into    TEXT,
  conflict_with  TEXT,
  CHECK (kind IN ('episode','fact','reflection','skill','lesson')),
  CHECK (status IN ('active','archived','merged','conflict','deleted')),
  CHECK (visibility IN ('private','group','public'))
);
CREATE INDEX IF NOT EXISTS idx_mem_kind_status ON memories(kind, status);
CREATE INDEX IF NOT EXISTS idx_mem_access      ON memories(last_access);
CREATE INDEX IF NOT EXISTS idx_mem_importance  ON memories(importance);

CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  bigram,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS relations (
  src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0.5, updated_at INTEGER NOT NULL,
  PRIMARY KEY (src, dst, kind)
);
CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id TEXT NOT NULL, entity_id TEXT NOT NULL, role TEXT,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE TABLE IF NOT EXISTS emotion_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  p REAL NOT NULL DEFAULT 0, a REAL NOT NULL DEFAULT 0, d REAL NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS emotion_log (
  at INTEGER PRIMARY KEY, p REAL, a REAL, d REAL, labels TEXT, trigger TEXT
);

CREATE TABLE IF NOT EXISTS style_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, key TEXT, text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS style_stats (
  at INTEGER PRIMARY KEY, n INTEGER, median_len REAL, no_punct_rate REAL,
  particles TEXT, emoji_rate REAL
);

CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, target_memory TEXT,
  quote TEXT, delta REAL, note TEXT
);

CREATE TABLE IF NOT EXISTS working_notes (
  id TEXT PRIMARY KEY, text TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS interests (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0.5,
  tags TEXT NOT NULL DEFAULT '[]', last_done INTEGER, done_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS life_log (
  at INTEGER PRIMARY KEY, activity TEXT, interest TEXT, note TEXT
);

CREATE TABLE IF NOT EXISTS msg_counters (
  key TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS last_injected (
  key TEXT PRIMARY KEY, ids TEXT NOT NULL DEFAULT '[]', at INTEGER
);

CREATE TABLE IF NOT EXISTS eval_set (id TEXT PRIMARY KEY, query TEXT NOT NULL, expected TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS eval_runs (at INTEGER PRIMARY KEY, n INTEGER, recall1 REAL, recall3 REAL, mrr REAL, cfg TEXT);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

-- 手册 §2.2：冲突单表、每日统计、实体画像字段
CREATE TABLE IF NOT EXISTS conflicts (
  a_id TEXT NOT NULL, b_id TEXT NOT NULL, reason TEXT,
  resolved INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id)
);
CREATE TABLE IF NOT EXISTS daily_stats (
  day TEXT NOT NULL, key TEXT NOT NULL, value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);

-- 本体：分体（通道）登记 + 主动分享记录
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'qq', label TEXT,
  last_seen INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS share_log (
  at INTEGER PRIMARY KEY, channel TEXT, text TEXT
);
`;

/** 给已存在的表补列（SQLite 的 ALTER TABLE ADD COLUMN 很轻，重复执行安全）。 */
function ensureColumns(db) {
  const add = (table, col, ddl) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    } catch {}
  };
  add('memories', 'arousal', 'REAL NOT NULL DEFAULT 0');
  add('memories', 'archived_at', 'INTEGER');
  // 提及频次：同一件事被反复说到 → 等级更高、忘得更慢（2026-10-31 加）
  add('memories', 'mention_count', 'INTEGER NOT NULL DEFAULT 1');
  add('memories', 'last_mention_at', 'INTEGER');
  add('entities', 'mention_count', 'INTEGER NOT NULL DEFAULT 0');
  add('entities', 'first_seen', 'INTEGER');
  add('entities', 'last_seen', 'INTEGER');
  add('entities', 'profile', "TEXT NOT NULL DEFAULT '{}'");
  add('relations', 'memory_id', 'TEXT');
  add('memory_entities', 'weight', 'REAL NOT NULL DEFAULT 0.5');
  add('working_notes', 'session_id', "TEXT NOT NULL DEFAULT ''");
  add('working_notes', 'kind', "TEXT NOT NULL DEFAULT 'note'");
  add('working_notes', 'done', 'INTEGER NOT NULL DEFAULT 0');
}

export function openDb(cfg, { readonly = false } = {}) {
  ensureDirs(cfg);
  const file = path.join(cfg.system.dataRoot, 'memory', 'memory.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  if (!readonly) {
    db.exec(SCHEMA);
    ensureColumns(db);
  }
  return db;
}

export const now = () => Date.now();
export const uid = () => `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/** meta 字段是 JSON 文本，读的时候永远别让它把调用方炸掉。 */
export function parseMeta(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}
