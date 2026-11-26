// 她的声音：BreezeBlue TTS
// key 放 CHAT_DATA/tts-key.txt（或环境变量 BREEZE_API_KEY）
import fs from 'node:fs';
import path from 'node:path';

const KEY_FILE = process.env.CHAT_TTS_KEY_FILE || path.join(process.env.CHAT_DATA || '.', 'tts-key.txt');
const BASE = process.env.CHAT_TTS_BASE || 'https://api.breezeblue.ai';
export const DEFAULT_VOICE = process.env.CHAT_TTS_VOICE || 'voc_q5s9nu2j4weg'; // 鲸汐
const MODEL = process.env.CHAT_TTS_MODEL || 'breeze-tts-2';

export function ttsKey() {
  if (process.env.BREEZE_API_KEY) return process.env.BREEZE_API_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

export function hasTts() { return Boolean(ttsKey()); }

/** 把一段话合成 mp3（Buffer）。失败就抛，调用方自己决定要不要降级成纯文字。 */
export async function synthesize(text, { voiceId = DEFAULT_VOICE, timeoutMs = 30000 } = {}) {
  const key = ttsKey();
  if (!key) throw new Error('没有 BreezeBlue API Key');
  const clean = String(text ?? '').trim().slice(0, 500);
  if (!clean) throw new Error('空文本');
  const r = await fetch(`${BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text: clean, model_id: MODEL, language_code: 'zh' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error('TTS HTTP ' + r.status + (detail ? ' ' + detail.slice(0, 120) : ''));
  }
  return Buffer.from(await r.arrayBuffer());
}

/** 账户信息：余额、音色数（给插件卡用） */
export async function accountInfo() {
  const key = ttsKey();
  if (!key) return null;
  try {
    const [b, e, v] = await Promise.all([
      fetch(`${BASE}/v1/balance`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(12000) }).then((x) => x.json()).catch(() => null),
      fetch(`${BASE}/v1/entitlements`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(12000) }).then((x) => x.json()).catch(() => null),
      fetch(`${BASE}/v1/voices`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(12000) }).then((x) => x.json()).catch(() => null),
    ]);
    return {
      balance: b?.balance ?? null,
      plan: e?.plan_code ?? null,
      maxVoices: e?.saved_voice_limit ?? null,
      voices: Array.isArray(v?.voices) ? v.voices.map((x) => ({ id: x.voice_id, name: x.name })) : [],
    };
  } catch { return null; }
}

/** 试听：合成一小段，返回 mp3 Buffer */
export async function previewVoice(text = '对方，我在呢。', voiceId = DEFAULT_VOICE) {
  return synthesize(text, { voiceId });
}
