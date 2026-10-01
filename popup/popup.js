// ClearSky 双语翻译 — 弹窗
const CST = globalThis.CST;
const $ = (id) => document.getElementById(id);

let settings;
let tab;
let pageState = null;

async function sendToTab(msg) {
  try { return await chrome.tabs.sendMessage(tab.id, msg); } catch (_) { return null; }
}

const isWebPage = () => /^https?:/.test(tab?.url || '');
const hostOf = () => { try { return new URL(tab.url).hostname; } catch (_) { return ''; } };

// 页面指令：交给后台按需注入翻译脚本后执行（不常驻网页）
async function command(cmd) {
  const r = await chrome.runtime.sendMessage({ type: 'pageCommand', tabId: tab.id, cmd }).catch(() => null);
  if (r && r.ok) return r.state;
  $('pageHint').hidden = false;
  $('pageHint').textContent = '这个页面不允许插件运行（如浏览器内置页、应用商店）。';
  return pageState;
}

function renderEngine(status) {
  const el = $('engine');
  if (!status || !status.ok) { el.textContent = '引擎：谷歌免费翻译'; return; }
  if (status.engine === 'google') el.textContent = '引擎：谷歌免费翻译';
  else el.textContent = `引擎：${(CST.PROVIDERS[settings.llm.provider] || {}).name || '大模型'} · ${status.model}`;
  if (status.lastError && Date.now() - status.lastError.at < 10 * 60 * 1000) {
    el.textContent += '（最近出错，已自动兜底）';
    el.title = status.lastError.message;
  }
}

function renderPage() {
  const btn = $('toggle');
  const hint = $('pageHint');
  const modeBtns = document.querySelectorAll('#mode button');
  const curMode = pageState?.mode || settings.page.mode;
  modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.mode === curMode));

  if (!pageState) {
    btn.disabled = true;
    btn.textContent = '此页面无法翻译';
    hint.hidden = false;
    hint.textContent = '浏览器内置页面（如设置页、扩展商店）不允许插件运行。';
    $('always').disabled = true;
    return;
  }
  btn.disabled = false;
  hint.hidden = true;
  btn.textContent = pageState.active ? '恢复原文' : '翻译此页面';
  btn.classList.toggle('on', pageState.active);
  $('host').textContent = pageState.host;
  $('always').checked = settings.page.alwaysSites.includes(pageState.host);
}

async function save() {
  await CST.saveSettings(settings);
}

async function init() {
  settings = await CST.loadSettings();
  const forced = Number(new URLSearchParams(location.search).get('tab')); // 仅用于开发调试/截图
  [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });

  const sel = $('targetLang');
  CST.LANGS.forEach(([code, name]) => sel.add(new Option(name, code)));
  sel.value = settings.targetLang;
  sel.addEventListener('change', async () => { settings.targetLang = sel.value; await save(); });

  $('ytEnabled').checked = settings.youtube.enabled;
  $('ytOrig').checked = settings.youtube.showOriginal;
  $('ytEnabled').addEventListener('change', async (e) => { settings.youtube.enabled = e.target.checked; await save(); });
  $('ytOrig').addEventListener('change', async (e) => { settings.youtube.showOriginal = e.target.checked; await save(); });

  // 页面里已有翻译脚本就读它的状态；还没注入时按"未翻译"显示，等用户点按钮再注入
  pageState = tab ? await sendToTab({ type: 'getPageState' }) : null;
  if (!pageState && isWebPage()) pageState = { active: false, mode: settings.page.mode, host: hostOf(), injected: false };
  renderPage();

  $('toggle').addEventListener('click', async () => {
    pageState = await command({ type: 'togglePage' });
    renderPage();
    if (pageState?.active) setTimeout(() => window.close(), 250);
  });

  document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', async () => {
    settings.page.mode = b.dataset.mode; // 记住偏好
    await save();
    if (pageState && pageState.active) pageState = await command({ type: 'setMode', mode: b.dataset.mode });
    renderPage();
  }));

  $('always').addEventListener('change', async (e) => {
    const host = pageState?.host;
    if (!host) return;
    const pattern = `*://${host}/*`;
    if (e.target.checked) {
      // 只申请当前这一个网站的权限（必须在点击事件里直接调用）
      const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
      if (!granted) {
        e.target.checked = false;
        $('pageHint').hidden = false;
        $('pageHint').textContent = '需要允许访问该网站，才能每次打开时自动翻译。';
        return;
      }
      settings.page.alwaysSites = [...new Set([...settings.page.alwaysSites, host])];
      await save();
      if (!pageState.active) { pageState = await command({ type: 'startPage' }); renderPage(); }
    } else {
      settings.page.alwaysSites = settings.page.alwaysSites.filter((h) => h !== host);
      await save();
      if (host !== 'www.youtube.com') chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
    }
  });

  const openOpts = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
  $('openOptions').addEventListener('click', openOpts);
  $('openOptions2').addEventListener('click', openOpts);

  renderEngine(await chrome.runtime.sendMessage({ type: 'getStatus' }).catch(() => null));
}

init();
