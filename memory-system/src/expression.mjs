// 表达层：语感统计（最近 N 条真人消息）+ 发送前清洗。
// 本层只读人格文件，永不写 readonlyPaths 下的任何东西。

const PUNCT_END = /[。！？!?…~～]/;
const PARTICLES = ['啊', '诶', '欸', '呀', '吧', '呢', '嘛', '哦', '喔', '哈', '草', '呜呜', '呜', '嗯'];
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\([^)]{1,8}\)|（[^）]{1,8}）/u;

/** 记录一条真人消息样本（bot 自己的不算）。 */
export function addSample(db, key, text, at, sampleSize = 300) {
  const t = String(text ?? '').trim();
  if (t.length < 1) return;
  db.prepare('INSERT INTO style_samples(at,key,text) VALUES (?,?,?)').run(at, key, t.slice(0, 500));
  // 只保留最近 sampleSize 条，避免库无限长
  try {
    db.exec(`DELETE FROM style_samples WHERE id NOT IN (SELECT id FROM style_samples ORDER BY at DESC LIMIT ${Number(sampleSize) || 300})`);
  } catch {}
}

/** 从最近样本算语感统计。 */
export function computeStyle(db, sampleSize = 300) {
  const rows = db.prepare('SELECT text FROM style_samples ORDER BY at DESC LIMIT ?').all(sampleSize);
  if (!rows.length) return null;
  const lens = [];
  let noPunct = 0;
  const particleHits = new Map();
  let emoji = 0;
  for (const { text } of rows) {
    const t = String(text);
    lens.push([...t].length);
    if (!PUNCT_END.test(t)) noPunct += 1;
    if (EMOJI_RE.test(t)) emoji += 1;
    for (const p of PARTICLES) if (t.includes(p)) particleHits.set(p, (particleHits.get(p) ?? 0) + 1);
  }
  lens.sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)] ?? 0;
  const particles = [...particleHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k}(${Math.round((v / rows.length) * 100)}%)`);
  return {
    n: rows.length,
    medianLen: median,
    noPunctRate: Number((noPunct / rows.length).toFixed(3)),
    emojiRate: Number((emoji / rows.length).toFixed(3)),
    particles,
  };
}

/** 语感注入块正文（约 130 字以内）。 */
export function styleInjectText(stats) {
  if (!stats || stats.n < 20) return '';
  const pct = (x) => `${Math.round(x * 100)}%`;
  const bits = [`群里真人多短句（中位 ${Math.round(stats.medianLen)} 字）`];
  if (stats.noPunctRate > 0.3) bits.push(`${pct(stats.noPunctRate)} 的句子不带句号`);
  if (stats.particles.length) bits.push(`常带「${stats.particles.join('、')}」`);
  if (stats.emojiRate > 0.2) bits.push(`约 ${pct(stats.emojiRate)} 带表情/颜文字`);
  return `【语感】${bits.join('，')}。你也照这个节奏，别写成一段话。`;
}

// ── 发送前清洗 ────────────────────────────────────────────────────────────
const BOT_PHRASES = [
  [/您好[，,]?/g, ''],
  [/请问(需要|要不要|是否)/g, '要'],
  [/建议您/g, '你'],
  [/希望对您有帮助[。！!]?/g, ''],
  [/如有(需要|问题)[，,]?[^。！？\n]*/g, ''],
  [/我(很)?乐意为您[^。！？\n]*/g, ''],
  [/作为(一个)?(AI|人工智能)[^。！？\n]*/g, ''],
  [/请问还有什么[^。！？\n]*/g, ''],
  // 最后兜底：剩下的「您」一律改成「你」（客服腔的典型残留）
  [/您/g, '你'],
];

/** 发送前清洗：压客服腔 → 短句去句号 → 合并空行 → 表情节奏 →（按心情）语气联动。 */
export function cleanup(text, cfg, mood = null) {
  const c = cfg?.expression?.cleanup ?? {};
  if (cfg?.expression?.enabled === false || c.enabled === false) return String(text ?? '');
  let s = String(text ?? '');

  if (c.antibot !== false) for (const [re, rep] of BOT_PHRASES) s = s.replace(re, rep);

  // 情绪联动（手册 §3）：生气时感叹号换句号、表情概率归零；开心时允许保留表情
  const p = Number(mood?.p ?? 0);
  if (p < -0.2) {
    s = s.replace(/[！!]/g, '。');
    s = s.replace(new RegExp(EMOJI_RE.source, 'gu'), '');
  }

  // 短句去句末句号
  const short = Number(c.dropTrailingPeriodOnShort ?? 6);
  if (short > 0) {
    s = s.split(/(?<=[。！？!?\n])/).map((seg) => {
      const body = seg.replace(/[。！？!?]$/, '');
      return [...body].length <= short ? body : seg;
    }).join('');
  }

  if (c.mergeParagraphs !== false) {
    s = s.replace(/\n{2,}/g, '\n');
  }

  if (c.emojiPacing !== false) {
    // 相邻两条内最多 1 个表情：这里只做单条内去重（跨条由桥接的发送器控制）
    const found = s.match(new RegExp(EMOJI_RE.source, 'gu')) ?? [];
    if (found.length > 1) {
      let first = true;
      s = s.replace(new RegExp(EMOJI_RE.source, 'gu'), (m) => {
        if (first) { first = false; return m; }
        return '';
      });
    }
  }

  return s.replace(/[ \t]{2,}/g, ' ').replace(/\n{2,}/g, '\n').trim();
}
