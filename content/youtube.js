// ClearSky 双语翻译 — YouTube 双语字幕
// 流程：yt-hook.js 拦截播放器字幕数据 → 解析/断句 → 分批翻译（当前播放位置优先）→ 自绘双语字幕层
(() => {
  if (window.__cstYtLoaded) return;
  window.__cstYtLoaded = true;

  const CST = globalThis.CST;
  const Subs = globalThis.CSTSubs;

  let settings = null;
  let track = null; // { videoId, lang, key, cues: [{start,end,text,tr}], needTranslate, chunks, done }
  let overlay = null;
  let origEl = null;
  let transEl = null;
  let player = null;
  let video = null;
  let rafId = 0;
  let lastIdx = -2;
  let autoCCDoneFor = '';
  let token = 0;
  let mode = '';

  const currentVideoId = () => {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(shorts|live)\/([\w-]+)/);
    return m ? m[2] : null;
  };

  // 插件被更新/重新加载后旧脚本失效：收起双语字幕层，恢复原生字幕，停止工作
  const contextLost = (e) => !chrome.runtime?.id || /context invalidated/i.test(String(e && e.message || e));
  let dead = false;
  function shutdown() {
    if (dead) return;
    dead = true;
    token++;
    if (rafId) cancelAnimationFrame(rafId);
    if (player) player.classList.remove('cst-yt-on', 'cst-yt-live');
    if (overlay) overlay.remove();
    console.info('[ClearSky] 插件已更新，刷新页面后双语字幕恢复');
  }

  // ---------- 接收字幕数据 ----------
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'cst-yt' || e.data.type !== 'timedtext') return;
    if (!settings || !settings.youtube.enabled) return;
    handleTimedtext(e.data.url, e.data.body);
  });

  function handleTimedtext(url, body) {
    let u;
    try { u = new URL(url, location.origin); } catch (_) { return; }
    const vid = u.searchParams.get('v');
    const cur = currentVideoId();
    if (!vid || !cur || vid !== cur) return; // 首页预览等其它视频的字幕忽略
    const lang = u.searchParams.get('tlang') || u.searchParams.get('lang') || '';
    const kind = u.searchParams.get('kind') || '';
    const key = `${vid}|${lang}|${kind}|${settings.targetLang}`;
    if (track && track.key === key && track.cues.length) return;

    let parsed;
    try { parsed = Subs.parseTimedtext(body); } catch (err) { console.warn('[ClearSky] 字幕解析失败', err); return; }
    if (!parsed.cues.length) return;

    token++;
    track = {
      videoId: vid,
      lang,
      key,
      cues: parsed.cues.map((c) => ({ ...c, tr: null })),
      needTranslate: !Subs.sameLang(lang, settings.targetLang),
      chunks: [],
      busy: 0
    };
    const CH = 40;
    for (let i = 0; i < track.cues.length; i += CH) track.chunks.push({ from: i, to: Math.min(i + CH, track.cues.length), state: 'todo' });
    lastIdx = -2;
    ensureOverlay();
    if (track.needTranslate) pumpTranslation();
  }

  // ---------- 翻译调度：先翻当前位置附近 ----------
  function pumpTranslation() {
    if (!track || !track.needTranslate) return;
    const t = token;
    const ms = video ? video.currentTime * 1000 : 0;
    while (track.busy < 2) {
      const chunk = pickChunk(ms);
      if (!chunk) return;
      chunk.state = 'busy';
      track.busy++;
      translateChunk(chunk, t).finally(() => {
        if (t !== token) return;
        track.busy--;
        pumpTranslation();
      });
    }
  }

  function pickChunk(ms) {
    const cues = track.cues;
    let idx = Subs.findCue(cues, ms);
    if (idx < 0) { idx = cues.findIndex((c) => c.start >= ms); if (idx < 0) idx = cues.length - 1; }
    const ci = Math.max(0, track.chunks.findIndex((c) => idx >= c.from && idx < c.to));
    // 当前块 → 后面的块 → 前面的块
    const order = [];
    for (let i = ci; i < track.chunks.length; i++) order.push(track.chunks[i]);
    for (let i = ci - 1; i >= 0; i--) order.push(track.chunks[i]);
    return order.find((c) => c.state === 'todo');
  }

  async function translateChunk(chunk, t) {
    const cues = track.cues.slice(chunk.from, chunk.to);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'translate', kind: 'subtitle', texts: cues.map((c) => c.text) });
      if (t !== token) return;
      if (!res || !res.ok) throw new Error(res?.error || '翻译失败');
      cues.forEach((c, i) => { c.tr = res.result[i] || ''; });
      chunk.state = 'done';
      lastIdx = -2; // 强制重绘
    } catch (e) {
      if (contextLost(e)) { shutdown(); return; }
      if (t !== token) return;
      chunk.state = 'error';
      console.warn('[ClearSky] 字幕翻译失败：', e.message || e);
      // 30 秒后允许重试
      setTimeout(() => { if (t === token && chunk.state === 'error') { chunk.state = 'todo'; pumpTranslation(); } }, 30000);
    }
  }

  // ---------- 字幕层 ----------
  function ensureOverlay() {
    player = document.querySelector('#movie_player');
    video = player && player.querySelector('video');
    if (!player || !video) { setTimeout(ensureOverlay, 500); return; }
    if (!overlay || !player.contains(overlay)) {
      overlay = document.createElement('div');
      overlay.id = 'cst-yt-overlay';
      overlay.className = 'cst-skip notranslate';
      overlay.setAttribute('translate', 'no');
      overlay.innerHTML = '<div class="cst-yt-box"><div class="cst-yt-orig"></div><div class="cst-yt-trans"></div></div>';
      origEl = overlay.querySelector('.cst-yt-orig');
      transEl = overlay.querySelector('.cst-yt-trans');
      player.appendChild(overlay);
      new ResizeObserver(applyStyle).observe(player);
      video.addEventListener('seeked', () => { lastIdx = -2; pumpTranslation(); });
    }
    applyStyle();
    startLoop();
  }

  function applyStyle() {
    if (!overlay || !player || !settings) return;
    const h = player.clientHeight || 360;
    const y = settings.youtube;
    const base = Math.max(14, Math.min(40, h * 0.042)) * (Number(y.fontScale) || 1);
    overlay.style.setProperty('--cst-size', base.toFixed(1) + 'px');
    overlay.style.setProperty('--cst-trans', y.transColor || '#FBCD08');
    overlay.style.setProperty('--cst-orig', y.origColor || '#FFFFFF');
    overlay.style.setProperty('--cst-bg', `rgba(8,8,12,${y.bgOpacity ?? 0.55})`);
    overlay.classList.toggle('cst-no-orig', !y.showOriginal);
  }

  function ccOn() {
    const btn = document.querySelector('#movie_player .ytp-subtitles-button');
    return !btn || btn.getAttribute('aria-pressed') === 'true';
  }

  function render() {
    if (dead) return;
    rafId = requestAnimationFrame(render);
    if (!overlay || !video) return;
    const vid = currentVideoId();
    const hasTrack = !!(track && track.videoId === vid);
    // 直播：字幕边播边生成，字幕文件的时间轴与播放时间对不上，统一改为实时读取播放器上的字幕再翻译
    const isLive = video.duration === Infinity || player.classList.contains('ytp-live');
    // 有字幕文件但当前时间找不到对应字幕、而播放器上正显示着字幕：同样走实时模式兜底
    const noCueNow = hasTrack && Subs.findCue(track.cues, video.currentTime * 1000) < 0 && !!readNativeCaption();
    if (settings.youtube.enabled && ccOn() && (!hasTrack || isLive || noCueNow) && renderLive()) {
      if (mode !== 'live') { mode = 'live'; console.info('[ClearSky] 字幕模式：实时读取（直播）'); }
      return;
    }
    if (mode !== 'file' && hasTrack) { mode = 'file'; console.info('[ClearSky] 字幕模式：字幕文件'); }
    player.classList.remove('cst-yt-live');
    const visible = settings.youtube.enabled && hasTrack && ccOn();
    player.classList.toggle('cst-yt-on', !!visible);
    if (!visible) { if (lastIdx !== -3) { overlay.style.display = 'none'; lastIdx = -3; } return; }

    const idx = Subs.findCue(track.cues, video.currentTime * 1000);
    if (idx === lastIdx) return;
    lastIdx = idx;
    if (idx < 0) { overlay.style.display = 'none'; return; }
    const c = track.cues[idx];
    overlay.style.display = '';
    if (!track.needTranslate) {
      origEl.textContent = c.text;
      transEl.textContent = '';
      overlay.classList.add('cst-single');
      return;
    }
    // 只显示译文模式下，译文还没到时先显示原文
    overlay.classList.toggle('cst-single', c.tr == null && !settings.youtube.showOriginal);
    origEl.textContent = c.text;
    transEl.textContent = c.tr == null ? '' : c.tr;
    transEl.classList.toggle('cst-wait', c.tr == null);
    if (c.tr == null) pumpTranslation();
  }

  // ---------- 直播字幕：实时读取播放器字幕（直播不提供字幕文件） ----------
  const live = { text: '', stableText: '', tr: '', trFor: '', timer: 0, busy: false, pending: '' };

  function readNativeCaption() {
    const segs = player.querySelectorAll('.ytp-caption-window-container .ytp-caption-segment');
    if (!segs.length) return '';
    return Subs.clean([...segs].map((s) => s.textContent).join(' '));
  }

  function renderLive() {
    const text = readNativeCaption();
    if (!text) {
      if (player.classList.contains('cst-yt-live') && live.text) { live.text = ''; overlay.style.display = 'none'; }
      return player.classList.contains('cst-yt-live');
    }
    // 字幕本身已经是目标语言（如中文直播）：不接管，直接显示原生字幕
    if (/^(zh|ja)/.test(settings.targetLang) && (text.match(/\p{Script=Han}/gu) || []).length > text.length * 0.4) {
      player.classList.remove('cst-yt-live', 'cst-yt-on');
      overlay.style.display = 'none';
      return true;
    }
    player.classList.add('cst-yt-live', 'cst-yt-on');
    lastIdx = -4;
    if (text !== live.text) {
      live.text = text;
      origEl.textContent = text;
      // 字幕停止变化约 0.6 秒，或遇到句末标点，就翻译当前这段
      clearTimeout(live.timer);
      const delay = /[.!?。！？]$/.test(text) ? 150 : 600;
      live.timer = setTimeout(() => requestLiveTranslation(text), delay);
    }
    overlay.style.display = '';
    overlay.classList.toggle('cst-single', !live.tr && !settings.youtube.showOriginal);
    transEl.textContent = live.tr;
    transEl.classList.remove('cst-wait');
    return true;
  }

  async function requestLiveTranslation(text) {
    if (live.busy) { live.pending = text; return; }
    live.busy = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'translate', kind: 'subtitle', texts: [text] });
      if (res && res.ok && res.result[0]) {
        live.tr = res.result[0];
        live.trFor = text;
        if (live.text === text || live.text.startsWith(text.slice(0, 20))) transEl.textContent = live.tr;
      }
    } catch (e) {
      if (contextLost(e)) { shutdown(); return; }
    } finally {
      live.busy = false;
      if (live.pending && live.pending !== text) { const t = live.pending; live.pending = ''; requestLiveTranslation(t); }
      else live.pending = '';
    }
  }

  function startLoop() {
    if (!rafId) rafId = requestAnimationFrame(render);
  }

  // ---------- 自动打开字幕（只点一次，尊重用户之后的选择） ----------
  // 视频本身没有字幕（CC 按钮显示“无法显示字幕”）
  const NO_CC = /无法|無法|unavailable|不可用|利用できません|사용할 수 없/i;
  function captionsUnavailable(btn) {
    if (!btn) return false;
    const label = [btn.getAttribute('data-title-no-tooltip'), btn.getAttribute('title'), btn.getAttribute('aria-label'), btn.getAttribute('data-tooltip-title')].filter(Boolean).join(' ');
    return NO_CC.test(label);
  }

  let hintFor = '';
  function showNoCaptionHint() {
    const vid = currentVideoId();
    if (!player || hintFor === vid) return;
    hintFor = vid;
    const el = document.createElement('div');
    el.className = 'cst-yt-hint cst-skip notranslate';
    el.textContent = '这个视频没有字幕，暂时无法翻译';
    player.appendChild(el);
    setTimeout(() => el.classList.add('show'), 30);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 4500);
  }

  function maybeAutoCC() {
    if (!settings.youtube.enabled) return;
    const vid = currentVideoId();
    if (!vid || autoCCDoneFor === vid) return;
    const btn = document.querySelector('#movie_player .ytp-subtitles-button');
    if (!btn || btn.style.display === 'none') return;
    if (!btn.__cstHooked) {
      btn.__cstHooked = true;
      // 用户手动点 CC 而视频没字幕时，也提示一次
      btn.addEventListener('click', () => { if (captionsUnavailable(btn)) { hintFor = ''; showNoCaptionHint(); } });
    }
    if (captionsUnavailable(btn)) { autoCCDoneFor = vid; showNoCaptionHint(); return; }
    if (settings.youtube.autoCC === false || btn.getAttribute('aria-disabled') === 'true') return;
    autoCCDoneFor = vid;
    if (btn.getAttribute('aria-pressed') === 'false') btn.click();
  }

  // ---------- SPA 页面切换 ----------
  function onNavigate() {
    const vid = currentVideoId();
    if (track && track.videoId !== vid) { track = null; token++; lastIdx = -2; }
    live.text = ''; live.tr = ''; live.trFor = ''; live.pending = '';
    if (vid) {
      ensureOverlay();
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        maybeAutoCC();
        if (autoCCDoneFor === vid || tries > 20) clearInterval(timer);
      }, 500);
      // 字幕可能在本脚本加载前就已请求过
      window.postMessage({ source: 'cst-yt-req' }, location.origin);
    }
  }
  window.addEventListener('yt-navigate-finish', onNavigate);

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'sync' || !changes.settings) return;
    const prevTarget = settings && settings.targetLang;
    settings = await CST.loadSettings();
    applyStyle();
    if (prevTarget !== settings.targetLang && track) {
      // 目标语言变了：重新翻译当前字幕
      token++;
      track.needTranslate = !Subs.sameLang(track.lang, settings.targetLang);
      track.key = track.key.replace(/\|[^|]*$/, '|' + settings.targetLang);
      track.cues.forEach((c) => { c.tr = null; });
      track.chunks.forEach((c) => { c.state = 'todo'; });
      track.busy = 0;
      lastIdx = -2;
      pumpTranslation();
    }
  });

  (async () => {
    settings = await CST.loadSettings();
    onNavigate();
  })();
})();
