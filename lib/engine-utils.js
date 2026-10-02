// 纯函数工具：解析各引擎返回、切分批次。不依赖 chrome API，可在 Node 中单测。

/** 从大模型回复里提取 {"t":[...]} 或 [...]，条数不符返回 null */
export function parseLLMArray(content, expected) {
  if (typeof content !== 'string') return null;
  let s = content.trim();
  // 去掉 ```json 代码块与 <think> 推理段
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const candidates = [s];
  const objStart = s.indexOf('{');
  const objEnd = s.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) candidates.push(s.slice(objStart, objEnd + 1));
  const arrStart = s.indexOf('[');
  const arrEnd = s.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(s.slice(arrStart, arrEnd + 1));

  for (const c of candidates) {
    let v;
    try { v = JSON.parse(c); } catch (_) { continue; }
    let arr = null;
    if (Array.isArray(v)) arr = v;
    else if (v && typeof v === 'object') {
      if (Array.isArray(v.t)) arr = v.t;
      else {
        const firstArr = Object.values(v).find(Array.isArray);
        if (firstArr) arr = firstArr;
        else {
          // {"0": "...", "1": "..."} 形式
          const keys = Object.keys(v);
          if (keys.length && keys.every((k) => /^\d+$/.test(k))) arr = keys.sort((a, b) => a - b).map((k) => v[k]);
        }
      }
    }
    if (arr && arr.length === expected) {
      return arr.map((x) => (typeof x === 'string' ? x : x == null ? '' : typeof x === 'object' ? String(x.t ?? x.text ?? JSON.stringify(x)) : String(x)));
    }
  }
  return null;
}

/** translate_a/single?dt=t 的返回：[[["译文","原文",...],...],null,"en",...] */
export function parseGoogleSingle(data) {
  if (Array.isArray(data) && Array.isArray(data[0])) {
    return data[0].map((seg) => (Array.isArray(seg) ? seg[0] || '' : '')).join('');
  }
  if (data && Array.isArray(data.sentences)) {
    return data.sentences.map((x) => x.trans || '').join('');
  }
  throw new Error('谷歌翻译返回格式异常');
}

/** translate_a/t 批量返回：["a","b"] 或 [["a","en"],["b","en"]] */
export function parseGoogleBatch(data, expected) {
  if (!Array.isArray(data) || data.length !== expected) return null;
  const out = [];
  for (const item of data) {
    if (typeof item === 'string') out.push(item);
    else if (Array.isArray(item) && typeof item[0] === 'string') out.push(item[0]);
    else return null;
  }
  return out;
}

/** 按条数与字符数切分批次 */
export function chunkTexts(texts, maxItems, maxChars) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const t of texts) {
    if (cur.length && (cur.length >= maxItems || len + t.length > maxChars)) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(t);
    len += t.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** 微软翻译语言代码 */
export function msLang(code) {
  if (code === 'zh-CN') return 'zh-Hans';
  if (code === 'zh-TW') return 'zh-Hant';
  return code;
}

/** 微软翻译返回：[{translations:[{text,to}]}, ...]，条数不符返回 null */
export function parseMicrosoft(data, expected) {
  if (!Array.isArray(data) || data.length !== expected) return null;
  const out = [];
  for (const item of data) {
    const t = item && Array.isArray(item.translations) && item.translations[0] && item.translations[0].text;
    if (typeof t !== 'string') return null;
    out.push(t);
  }
  return out;
}
