// 中文 bigram 分词 + FTS 查询串构造。
//
// SQLite 没有中文分词器，所以把文本切成 BIGRAM（相邻两字）后以空格连接存进 FTS5：
//   "今天群里在聊鸣潮" → "今天 天群 群里 里在 在聊 聊鸣 鸣潮"
// 单字、英文词与数字单独保留；标点与空白作为切分边界。
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** 把一段文本切成 token 序列（bigram + 单字/英文数字）。 */
export function tokens(text) {
  const s = String(text ?? '');
  const out = [];
  let buf = '';
  let bufIsCjk = false;

  const flush = () => {
    if (!buf) return;
    if (bufIsCjk) {
      const chars = [...buf];
      if (chars.length === 1) out.push(chars[0]);
      else for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
    } else {
      out.push(buf.toLowerCase());
    }
    buf = '';
  };

  for (const ch of s) {
    if (CJK.test(ch)) {
      if (!bufIsCjk) flush();
      bufIsCjk = true;
      buf += ch;
    } else if (/[A-Za-z0-9_]/.test(ch)) {
      if (bufIsCjk) flush();
      bufIsCjk = false;
      buf += ch;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** 写入用：去重后的 bigram 串。 */
export function toFtsText(text) {
  return [...new Set(tokens(text))].join(' ');
}

/**
 * 查询用 FTS MATCH 表达式。
 * 默认 OR（召回优先），调用方可以按命中数决定要不要再收窄。
 */
export function toFtsQuery(text) {
  const t = [...new Set(tokens(text))].slice(0, 32);
  if (!t.length) return '';
  return t.map((x) => `"${x.replace(/"/g, '')}"`).join(' OR ');
}
