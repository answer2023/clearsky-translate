// ClearSky 双语翻译 — 运行在 YouTube 页面主环境（MAIN world）
// 作用：拦截播放器自己发出的字幕请求（/api/timedtext），把字幕数据交给内容脚本。
// 不发起任何额外网络请求，也不修改请求内容。
(() => {
  if (window.__cstHooked) return;
  window.__cstHooked = true;

  const SRC = 'cst-yt';
  let last = null;

  const isTimedtext = (url) => typeof url === 'string' && url.includes('/api/timedtext');

  function emit(url, body) {
    if (!body) return;
    last = { url, body };
    window.postMessage({ source: SRC, type: 'timedtext', url, body }, location.origin);
  }

  // XHR
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__cstUrl = String(url); } catch (_) {}
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (isTimedtext(this.__cstUrl)) {
      this.addEventListener('load', () => {
        try {
          const t = this.responseType === '' || this.responseType === 'text' ? this.responseText
            : this.responseType === 'json' ? JSON.stringify(this.response) : null;
          emit(this.responseURL || this.__cstUrl, t);
        } catch (_) {}
      });
    }
    return XS.apply(this, arguments);
  };

  // fetch
  const F = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    const p = F.apply(this, arguments);
    if (isTimedtext(url)) {
      p.then((res) => res.clone().text().then((t) => emit(res.url || url, t))).catch(() => {});
    }
    return p;
  };

  // 内容脚本加载较晚时，可索取最近一次字幕
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'cst-yt-req') return;
    if (last) window.postMessage({ source: SRC, type: 'timedtext', url: last.url, body: last.body }, location.origin);
  });
})();
