// 本地向量：bge-m3（1024 维，int8 ONNX）via transformers.js。
//
// 为什么用 transformers.js 而不是直接 onnxruntime-node：
// bge-m3 用的是 XLM-R 的 sentencepiece 分词器，纯 JS 手写不现实；
// transformers.js 自带 tokenizer.json 解析 + ONNX 前向，一步到位。
//
// 本机没有 N 卡，走 CPU int8：单条约 0.2~0.8s。所以：
//   · 查询侧有 LRU 缓存（同一句话只编码一次）
//   · 写入侧批量编码
//   · 服务启动时后台预热，避免第一条请求卡住
import path from 'node:path';
import fs from 'node:fs';

const MODEL = process.env.BILI_EMBED_MODEL || 'Xenova/bge-m3';
let extractor = null;
let loading = null;
let lastError = null;
const cache = new Map(); // text -> Float32Array
const CACHE_MAX = 500;

export function embedStatus() {
  return { ready: !!extractor, loading: !!loading, model: MODEL, error: lastError, cache: cache.size };
}

export async function loadEmbedder(cfg) {
  if (extractor) return extractor;
  if (loading) return loading;
  loading = (async () => {
    const { env, pipeline } = await import('@xenova/transformers');
    // 中国大陆直连 huggingface.co 会超时，默认走镜像；可用 HF_ENDPOINT 覆盖。
    env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com';
    env.remotePathTemplate = '{model}/resolve/{revision}/';
    env.allowRemoteModels = true;
    env.allowLocalModels = true;
    const dir = path.join(cfg.system.dataRoot, 'memory', 'models');
    fs.mkdirSync(dir, { recursive: true });
    env.cacheDir = dir;
    // int8 量化版：体积约为 fp32 的 1/4，CPU 上快 3~5 倍
    extractor = await pipeline('feature-extraction', MODEL, { quantized: true });
    lastError = null;
    return extractor;
  })().catch((error) => {
    lastError = String(error?.message ?? error);
    loading = null;
    throw error;
  });
  return loading;
}

/** 编码一段文本 → 1024 维归一化向量。失败返回 null（调用方退化为 bigram 相似度）。 */
export async function embedText(cfg, text) {
  const key = String(text ?? '').slice(0, 500);
  if (!key.trim()) return null;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const ex = await loadEmbedder(cfg);
    // bge-m3 官方用 CLS 池化；实测 CLS 的近/远区分度（0.208）优于 mean（0.160）。
    const out = await ex(key, { pooling: 'cls', normalize: true });
    const vec = Float32Array.from(out.data);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, vec);
    return vec;
  } catch (error) {
    lastError = String(error?.message ?? error);
    return null;
  }
}

/** 后台预热（不阻塞启动）。 */
export function warmup(cfg) {
  loadEmbedder(cfg).then(() => embedText(cfg, '预热')).catch(() => {});
}
