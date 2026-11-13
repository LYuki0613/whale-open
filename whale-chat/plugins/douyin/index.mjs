// 刷抖音插件
//
// 登录过（有 edge-profile）就刷"推荐流"：拉一批 → 挑一条没看过的 → 下载 → 抽帧 →
// 让她真的"看" → 写进记忆；没登录时退回热榜（只有话题和封面）。
// 也可以手动丢一条分享链接让她看。
//
// 抖音网页有签名和风控：靠本机 Edge 渲染页面、截获它自己发的请求（dy.py）。
// 登录态存在 persistent profile 里，扫码一次（login.py），过期再扫。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HOT_URL = 'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1';

let timer = null;
let ctxRef = null;
let lastError = '';

function profileDir() {
  return ctxRef.dataDir('edge-profile');
}

function loggedIn() {
  try {
    const dir = profileDir();
    return fs.readdirSync(dir).some((f) => f === 'Default' || f === 'Local State');
  } catch { return false; }
}

async function runPy(mode, arg = '') {
  const { stdout } = await exec(ctxRef.paths.py, [path.join(ctxRef.dir, 'dy.py'), mode, arg], {
    timeout: 180_000, maxBuffer: 32 << 20, windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', DY_PROFILE: profileDir() },
  });
  return JSON.parse(String(stdout).trim() || '{}');
}

async function hotList() {
  const r = await fetch(HOT_URL, { headers: { 'user-agent': UA, referer: 'https://www.douyin.com/' } });
  const j = await r.json();
  return (j?.data?.word_list ?? []).map((x) => ({
    word: String(x.word ?? '').trim(),
    hot: Number(x.hot_value) || 0,
    videos: Number(x.video_count) || 0,
    cover: x?.word_cover?.url_list?.[0] || '',
  })).filter((x) => x.word);
}

/** 下载一条视频 → 抽帧 → 让她看 → 写记忆。 */
async function watchOne(item) {
  const ctx = ctxRef;
  const dir = ctx.dataDir('');
  const id = String(item.id);
  const mp4 = path.join(dir, `${id}.mp4`);
  const fr = path.join(dir, id);
  fs.mkdirSync(fr, { recursive: true });

  const detail = await runPy('video', id);
  if (!detail.ok) return { ok: false, error: detail.error || '拿不到播放地址', id };
  const play = detail.play;

  if (!fs.existsSync(mp4)) {
    const r = await fetch(play, { headers: { 'user-agent': UA, referer: 'https://www.douyin.com/' } });
    if (!r.ok) return { ok: false, error: '视频下载失败 ' + r.status };
    fs.writeFileSync(mp4, Buffer.from(await r.arrayBuffer()));
  }

  const frames = Number(ctx.setting('watchFrames', 6)) || 6;
  const dur = Math.max(6, Math.round((detail.duration_ms || 20000) / 1000));

  // 听：抽出音轨，本地 whisper 转写成文字（不花钱，也不上传）
  let transcript = '';
  try {
    const wav = path.join(dir, `${id}.wav`);
    await exec(ctx.paths.ffmpeg, ['-v', 'error', '-y', '-i', mp4, '-vn', '-ac', '1', '-ar', '16000', wav],
      { timeout: 60_000, windowsHide: true });
    const model = ctx.setting('whisperModel', process.env.WHISPER_MODEL || 'small');
    const { stdout } = await exec(ctx.paths.py, [path.join(ctx.dir, 'transcribe.py'), wav, model], {
      timeout: 180_000, maxBuffer: 8 << 20, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    const last = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
    const tj = JSON.parse(last);
    if (tj.ok) {
      const t = String(tj.text || '').trim();
      // 纯音乐/水印会被识别成几个字，太短就当没听到
      transcript = t.length >= 6 ? t.slice(0, 800) : '';
    }
  } catch (e) {
    ctx.log('听音频失败：' + (e?.message ?? e));
  }

  await exec(ctx.paths.ffmpeg, [
    '-v', 'error', '-y', '-i', mp4,
    '-vf', `fps=1/${Math.max(2, Math.round(dur / frames))},scale=540:-1`,
    '-q:v', '4', path.join(fr, 'f%02d.jpg'),
  ], { timeout: 120_000, windowsHide: true });

  const imgs = fs.readdirSync(fr).filter((f) => f.endsWith('.jpg')).sort()
    .map((f) => path.join(fr, f)).slice(0, frames);
  if (!imgs.length) return { ok: false, error: '抽帧失败' };

  const prompt = [
    '（你刚在抖音刷到这条视频，画面在下面。）',
    `标题：${detail.desc || '（无）'}`,
    `作者：${detail.author || '（未知）'}`,
    transcript ? `视频里说的是：${transcript}` : '（这条基本是音乐/没说话，听不出内容）',
    '看完用两三句话说说你看到了什么、听到了什么、感觉怎么样。不要复述标题，也不要说"根据画面"这种话。',
  ].join('\n');
  const said = await ctx.agentAsk(prompt, imgs);

  if (ctx.setting('rememberToMemory', true) && said) {
    await ctx.addMemory({
      kind: 'episode',
      text: `我刷到一个抖音视频（${detail.author}）：${detail.desc}${transcript ? '｜听到：' + transcript.slice(0, 80) : ''}。看的时候想的是：${said}`.slice(0, 320),
      importance: 0.45,
    });
  }

  // 只留最近 8 条，别把磁盘刷满
  try {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of all.slice(8)) fs.unlinkSync(path.join(dir, old.f));
  } catch {}

  return { ok: true, id, desc: detail.desc, author: detail.author, frames: imgs.length, said };
}

async function tick(force = false) {
  const ctx = ctxRef;
  if (!ctx) return { ok: false, error: '插件没启动' };
  const intervalH = Number(ctx.setting('intervalHours', 3)) || 3;
  const st = ctx.getState();
  const gap = Date.now() - (Number(st.lastRunAt) || 0);
  if (!force && gap < intervalH * 3600_000) {
    return { ok: false, error: '还没到点', nextInMin: Math.round((intervalH * 3600_000 - gap) / 60000) };
  }
  try {
    if (loggedIn()) {
      const feed = await runPy('feed', '12');
      const seen = new Set(st.seenIds ?? []);
      const list = (feed.items ?? []).filter((x) => !seen.has(String(x.id)));
      if (list.length) {
        // 前几条可能是图文/音乐帖，挨个试，成功一条就够
        let r = null;
        let pick = list[0];
        for (const cand of list.slice(0, 3)) {
          pick = cand;
          r = await watchOne(cand);
          if (r?.ok) break;
        }
        st.lastRunAt = Date.now();
        st.seenIds = [...new Set([...(st.seenIds ?? []), ...list.slice(0, 5).map((x) => String(x.id))])].slice(-300);
        st.lastTopics = list.slice(0, 4).map((x) => ({ word: x.desc.slice(0, 30), hot: 0, cover: x.cover }));
        st.lastWatch = r;
        ctx.setState(st);
        if (ctx.setting('rememberToMemory', true)) {
          const line = '我刷了会儿抖音，看到：' + list.slice(0, 5).map((x) => x.desc.slice(0, 20).replace(/\n/g, ' ')).join('；');
          await ctx.addMemory({ kind: 'episode', text: line, importance: 0.3 });
        }
        ctx.log(`刷推荐流，看了 ${pick.desc.slice(0, 24)}`);
        return { ok: true, mode: 'feed', watched: r, candidates: list.length };
      }
      ctx.log('推荐流里没有新视频');
      return { ok: true, mode: 'feed', watched: null, candidates: 0 };
    }

    // 没登录：只能刷热榜
    const all = await hotList();
    const seen = new Set(st.seenWords ?? []);
    const fresh = all.filter((x) => !seen.has(x.word));
    const max = Math.max(1, Number(ctx.setting('maxTopics', 4)) || 4);
    const picked = (fresh.length ? fresh : all).slice(0, max);
    st.lastRunAt = Date.now();
    st.lastTopics = picked.map((x) => ({ word: x.word, hot: x.hot, cover: x.cover }));
    st.seenWords = [...new Set([...(st.seenWords ?? []), ...picked.map((x) => x.word)])].slice(-200);
    ctx.setState(st);
    if (picked.length && ctx.setting('rememberToMemory', true)) {
      await ctx.addMemory({ kind: 'episode', text: '我刷了会儿抖音，热榜上在说：' + picked.map((x) => x.word).join('、'), importance: 0.35 });
    }
    ctx.log(`刷热榜 ${picked.length} 条`);
    return { ok: true, mode: 'hot', topics: picked };
  } catch (e) {
    lastError = String(e?.message ?? e);
    ctx.log('刷抖音失败：' + lastError);
    return { ok: false, error: lastError };
  }
}

export default {
  id: 'douyin',
  async start(ctx) {
    ctxRef = ctx;
    // 不自动刷：只有被叫到（聊天里说「刷个抖音」或点设置页按钮）才动
    ctx.log('刷抖音插件已启动' + (loggedIn() ? '（已登录）' : '（未登录，只能刷热榜）') + '｜按需触发');
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = null;
    ctxRef = null;
  },
  status() {
    const st = ctxRef?.getState() ?? {};
    return {
      lastRunAt: st.lastRunAt ?? 0,
      lastTopics: st.lastTopics ?? [],
      lastWatch: st.lastWatch ?? null,
      loggedIn: loggedIn(),
      lastError,
    };
  },
  actions: {
    tick,
    watch: async (url) => {
      const d = await runPy('video', url);
      if (!d.ok) return { ok: false, error: d.error };
      return watchOne({ id: d.id, desc: d.desc });
    },
  },
};
