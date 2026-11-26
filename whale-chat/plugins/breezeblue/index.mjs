// 语音插件：把 BreezeBlue 的账户状态挂到插件卡上，控制台一键打开。
// 真正合成在 server 的 tts.mjs 里，这里只负责状态展示。
import { accountInfo, DEFAULT_VOICE, hasTts } from '../../tts.mjs';

let cache = { ok: false, text: '还没读账户', at: 0 };
let timer = null;

async function refresh(ctx) {
  if (!hasTts()) {
    cache = { ok: false, text: '没有 API Key（CHAT_DATA/tts-key.txt）', at: Date.now() };
    return;
  }
  const info = await accountInfo();
  if (!info) {
    cache = { ok: false, text: '账户信息读取失败', at: Date.now() };
    return;
  }
  const voice = ctx.setting('voiceId', DEFAULT_VOICE);
  const mine = info.voices.find((v) => v.id === voice);
  cache = {
    ok: true,
    text: `余额 ${Math.round(info.balance ?? 0)} · 音色 ${mine ? mine.name : voice}`,
    at: Date.now(),
  };
}

export default {
  id: 'breezeblue',
  async start(ctx) {
    await refresh(ctx).catch(() => {});
    timer = setInterval(() => { void refresh(ctx).catch(() => {}); }, 10 * 60 * 1000);
    ctx.log('语音插件就绪：' + cache.text);
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = null;
  },
  status() {
    return { ok: cache.ok, last: cache.text };
  },
};
