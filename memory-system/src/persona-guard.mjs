// 人格防线：快照 / 校验 / 看门狗。
//
// 唯一职责：证明「人格正文没被动过」。
// 本模块**只读**人格文件；任何写操作都只发生在 backups/ 下。
//
// 2026-10-31 修：原来把三类文件混在一个哈希集合里，导致
//   · 改一句 preset 说明     → 报"人格被改动"
//   · 重新生成 patch          → 再报一次
//   · DSH 重启重写 profile    → 又报一次
// 于是"三处改动"里有 0 处是人格正文。现在按性质分层：
//   persona  权威人格（fail-closed：一变就失败）
//   derived  由 persona 生成的产物（信息性，不算失败）
//   infra    基础设施（MCP 挂载、模型表、插件清单；信息性）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 权威人格：人物卡 + preset 源文件。这些一变，就是真的动了人格。
 *  路径由 config.json 的 persona.targets.persona 提供（可以是目录，也可以是单文件）。 */
const PERSONA_TARGETS = [];

/** 派生文件：由上面的源文件生成，改了源就会跟着变，不该单独报警。 */
const DERIVED_TARGETS = [];

/** 基础设施：运行配置，和人格无关。 */
const INFRA_TARGETS = [];

/** 从配置里取某一层要守的路径；没配就是空（什么都不守，也不报错）。 */
const targetsOf = (cfg, kind) => (cfg?.persona?.targets?.[kind] ?? []).filter(Boolean);

// 运行时噪音（日志、市场缓存、会话状态）一律跳过。
const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh-market', 'logs', 'log', 'cache', 'sessions', 'state', '.cache', 'tmp']);
const SKIP_FILES = /\.(log|ndjson|tmp|lock|bak)$/i;

function walk(p, out = []) {
  let st;
  try { st = fs.statSync(p); } catch { return out; }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) {
      if (SKIP_DIRS.has(name)) continue;
      walk(path.join(p, name), out);
    }
  } else if (!SKIP_FILES.test(path.basename(p))) {
    out.push(p);
  }
  return out;
}

export function hashFiles(paths) {
  const map = {};
  for (const p of paths) {
    for (const file of walk(p)) {
      try {
        const buf = fs.readFileSync(file);
        map[file] = { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
      } catch {}
    }
  }
  return map;
}

function baselineFile(cfg) {
  return path.join(cfg.system.dataRoot, 'backups', 'persona-baseline.json');
}

/** 建立基线（三类分开存）。 */
export function snapshot(cfg) {
  const out = {
    at: new Date().toISOString(),
    persona: hashFiles(targetsOf(cfg, 'persona')),
    derived: hashFiles(targetsOf(cfg, 'derived')),
    infra: hashFiles(targetsOf(cfg, 'infra')),
  };
  fs.mkdirSync(path.dirname(baselineFile(cfg)), { recursive: true });
  fs.writeFileSync(baselineFile(cfg), JSON.stringify(out, null, 2), 'utf8');
  return {
    file: baselineFile(cfg),
    count: Object.keys(out.persona).length,
    derived: Object.keys(out.derived).length,
    infra: Object.keys(out.infra).length,
  };
}

function diff(base = {}, nowMap = {}) {
  const changed = [], added = [], removed = [];
  for (const [f, v] of Object.entries(base)) {
    if (!nowMap[f]) removed.push(f);
    else if (nowMap[f].sha256 !== v.sha256) changed.push(f);
  }
  for (const f of Object.keys(nowMap)) if (!base[f]) added.push(f);
  return { changed, added, removed };
}

/** 校验。**只有 persona 变化才算失败**；derived / infra 只做信息性报告。 */
export function verify(cfg) {
  const bf = baselineFile(cfg);
  if (!fs.existsSync(bf)) return { ok: false, reason: '还没有基线，先跑 persona-guard snapshot' };
  const base = JSON.parse(fs.readFileSync(bf, 'utf8'));

  // 兼容旧基线（只有一个 files 字段）：当时全混在一起，按 persona 处理
  const legacy = !base.persona && base.files;
  const personaBase = legacy ? base.files : base.persona ?? {};
  const derivedBase = legacy ? {} : base.derived ?? {};
  const infraBase = legacy ? {} : base.infra ?? {};

  const p = diff(personaBase, hashFiles(targetsOf(cfg, 'persona')));
  const d = legacy ? { changed: [], added: [], removed: [] } : diff(derivedBase, hashFiles(targetsOf(cfg, 'derived')));
  const i = legacy ? { changed: [], added: [], removed: [] } : diff(infraBase, hashFiles(targetsOf(cfg, 'infra')));

  return {
    ok: p.changed.length === 0 && p.removed.length === 0,
    at: new Date().toISOString(),
    changed: p.changed, removed: p.removed, added: p.added,
    derived: d,
    infra: i,
  };
}

/** 人读的一行摘要。 */
export function summarize(result) {
  if (result.reason) return `❌ ${result.reason}`;
  const cnt = (x) => (x?.changed?.length ?? 0) + (x?.added?.length ?? 0) + (x?.removed?.length ?? 0);
  const extra = [];
  if (cnt(result.derived)) extra.push(`派生文件 ${cnt(result.derived)} 项变化（正常）`);
  if (cnt(result.infra)) extra.push(`基础设施 ${cnt(result.infra)} 项变化（正常）`);
  const tail = extra.length ? `；${extra.join('，')}` : '';
  if (result.ok) return `✅ 人格正文未被改动（${result.at}）${tail}`;
  const parts = [];
  if (result.changed?.length) parts.push(`改动 ${result.changed.length}：${result.changed.slice(0, 3).join(', ')}`);
  if (result.removed?.length) parts.push(`删除 ${result.removed.length}：${result.removed.slice(0, 3).join(', ')}`);
  return `❌ 人格正文被动过 —— ${parts.join('；')}`;
}
