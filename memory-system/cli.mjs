#!/usr/bin/env node
// dsh-memory 命令行入口。
//
//   node cli.mjs init            初始化目录/表/兴趣池
//   node cli.mjs serve          启动记忆服务（127.0.0.1:7331）
//   node cli.mjs life [--minutes N]   生活层独立进程
//   node cli.mjs doctor          一屏看全状态（含人格校验）
//   node cli.mjs snapshot|verify 人格快照 / 校验
//   node cli.mjs memory add "文本" --kind=fact --importance=0.7
//   node cli.mjs memory list [--kind=episode] [--n 20]
//   node cli.mjs memory search "关键词"
//   node cli.mjs inject "查询文本"     看看这一轮会注入什么
//   node cli.mjs eval                  跑评估集
//   node cli.mjs maintain              归档/清理/上限
//   node cli.mjs backup               备份 DB
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, openDb, ensureDirs, now } from './src/db.mjs';
import { remember, maintain } from './src/memory.mjs';
import { search } from './src/scoring.mjs';
import { buildInjection } from './src/recall.mjs';
import { loadState, injectText } from './src/emotion.mjs';
import { computeStyle } from './src/expression.mjs';
import { seedInterests, pickActivity, finishActivity } from './src/life.mjs';
import { snapshot, verify, summarize } from './src/persona-guard.mjs';
import { healthCheck, evaluate } from './src/feedback.mjs';
import { transcribeFile } from './src/transcribe.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'doctor';
const flag = (name, def = null) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  const i = argv.indexOf(hit);
  return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
};
const positionals = argv.slice(1).filter((a) => !a.startsWith('--') && !/^--/.test(a));

const cfg = loadConfig();
ensureDirs(cfg);

function open() { return openDb(cfg); }

async function printDoctor(db) {
  const pv = verify(cfg);
  const counts = Object.fromEntries(
    db.prepare("SELECT kind, COUNT(*) AS c FROM memories WHERE status IN ('active','conflict') GROUP BY kind").all().map((r) => [r.kind, r.c])
  );
  const st = loadState(db, cfg);
  const style = computeStyle(db, Number(cfg.expression?.style?.sampleSize ?? 300));
  console.log('══════ dsh-memory 状态 ══════');
  console.log('数据根      :', cfg.system.dataRoot);
  console.log('总开关      :', cfg.system.enabled === false ? '关闭' : '开启');
  console.log('分层开关    :', JSON.stringify({
    memory: cfg.memory?.enabled !== false, emotion: cfg.emotion?.enabled !== false,
    life: cfg.life?.enabled !== false, expression: cfg.expression?.enabled !== false,
    feedback: cfg.feedback?.enabled !== false,
  }));
  console.log('嵌入模式    :', cfg.memory?.embed?.mode ?? 'off');
  console.log('记忆计数    :', JSON.stringify(counts), '| 总条数:', Object.values(counts).reduce((a, b) => a + b, 0));
  console.log('情绪        :', `P=${st.p.toFixed(2)} A=${st.a.toFixed(2)} D=${st.d.toFixed(2)}`, JSON.stringify(st.labels));
  console.log('语感样本    :', style ? `${style.n} 条，中位 ${style.medianLen} 字，无标点 ${(style.noPunctRate * 100).toFixed(0)}%，语气词 ${style.particles.join('/')}` : '不足');
  console.log('人格校验    :', summarize(pv));
  console.log('注入预览    :');
  const inj = await buildInjection(db, cfg, { key: 'doctor', query: '你好 日记 群友' });
  console.log((inj.text || '（本轮无注入）').split('\n').map((l) => '  ' + l).join('\n'));
}

async function main() {
  if (cmd === 'init') {
    const db = open();
    seedInterests(db);
    const s = snapshot(cfg);
    console.log('✅ 初始化完成');
    console.log('  数据根:', cfg.system.dataRoot);
    console.log('  数据库:', path.join(cfg.system.dataRoot, 'memory', 'memory.db'));
    console.log('  人格基线:', s.file, `（${s.count} 个文件）`);
    return;
  }

  if (cmd === 'serve') {
    await import('./src/server.mjs');
    return;
  }

  if (cmd === 'life') {
    const minutes = Number(flag('minutes', 30));
    const db = open();
    const tick = () => {
      const at = now();
      const pick = pickActivity(db, cfg, at);
      finishActivity(db, cfg, pick, at);
      console.log(`[life] ${new Date(at).toLocaleTimeString('zh-CN')} ${pick.activity}${pick.interest ? `（${pick.interest}）` : ''}`);
    };
    tick();
    setInterval(tick, Math.max(1, minutes) * 60000);
    console.log(`[life] 生活层已启动，每 ${minutes} 分钟一次`);
    return;
  }

  if (cmd === 'snapshot') {
    const s = snapshot(cfg);
    console.log(`✅ 人格基线已写入 ${s.file}（${s.count} 个文件）`);
    return;
  }

  if (cmd === 'verify') {
    const r = verify(cfg);
    console.log(summarize(r));
    if (!r.ok) process.exitCode = 2;
    return;
  }

  if (cmd === 'memory') {
    const sub = positionals[0];
    const db = open();
    if (sub === 'add') {
      const text = positionals[1];
      if (!text) { console.error('用法: memory add "文本" --kind=fact --importance=0.7'); process.exitCode = 1; return; }
      const r = remember(db, cfg, {
        kind: String(flag('kind', 'fact')),
        text,
        importance: Number(flag('importance', 0.6)),
        valence: Number(flag('valence', 0)),
        source: String(flag('source', 'cli')),
        visibility: String(flag('visibility', 'private')),
      });
      console.log(JSON.stringify(r));
      return;
    }
    if (sub === 'list') {
      const n = Number(flag('n', 20));
      const kind = flag('kind', null);
      const rows = kind
        ? db.prepare('SELECT id,kind,importance,status,created_at,text FROM memories WHERE kind=? ORDER BY created_at DESC LIMIT ?').all(kind, n)
        : db.prepare('SELECT id,kind,importance,status,created_at,text FROM memories ORDER BY created_at DESC LIMIT ?').all(n);
      for (const r of rows) console.log(`${new Date(r.created_at).toLocaleString('zh-CN')} [${r.kind}/${r.status}] imp=${Number(r.importance).toFixed(2)} ${r.text.slice(0, 60)}`);
      console.log(`共 ${rows.length} 条`);
      return;
    }
    if (sub === 'search') {
      const q = positionals[1] ?? '';
      const hits = search(db, cfg, q, { limit: 10 });
      for (const h of hits) console.log(`${(h.score).toFixed(3)} [${h.kind}] ${h.text.slice(0, 70)}`);
      if (!hits.length) console.log('（没有命中）');
      return;
    }
    console.error('用法: memory add|list|search');
    process.exitCode = 1;
    return;
  }

  if (cmd === 'inject') {
    const db = open();
    const q = positionals[0] ?? '你好 日记 群友';
    const out = await buildInjection(db, cfg, { key: 'cli', query: q });
    console.log(out.text || '（无注入）');
    console.log('\n命中 ids:', out.ids.length ? out.ids.join(', ') : '无');
    return;
  }

  if (cmd === 'eval') {
    const db = open();
    if (positionals[0] === 'seed') {
      db.exec('DELETE FROM eval_set');
      const rows = db.prepare("SELECT id, text FROM memories WHERE status='active' ORDER BY importance DESC LIMIT 40").all();
      let n = 0;
      for (const r of rows) {
        // 自检口径：查询取记忆的前 14 个字，期望命中自身。
        // 它不能替代"真实问法"评估，但能立刻发现检索链路断掉（分词/索引/打分）。
        const q = [...String(r.text)].slice(0, 14).join('').trim();
        if (q.length < 6) continue;
        db.prepare('INSERT OR REPLACE INTO eval_set(id,query,expected) VALUES (?,?,?)')
          .run(`e_${r.id}`, q, JSON.stringify([r.id]));
        n += 1;
      }
      console.log(`✅ 已生成 ${n} 条自检评估集（查询=记忆前 14 字，期望=自身）`);
      return;
    }
    const r = await evaluate(db, cfg);
    console.log(`n=${r.n} recall@1=${r.recall1.toFixed(3)} recall@3=${r.recall3.toFixed(3)} MRR=${r.mrr.toFixed(3)}`);
    if (r.note) console.log(r.note);
    return;
  }

  if (cmd === 'maintain') {
    const db = open();
    console.log(JSON.stringify(maintain(db, cfg)));
    return;
  }

  if (cmd === 'health') {
    const db = open();
    const r = healthCheck(db, cfg);
    console.log(`重复 ${r.duplicate.length} / 孤儿 ${r.orphan.length} / 僵尸 ${r.zombie.length} / 冲突 ${r.conflict.length}`);
    if (r.file) console.log('报告:', r.file);
    return;
  }

  if (cmd === 'backup') {
    const src = path.join(cfg.system.dataRoot, 'memory', 'memory.db');
    const dir = path.join(cfg.system.dataRoot, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `db-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    fs.copyFileSync(src, dest);
    console.log('✅ 备份到', dest);
    return;
  }

  if (cmd === 'transcribe') {
    const file = positionals[0];
    if (!file) { console.error('用法: transcribe <音频文件>'); process.exitCode = 1; return; }
    const r = await transcribeFile(file, { model: cfg.audio?.model });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === 'emotion') {
    const db = open();
    const st = loadState(db, cfg);
    console.log(JSON.stringify(st, null, 2));
    console.log(injectText(st));
    return;
  }

  // 默认 doctor
  await printDoctor(open());
}

main().catch((e) => { console.error('❌', e?.message ?? e); process.exitCode = 1; });
