// 语音/音频转写：本地 faster-whisper（CPU int8）。
//
// 为什么要转写：QQ 里的语音消息本身进不了模型上下文（只有占位符），
// 但"她听过这一段"是记忆的一部分 —— 转写文本才能进 episode。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// python 解释器：装了 faster-whisper 的那个。默认走 PATH 里的 python。
const PY = process.env.DSH_PYTHON || process.env.PYTHON || 'python';
const SCRIPT = path.join(HERE, '..', 'tools', 'transcribe.py');

const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.silk', '.amr', '.aac', '.opus', '.mp4']);

// 模型放在本地目录（不再走 hf_hub：它的版本和 faster-whisper 互相打架，
// 实测 hf_hub 2.x 会报 metadata_errors；直接下 CT2 文件最稳）。
export const DEFAULT_WHISPER_MODEL = process.env.WHISPER_MODEL
  || path.join(HERE, '..', 'models', 'faster-whisper-small');

export function isAudio(file) {
  return AUDIO_EXT.has(path.extname(String(file ?? '')).toLowerCase());
}

/**
 * 转写一个音频文件。返回 { ok, text, language, duration } 或 { ok:false, error }。
 * 超时默认 5 分钟（CPU 上 small 模型约 0.15× 实时，5 分钟音频 ≈ 30 秒）。
 */
export function transcribeFile(file, { model = DEFAULT_WHISPER_MODEL, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    if (!fs.existsSync(file)) return resolve({ ok: false, error: `文件不存在: ${file}` });
    const t0 = Date.now();
    execFile(
      PY,
      [SCRIPT, file, model],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com', HF_HUB_DISABLE_XET: '1', WHISPER_CACHE: process.env.WHISPER_CACHE || path.join(HERE, '..', 'models') } },
      (error, stdout, stderr) => {
        const out = String(stdout ?? '').trim();
        const lastLine = out.split(/\r?\n/).filter(Boolean).pop() ?? '';
        try {
          const j = JSON.parse(lastLine);
          resolve({ ...j, ms: Date.now() - t0 });
        } catch {
          resolve({ ok: false, error: (String(stderr ?? '') || String(error?.message ?? '转写失败')).slice(0, 500), ms: Date.now() - t0 });
        }
      }
    );
  });
}
