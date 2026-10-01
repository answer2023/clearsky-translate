// ClearSky 双语翻译 — 网页翻译内容脚本
// 双语对照：在每个段落下方插入译文；替换原文：隐藏原文只显示译文。两种模式可随时切换，无需重新翻译。
(() => {
  if (window.__cstPageLoaded) return;
  window.__cstPageLoaded = true;

  const CST = globalThis.CST;
  const HOST = location.hostname;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA', 'INPUT',
    'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'HEAD',
    'TITLE', 'META', 'LINK', 'BR', 'HR', 'IMG', 'PICTURE', 'SOURCE', 'CST-T', 'CST-O', 'CST-FLOAT'
  ]);
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'ACRONYM', 'B', 'BDI', 'BDO', 'BIG', 'BR', 'CITE', 'DATA', 'DFN', 'EM', 'FONT', 'I', 'IMG',
    'INS', 'DEL', 'LABEL', 'MARK', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB',
    'SUP', 'TIME', 'TT', 'U', 'WBR', 'CODE', 'KBD', 'SAMP', 'VAR', 'SVG', 'PICTURE', 'SOURCE', 'ABBR', 'OUTPUT'
  ]);
  const BLOCK_SELECTOR =
    'address,article,aside,blockquote,details,dialog,dd,div,dl,dt,fieldset,figcaption,figure,footer,form,' +
    'h1,h2,h3,h4,h5,h6,header,hgroup,hr,li,main,nav,ol,p,pre,section,table,tbody,thead,tfoot,tr,td,th,ul,' +
    'video,iframe,canvas,textarea,select,button,summary,caption,menu';

  // ---------- 状态 ----------
  let settings = null;
  let active = false;
  let mode = 'bilingual';
  const state = new WeakMap(); // el -> { status: 'queued'|'pending'|'done'|'skip', orig, trans, node, wrap, retries }
  const doneSet = new Set(); // 已插入译文的元素（用于恢复/切换模式）
  let io = null;
  let mo = null;
  let queue = new Set();
  let flushTimer = null;
  let inflight = 0;
  let errorShown = false;
  let generation = 0; // 每次重新开始翻译时递增，丢弃过期结果

  // ---------- 工具 ----------
  const norm = (s) => s.replace(/[\s ]+/g, ' ').trim();

  function isOurs(node) {
    return node && node.nodeType === 1 && (node.tagName === 'CST-T' || node.tagName === 'CST-O' || node.tagName === 'CST-FLOAT');
  }

  function shouldSkipEl(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.getAttribute('translate') === 'no') return true;
    const cls = el.classList;
    if (cls && (cls.contains('notranslate') || cls.contains('cst-skip'))) return true;
    if (el.id === 'movie_player' || el.id === 'cst-yt-overlay') return true;
    if (el.getAttribute('aria-hidden') === 'true' && el.tagName !== 'SPAN') return true;
    return false;
  }

  function hasBlockChild(el) {
    for (const c of el.children) {
      if (isOurs(c)) continue;
      if (!INLINE_TAGS.has(c.tagName) && !SKIP_TAGS.has(c.tagName)) return true;
      if (c.querySelector && c.querySelector(BLOCK_SELECTOR)) return true;
    }
    return false;
  }

  function hasDirectText(el) {
    for (const n of el.childNodes) if (n.nodeType === 3 && /\p{L}/u.test(n.nodeValue)) return true;
    return false;
  }

  function targetIsCJK() {
    return /^(zh|ja|ko)/.test(settings.targetLang);
  }

  // 已经是目标语言的段落直接跳过（省钱、省时间）
  function alreadyTarget(text) {
    const t = settings.targetLang;
    const han = (text.match(/\p{Script=Han}/gu) || []).length;
    const kana = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
    const hangul = (text.match(/\p{Script=Hangul}/gu) || []).length;
    const latin = (text.match(/\p{Script=Latin}/gu) || []).length;
    const total = han + kana + hangul + latin || 1;
    if (t.startsWith('zh')) return kana === 0 && han / total > 0.5;
    if (t === 'ja') return (han + kana) / total > 0.5 && kana > 0;
    if (t === 'ko') return hangul / total > 0.5;
    // 目标为拉丁语系时：没有拉丁字母以外文字的不跳过（交给引擎判断）
    return false;
  }

  function isTranslatableText(text) {
    if (text.length < 2 || text.length > 5000) return false;
    if (!/\p{L}/u.test(text)) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(text)) return false;
    if (/^[\p{N}\p{P}\p{S}\s]+$/u.test(text)) return false;
    if (/^@?[\w.-]+$/.test(text) && text.length < 3) return false;
    return !alreadyTarget(text);
  }

  // 只有一个内联子元素（比如 <li><a>文字</a></li>）时，把译文放进内层，保证链接可点
  function resolveHost(el) {
    let host = el;
    for (let i = 0; i < 4; i++) {
      const kids = [...host.children].filter((c) => !isOurs(c));
      if (kids.length !== 1 || hasDirectText(host)) break;
      const k = kids[0];
      if (!INLINE_TAGS.has(k.tagName) || SKIP_TAGS.has(k.tagName)) break;
      if (norm(k.textContent) !== norm(host.textContent)) break;
      host = k;
    }
    return host;
  }

  function extractText(el) {
    // 克隆后去掉我们插入的节点与不可翻译的内容
    const clone = el.cloneNode(true);
    clone.querySelectorAll('cst-t,script,style,noscript,code[class*="language"],svg,.notranslate,[translate="no"]').forEach((n) => n.remove());
    clone.querySelectorAll('cst-o').forEach((n) => n.replaceWith(...n.childNodes));
    clone.querySelectorAll('br').forEach((n) => n.replaceWith(' '));
    return norm(clone.textContent || '');
  }

  // ---------- 扫描段落 ----------
  function collect(root, out) {
    if (!root || root.nodeType !== 1 || isOurs(root) || shouldSkipEl(root)) return;
    const st = state.get(root);
    if (st && st.status !== 'skip') return; // 已处理
    if (!hasBlockChild(root)) {
      // 一排链接/按钮（导航栏、标签云）：逐个翻译，不要拼成一句
      if (!hasDirectText(root)) {
        const textKids = [...root.children].filter((c) => !isOurs(c) && norm(c.textContent || ''));
        if (textKids.length >= 2 && textKids.every((c) => c.tagName === 'A' || c.tagName === 'BUTTON')) {
          for (const c of textKids) collect(c, out);
          return;
        }
      }
      const text = extractText(root);
      if (isTranslatableText(text)) out.push(root);
      return;
    }
    for (const c of root.children) collect(c, out);
    // 混合内容（直接文本 + 块级子元素）中的直接文本暂不处理
  }

  function register(el) {
    if (state.has(el) && state.get(el).status !== 'skip') return;
    state.set(el, { status: 'queued', retries: (state.get(el)?.retries || 0) });
    io.observe(el);
  }

  function scan(root) {
    const found = [];
    collect(root, found);
    found.forEach(register);
  }

  // ---------- 翻译调度 ----------
  function onIntersect(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      io.unobserve(el);
      const st = state.get(el);
      if (!st || st.status !== 'queued') continue;
      st.status = 'pending';
      queue.add(el);
    }
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 120);
  }

  async function flush() {
    flushTimer = null;
    if (!active || !queue.size) return;
    const batch = [...queue].slice(0, 40);
    batch.forEach((el) => queue.delete(el));
    if (queue.size) scheduleFlush();

    const gen = generation;
    const items = [];
    for (const el of batch) {
      if (!el.isConnected) { state.delete(el); continue; }
      const text = extractText(el);
      if (!isTranslatableText(text)) { state.set(el, { status: 'skip' }); continue; }
      items.push({ el, text });
    }
    if (!items.length) return;

    inflight++;
    updateBall();
    try {
      const res = await chrome.runtime.sendMessage({ type: 'translate', kind: 'page', texts: items.map((i) => i.text) });
      if (gen !== generation || !active) return;
      if (!res || !res.ok) throw new Error(res?.error || '翻译失败');
      items.forEach((it, i) => applyTranslation(it.el, it.text, res.result[i]));
    } catch (e) {
      // 失败的段落清除状态：重新开关翻译即可重试（避免可见区域内无限重试）
      items.forEach((it) => state.delete(it.el));
      showToast('翻译失败：' + (e.message || e));
    } finally {
      inflight--;
      updateBall();
    }
  }

  // ---------- 插入 / 替换 ----------
  function applyTranslation(el, orig, trans) {
    if (!el.isConnected) return;
    trans = (trans || '').trim();
    const st = state.get(el) || {};
    if (!trans || norm(trans).toLowerCase() === orig.toLowerCase()) {
      state.set(el, { status: 'skip' });
      return;
    }
    const host = resolveHost(el);
    const node = document.createElement('cst-t');
    node.className = 'cst-trans';
    node.setAttribute('lang', settings.targetLang);
    node.setAttribute('translate', 'no');
    node.textContent = trans;

    // 只有短的导航/按钮类文字才用行内方式；段落、标题、长文本一律另起一行
    const isHeading = /^H\d$/.test(el.tagName) || !!host.closest('h1,h2,h3,h4,h5,h6');
    const blockTag = /^(P|LI|BLOCKQUOTE|DD|DT|FIGCAPTION|TD|TH)$/.test(el.tagName);
    const inline = !isHeading && !blockTag && orig.length <= 40 && !/[.!?。！？]\s*$/.test(orig);
    node.classList.add(inline ? 'cst-inline' : 'cst-block');
    if (isHeading) node.classList.add('cst-heading');

    host.appendChild(node);
    const rec = { status: 'done', orig, trans, node, host, wrap: null, retries: st.retries || 0 };
    state.set(el, rec);
    doneSet.add(el);
    if (mode === 'replace') wrapOriginal(rec);
  }

  function wrapOriginal(rec) {
    if (rec.wrap || !rec.host.isConnected) return;
    const wrap = document.createElement('cst-o');
    wrap.className = 'cst-orig';
    const kids = [...rec.host.childNodes].filter((n) => n !== rec.node);
    rec.host.insertBefore(wrap, rec.host.firstChild);
    kids.forEach((n) => wrap.appendChild(n));
    rec.wrap = wrap;
  }

  function unwrapOriginal(rec) {
    if (!rec.wrap) return;
    const w = rec.wrap;
    if (w.parentNode) {
      while (w.firstChild) w.parentNode.insertBefore(w.firstChild, w);
      w.remove();
    }
    rec.wrap = null;
  }

  function applyModeClass() {
    const de = document.documentElement;
    de.classList.toggle('cst-active', active);
    de.classList.toggle('cst-replace', active && mode === 'replace');
    de.dataset.cstStyle = settings.page.style;
  }

  function setMode(m) {
    mode = m;
    for (const el of doneSet) {
      const rec = state.get(el);
      if (!rec || rec.status !== 'done') continue;
      if (mode === 'replace') wrapOriginal(rec); else unwrapOriginal(rec);
    }
    applyModeClass();
    updateBall();
    if (mode === 'replace') translateTitle();
    else if (window.__cstOrigTitle) document.title = window.__cstOrigTitle;
  }

  // ---------- 开关 ----------
  function start() {
    if (active) return;
    active = true;
    generation++;
    errorShown = false;
    mode = settings.page.mode;
    applyModeClass();
    io = new IntersectionObserver(onIntersect, { rootMargin: '800px 0px 800px 0px' });
    if (document.title && !window.__cstOrigTitle) window.__cstOrigTitle = document.title;
    scan(document.body);
    startMutationObserver();
    translateTitle();
    updateBall();
  }

  function stop() {
    if (!active) return;
    active = false;
    generation++;
    if (io) io.disconnect();
    if (mo) mo.disconnect();
    io = mo = null;
    queue.clear();
    for (const el of doneSet) {
      const rec = state.get(el);
      if (rec && rec.status === 'done') {
        unwrapOriginal(rec);
        rec.node && rec.node.remove();
      }
      state.delete(el);
    }
    doneSet.clear();
    document.querySelectorAll('cst-t.cst-trans').forEach((n) => n.remove());
    if (window.__cstOrigTitle) document.title = window.__cstOrigTitle;
    applyModeClass();
    updateBall();
  }

  function toggle() { active ? stop() : start(); }

  async function translateTitle() {
    const t = window.__cstOrigTitle;
    if (!t || !isTranslatableText(t) || mode !== 'replace') return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'translate', kind: 'page', texts: [t] });
      if (res?.ok && active && mode === 'replace') document.title = res.result[0];
    } catch (_) {}
  }

  // ---------- 动态内容 ----------
  function startMutationObserver() {
    const pendingRoots = new Set();
    let timer = null;
    mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && !isOurs(n)) pendingRoots.add(n);
            else if (n.nodeType === 3 && m.target.nodeType === 1 && !isOurs(m.target)) pendingRoots.add(m.target);
          }
          // 网站重新渲染把我们的译文删掉了：重新排队（有次数上限，防止死循环）
          for (const n of m.removedNodes) {
            if (n.nodeType === 1 && n.tagName === 'CST-T') {
              for (const el of doneSet) {
                const rec = state.get(el);
                if (rec && rec.node === n && el.isConnected && rec.retries < 3) {
                  doneSet.delete(el);
                  state.set(el, { status: 'skip', retries: rec.retries + 1 });
                  pendingRoots.add(el);
                }
              }
            }
          }
        } else if (m.type === 'characterData') {
          const p = m.target.parentElement;
          if (p && !p.closest('cst-t')) pendingRoots.add(p);
        }
      }
      if (!timer) timer = setTimeout(() => {
        timer = null;
        if (!active) return;
        for (const r of pendingRoots) {
          if (!r.isConnected) continue;
          // 文本被网站更新过的已翻译段落：去掉旧译文重新翻译
          const doneAncestor = findDoneAncestor(r);
          if (doneAncestor) {
            const rec = state.get(doneAncestor);
            const now = extractText(doneAncestor);
            if (rec && now !== rec.orig && rec.retries < 3) {
              unwrapOriginal(rec);
              rec.node && rec.node.remove();
              doneSet.delete(doneAncestor);
              state.set(doneAncestor, { status: 'skip', retries: rec.retries + 1 });
              scan(doneAncestor);
            }
            continue;
          }
          scan(r.parentElement && !hasBlockChild(r.parentElement) && r.nodeType === 1 && INLINE_TAGS.has(r.tagName) ? r.parentElement : r);
        }
        pendingRoots.clear();
      }, 400);
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function findDoneAncestor(node) {
    let n = node;
    while (n && n !== document.body) {
      const st = state.get(n);
      if (st && st.status === 'done') return n;
      n = n.parentElement;
    }
    return null;
  }

  // ---------- 悬浮按钮 & 提示 ----------
  let ballHost = null;
  let ballBtn = null;
  let toastEl = null;

  function ensureBall() {
    if (ballHost || !settings.page.floatBall || window.top !== window) return;
    ballHost = document.createElement('cst-float');
    ballHost.setAttribute('translate', 'no');
    const shadow = ballHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial;position:fixed;right:0;top:62%;z-index:2147483646;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
        .b{width:40px;height:40px;border-radius:20px 0 0 20px;background:#022A99;color:#FBCD08;border:none;cursor:pointer;
           display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:700;box-shadow:0 4px 14px rgba(2,42,153,.35);
           opacity:.55;transition:opacity .2s,width .2s;padding:0 0 0 4px}
        .b:hover,.b.on{opacity:1;width:46px}
        .b.on{background:#FBCD08;color:#022A99}
        .b.busy::after{content:"";position:absolute;width:44px;height:44px;border-radius:50%;border:2px solid transparent;border-top-color:#FBCD08;left:-2px;animation:s 1s linear infinite}
        .b.on.busy::after{border-top-color:#022A99}
        @keyframes s{to{transform:rotate(360deg)}}
        .t{position:fixed;right:56px;top:62%;max-width:320px;background:#1d1f2b;color:#fff;font-size:13px;line-height:1.5;padding:10px 14px;border-radius:10px;
           box-shadow:0 6px 24px rgba(0,0,0,.25);opacity:0;transform:translateX(8px);transition:all .25s;pointer-events:none}
        .t.show{opacity:1;transform:none}
      </style>
      <button class="b" title="ClearSky 翻译（Alt+A）">译</button>
      <div class="t"></div>`;
    ballBtn = shadow.querySelector('.b');
    toastEl = shadow.querySelector('.t');
    ballBtn.addEventListener('click', toggle);
    document.documentElement.appendChild(ballHost);
    updateBall();
  }

  function removeBall() {
    if (ballHost) ballHost.remove();
    ballHost = ballBtn = toastEl = null;
  }

  function updateBall() {
    if (!ballBtn) return;
    ballBtn.classList.toggle('on', active);
    ballBtn.classList.toggle('busy', inflight > 0);
    ballBtn.textContent = active ? (mode === 'replace' ? '文' : '双') : '译';
    ballBtn.title = active ? '点击恢复原文（Alt+A）' : '翻译此页面（Alt+A）';
  }

  let toastTimer = null;
  function showToast(text) {
    if (errorShown) return;
    errorShown = true;
    if (!toastEl) { console.warn('[ClearSky]', text); return; }
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('show'), 5000);
  }

  // ---------- 消息 ----------
  // 脚本可能刚被按需注入、设置还没读完：等设置就绪后再处理指令，避免指令执行一半
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const COMMANDS = ['togglePage', 'startPage', 'stopPage', 'setMode', 'cycleMode', 'getPageState'];

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !COMMANDS.includes(msg.type)) return;
    ready.then(() => {
      switch (msg.type) {
        case 'togglePage': toggle(); break;
        case 'startPage': start(); break;
        case 'stopPage': stop(); break;
        case 'setMode':
          if (!active) { settings.page.mode = msg.mode; start(); }
          setMode(msg.mode);
          break;
        case 'cycleMode':
          if (!active) start(); else setMode(mode === 'replace' ? 'bilingual' : 'replace');
          break;
      }
      sendResponse({ active, mode, host: HOST, done: doneSet.size });
    });
    return true;
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'sync' || !changes.settings) return;
    const prev = settings;
    settings = await CST.loadSettings();
    if (prev && prev.targetLang !== settings.targetLang && active) { stop(); start(); }
    if (settings.page.floatBall) ensureBall(); else removeBall();
    applyModeClass();
  });

  // ---------- 初始化 ----------
  (async () => {
    try {
      settings = await CST.loadSettings();
    } catch (e) {
      return;
    }
    resolveReady();
    if (location.protocol === 'chrome-extension:') return;
    ensureBall();
    if (settings.page.alwaysSites.includes(HOST)) start();
  })();
})();
