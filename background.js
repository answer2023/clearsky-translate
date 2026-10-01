// ClearSky 双语翻译 — 后台服务（MV3 service worker）
// 负责：翻译引擎调度（大模型 / 谷歌免费接口）、批量切分、并发控制、缓存、右键菜单与快捷键
import './lib/defaults.js';
import { parseLLMArray, parseGoogleBatch, parseGoogleSingle, chunkTexts } from './lib/engine-utils.js';

const CST = globalThis.CST;
const GOOGLE_BASE = 'https://translate.googleapis.com';

// ---------- 缓存（LRU） ----------
const CACHE_MAX = 8000;
const cache = new Map();
function cacheGet(k) {
  if (!cache.has(k)) return undefined;
  const v = cache.get(k);
  cache.delete(k);
  cache.set(k, v);
  return v;
}
function cacheSet(k, v) {
  cache.set(k, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ---------- 并发控制 ----------
function semaphore(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const llmLimit = semaphore(4);
const googleLimit = semaphore(6);

// ---------- 设置（带短缓存） ----------
let settingsCache = null;
async function getSettings() {
  if (!settingsCache) settingsCache = await CST.loadSettings();
  return settingsCache;
}
chrome.storage.onChanged.addListener(() => { settingsCache = null; });

// ---------- 谷歌免费接口 ----------
async function googleSingle(text, tl) {
  const url = `${GOOGLE_BASE}/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&dj=0`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'q=' + encodeURIComponent(text)
  });
  if (!res.ok) throw new Error(`谷歌翻译返回 ${res.status}`);
  return parseGoogleSingle(await res.json());
}

async function googleBatch(texts, tl) {
  if (texts.length === 1) return [await googleLimit(() => googleSingle(texts[0], tl))];
  try {
    const body = texts.map((t) => 'q=' + encodeURIComponent(t)).join('&');
    const res = await googleLimit(() => fetch(
      `${GOOGLE_BASE}/translate_a/t?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&format=text`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body }
    ));
    if (!res.ok) throw new Error(`谷歌翻译返回 ${res.status}`);
    const out = parseGoogleBatch(await res.json(), texts.length);
    if (out) return out;
    throw new Error('批量结果格式异常');
  } catch (e) {
    // 批量接口不可用时逐条翻译
    return Promise.all(texts.map((t) => googleLimit(() => googleSingle(t, tl))));
  }
}

// ---------- 大模型（OpenAI 兼容接口） ----------
function systemPrompt(target, kind) {
  const lang = CST.langName(target);
  const common =
    `You are a professional translator. Translate every string in the user's JSON array into ${lang} (${target}).\n` +
    `Rules:\n- Return ONLY a JSON object of the form {"t": [...]} with exactly the same number of items in the same order.\n` +
    `- Keep numbers, URLs, code, product names and proper nouns accurate; do not add explanations.\n` +
    `- If an item is already in ${lang}, return it unchanged.\n`;
  if (kind === 'subtitle') {
    return common +
      '- The items are consecutive video subtitle lines. Use the surrounding lines as context, translate naturally and colloquially, keep each line concise.\n' +
      '- Never merge or split lines: item i of the output must correspond to item i of the input.\n';
  }
  return common + '- The items are paragraphs/headings from a web page. Produce fluent, natural, publication-quality translation.\n';
}

async function llmCall(llm, messages) {
  const base = llm.baseUrl.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify({
        model: llm.model,
        temperature: Number(llm.temperature) || 0.2,
        stream: false,
        messages
      })
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch (_) {}
      const err = new Error(`大模型接口返回 ${res.status}：${detail}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('大模型返回内容为空');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function llmBatch(texts, target, kind, llm) {
  const content = await llmLimit(() => llmCall(llm, [
    { role: 'system', content: systemPrompt(target, kind) },
    { role: 'user', content: JSON.stringify(texts) }
  ]));
  const arr = parseLLMArray(content, texts.length);
  if (arr) return arr;
  // 条数对不上：对半拆分重试，单条时用纯文本方式
  if (texts.length === 1) {
    const plain = await llmLimit(() => llmCall(llm, [
      { role: 'system', content: `Translate the user's text into ${CST.langName(target)}. Output only the translation.` },
      { role: 'user', content: texts[0] }
    ]));
    return [plain.trim()];
  }
  const mid = Math.ceil(texts.length / 2);
  const [a, b] = await Promise.all([
    llmBatch(texts.slice(0, mid), target, kind, llm),
    llmBatch(texts.slice(mid), target, kind, llm)
  ]);
  return a.concat(b);
}

// ---------- 统一入口 ----------
let lastError = null;

async function translateTexts(texts, kind = 'page') {
  const s = await getSettings();
  const target = s.targetLang;
  const useLLM = s.engine === 'llm' || (s.engine === 'auto' && CST.llmConfigured(s));
  if (s.engine === 'llm' && !CST.llmConfigured(s)) throw new Error('尚未配置大模型 API，请在设置页填写');
  const engineKey = useLLM ? `llm:${s.llm.model}` : 'google';

  const result = new Array(texts.length);
  const todo = [];
  texts.forEach((t, i) => {
    const hit = cacheGet(`${engineKey}|${target}|${kind}|${t}`);
    if (hit !== undefined) result[i] = hit; else todo.push(i);
  });
  if (!todo.length) return { result, engine: engineKey };

  const pending = todo.map((i) => texts[i]);
  const chunks = useLLM
    ? chunkTexts(pending, kind === 'subtitle' ? 60 : 30, kind === 'subtitle' ? 3500 : 2800)
    : chunkTexts(pending, 50, 4500);

  let usedEngine = engineKey;
  let offset = 0;
  const jobs = chunks.map((chunk) => {
    const start = offset;
    offset += chunk.length;
    return (async () => {
      let out;
      let eng = engineKey;
      if (useLLM) {
        try {
          out = await llmBatch(chunk, target, kind, s.llm);
        } catch (e) {
          lastError = { message: e.message, at: Date.now() };
          if (s.engine === 'llm') throw e;
          out = await googleBatch(chunk, target); // auto 模式下大模型失败时兜底
          eng = 'google';
          usedEngine = 'google(fallback)';
        }
      } else {
        out = await googleBatch(chunk, target);
      }
      out.forEach((tr, j) => {
        const idx = todo[start + j];
        result[idx] = tr;
        cacheSet(`${eng}|${target}|${kind}|${texts[idx]}`, tr);
      });
    })();
  });
  await Promise.all(jobs);
  return { result, engine: usedEngine };
}

// ---------- 消息 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'translate': {
          const texts = (msg.texts || []).map((t) => String(t));
          const r = await translateTexts(texts, msg.kind);
          return { ok: true, ...r };
        }
        case 'testLLM': {
          const llm = msg.llm;
          const content = await llmCall(llm, [
            { role: 'system', content: systemPrompt(msg.target || 'zh-CN', 'page') },
            { role: 'user', content: JSON.stringify(['Hello! The quick brown fox jumps over the lazy dog.']) }
          ]);
          const arr = parseLLMArray(content, 1);
          return { ok: true, sample: arr ? arr[0] : content.slice(0, 200), strict: !!arr };
        }
        case 'getStatus': {
          const s = await getSettings();
          return {
            ok: true,
            engine: s.engine === 'google' || (s.engine === 'auto' && !CST.llmConfigured(s)) ? 'google' : 'llm',
            model: s.llm.model,
            lastError
          };
        }
        case 'clearCache': {
          cache.clear();
          return { ok: true };
        }
        default:
          return { ok: false, error: 'unknown message' };
      }
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  })().then(sendResponse);
  return true;
});

// ---------- 右键菜单 & 快捷键 ----------
chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'cst-toggle', title: '翻译此页面 / 恢复原文', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'cst-mode', title: '切换：双语对照 ⇄ 仅译文', contexts: ['page'] });
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

function sendToTab(tabId, payload) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => {});
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'cst-toggle') sendToTab(tab?.id, { type: 'togglePage' });
  if (info.menuItemId === 'cst-mode') sendToTab(tab?.id, { type: 'cycleMode' });
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'toggle-page') return;
  const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  sendToTab(t?.id, { type: 'togglePage' });
});
