// 字幕解析与断句（纯函数，内容脚本与 Node 单测共用）
(function (g) {
  const END_PUNCT = /[.!?。！？…]["'”’)\]]?$/;
  const SOFT_PUNCT = /[,;:，；：、]$/;
  const CJK = /[぀-ヿ㐀-鿿가-힯]/;

  function decodeEntities(s) {
    return s
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }

  const clean = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

  /**
   * 把 timedtext 响应解析成统一结构：
   * { words: [{t, text}] | null, cues: [{start, end, text}] }
   * words 只在逐词自动字幕（ASR）时存在
   */
  function parseTimedtext(body) {
    body = String(body || '').trim();
    if (!body) return { cues: [], words: null };
    if (body[0] === '{') return parseJson3(JSON.parse(body));
    return parseXml(body);
  }

  function parseJson3(data) {
    const events = (data.events || []).filter((e) => e.segs && e.segs.length);
    const wordLevel = events.some((e) => e.segs.length > 1 && e.segs.some((s) => s.tOffsetMs));
    if (wordLevel) {
      const words = [];
      for (const e of events) {
        if (e.aAppend && e.segs.every((s) => !s.utf8 || !s.utf8.trim())) continue;
        for (const s of e.segs) {
          const txt = (s.utf8 || '').replace(/\n/g, ' ');
          if (!txt.trim()) continue;
          words.push({ t: (e.tStartMs || 0) + (s.tOffsetMs || 0), text: txt, evEnd: (e.tStartMs || 0) + (e.dDurationMs || 0) });
        }
      }
      return { words, cues: segmentWords(words) };
    }
    const cues = [];
    for (const e of events) {
      const text = clean(e.segs.map((s) => s.utf8 || '').join('').replace(/\n/g, ' '));
      if (!text) continue;
      const start = e.tStartMs || 0;
      cues.push({ start, end: start + (e.dDurationMs || 2000), text });
    }
    return { words: null, cues: dedupeCues(cues) };
  }

  function parseXml(xml) {
    const cues = [];
    // srv3：<p t="毫秒" d="毫秒">…</p>
    const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = pRe.exec(xml))) {
      const t = /\bt="(\d+)"/.exec(m[1]);
      const d = /\bd="(\d+)"/.exec(m[1]);
      const text = clean(m[2].replace(/<br\s*\/?>/g, ' '));
      if (!t || !text) continue;
      cues.push({ start: +t[1], end: +t[1] + (d ? +d[1] : 2000), text });
    }
    if (!cues.length) {
      // 旧格式：<text start="秒" dur="秒">…</text>
      const tRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
      while ((m = tRe.exec(xml))) {
        const s = /\bstart="([\d.]+)"/.exec(m[1]);
        const d = /\bdur="([\d.]+)"/.exec(m[1]);
        const text = clean(decodeEntities(m[2]));
        if (!s || !text) continue;
        const start = Math.round(+s[1] * 1000);
        cues.push({ start, end: start + Math.round((d ? +d[1] : 2) * 1000), text });
      }
    }
    return { words: null, cues: dedupeCues(cues) };
  }

  // 有些手动字幕会重复（滚动式），去重并修正结束时间
  function dedupeCues(cues) {
    cues.sort((a, b) => a.start - b.start);
    const out = [];
    for (const c of cues) {
      const prev = out[out.length - 1];
      if (prev && prev.text === c.text && c.start - prev.end < 500) { prev.end = Math.max(prev.end, c.end); continue; }
      out.push({ ...c });
    }
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i].end > out[i + 1].start) out[i].end = out[i + 1].start;
    }
    return out;
  }

  /** 逐词自动字幕 → 句子（按标点、停顿、长度切分） */
  function segmentWords(words, opts = {}) {
    const maxLatin = opts.maxChars || 110;
    const maxCJK = opts.maxCharsCJK || 32;
    const gapMs = opts.gapMs || 900;
    const cues = [];
    let cur = [];

    const textOf = (arr) => clean(arr.map((w) => w.text).join(arr.some((w) => /^\s/.test(w.text)) ? '' : (CJK.test(arr[0]?.text || '') ? '' : ' ')));

    const pushCur = (nextStart) => {
      if (!cur.length) return;
      const text = textOf(cur);
      if (text) {
        const last = cur[cur.length - 1];
        let end = Math.max(last.evEnd || 0, last.t + 600);
        if (nextStart != null) end = Math.min(Math.max(end, last.t + 400), nextStart);
        cues.push({ start: cur[0].t, end, text });
      }
      cur = [];
    };

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const next = words[i + 1];
      cur.push(w);
      const text = textOf(cur);
      const isCJK = CJK.test(text);
      const max = isCJK ? maxCJK : maxLatin;
      const wordCount = isCJK ? text.length / 2 : text.split(' ').length;
      const tail = w.text.trim();
      const gap = next ? next.t - w.t : Infinity;

      let cut = false;
      if (!next) cut = true;
      else if (END_PUNCT.test(tail) && wordCount >= 3) cut = true;
      else if (gap >= gapMs && wordCount >= 4) cut = true;
      else if (gap >= gapMs * 2) cut = true;
      else if (text.length >= max * 0.7 && SOFT_PUNCT.test(tail)) cut = true;
      else if (text.length >= max) cut = true;

      if (cut) pushCur(next ? next.t : null);
    }
    pushCur(null);
    return cues;
  }

  /** 二分查找当前时间对应的字幕 */
  function findCue(cues, ms) {
    let lo = 0;
    let hi = cues.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans >= 0 && ms < cues[ans].end) return ans;
    return -1;
  }

  /** YouTube 语言代码与插件目标语言是否一致 */
  function sameLang(trackLang, target) {
    if (!trackLang) return false;
    const a = trackLang.toLowerCase();
    const b = target.toLowerCase();
    if (b === 'zh-cn') return a === 'zh' || a === 'zh-cn' || a === 'zh-hans' || a === 'zh-sg';
    if (b === 'zh-tw') return a === 'zh-tw' || a === 'zh-hant' || a === 'zh-hk';
    return a.split('-')[0] === b.split('-')[0];
  }

  const api = { parseTimedtext, segmentWords, findCue, sameLang, clean };
  g.CSTSubs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
