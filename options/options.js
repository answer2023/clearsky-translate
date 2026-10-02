// ClearSky 双语翻译 — 设置页
const CST = globalThis.CST;
const $ = (id) => document.getElementById(id);
let settings;

function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!err);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

let saveTimer;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { await CST.saveSettings(settings); toast('已保存'); }, 250);
}

function seg(id, value, onPick) {
  const el = $(id);
  const paint = (v) => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  paint(value);
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { paint(b.dataset.v); onPick(b.dataset.v); }));
}

function bindSwitch(id, get, set) {
  $(id).checked = get();
  $(id).addEventListener('change', (e) => { set(e.target.checked); autosave(); refreshPreviews(); });
}

// ---------- 引擎 ----------
function fillEngine() {
  const p = $('provider');
  Object.entries(CST.PROVIDERS).forEach(([k, v]) => p.add(new Option(v.name, k)));
  p.value = settings.llm.provider in CST.PROVIDERS ? settings.llm.provider : 'custom';
  $('baseUrl').value = settings.llm.baseUrl;
  $('model').value = settings.llm.model;
  $('apiKey').value = settings.llm.apiKey;
  $('temperature').value = settings.llm.temperature;

  p.addEventListener('change', () => {
    const v = CST.PROVIDERS[p.value];
    if (p.value !== 'custom') { $('baseUrl').value = v.baseUrl; $('model').value = v.model; }
  });
  $('showKey').addEventListener('click', () => {
    const k = $('apiKey');
    k.type = k.type === 'password' ? 'text' : 'password';
    $('showKey').textContent = k.type === 'password' ? '显示' : '隐藏';
  });
  seg('engineSeg', settings.engine, (v) => { settings.engine = v; autosave(); });
  $('freeEngine').value = settings.freeEngine || 'microsoft';
  $('freeEngine').addEventListener('change', async (e) => {
    settings.freeEngine = e.target.value;
    autosave();
    await chrome.runtime.sendMessage({ type: 'clearCache' });
  });

  $('saveEngine').addEventListener('click', saveEngine);
}

async function saveEngine() {
  const r = $('testResult');
  const llm = {
    provider: $('provider').value,
    baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
    model: $('model').value.trim(),
    apiKey: $('apiKey').value.trim(),
    temperature: Math.min(1.5, Math.max(0, Number($('temperature').value) || 0.2))
  };
  r.className = 'muted';

  if (llm.apiKey && (!llm.baseUrl || !llm.model)) {
    r.className = 'err'; r.textContent = '请填写接口地址和模型名称'; return;
  }
  // 申请访问该接口域名的权限（只申请这一个域名）
  if (llm.baseUrl) {
    let origin;
    try { origin = new URL(llm.baseUrl).origin; } catch (_) { r.className = 'err'; r.textContent = '接口地址格式不正确'; return; }
    const granted = await chrome.permissions.request({ origins: [origin + '/*'] }).catch(() => false);
    if (!granted) { r.className = 'err'; r.textContent = '需要允许访问该接口域名，插件才能调用大模型'; return; }
  }
  settings.llm = llm;
  await CST.saveSettings(settings);
  await chrome.runtime.sendMessage({ type: 'clearCache' });

  if (!llm.apiKey) { r.textContent = `已保存。未填写 API Key，将使用免费翻译（${CST.FREE_ENGINES[settings.freeEngine] || '微软翻译'}优先）。`; return; }
  r.textContent = '已保存，正在测试连接…';
  $('saveEngine').disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'testLLM', llm, target: settings.targetLang });
    if (res?.ok) {
      r.className = 'ok';
      r.textContent = `连接成功：「${res.sample}」` + (res.strict ? '' : '（模型未严格按格式返回，批量翻译会自动降级处理）');
    } else {
      r.className = 'err';
      r.textContent = '连接失败：' + (res?.error || '未知错误');
    }
  } finally {
    $('saveEngine').disabled = false;
  }
}

// ---------- 网页翻译 ----------
function fillPage() {
  const sel = $('targetLang');
  CST.LANGS.forEach(([c, n]) => sel.add(new Option(n, c)));
  sel.value = settings.targetLang;
  sel.addEventListener('change', () => { settings.targetLang = sel.value; autosave(); });

  seg('modeSeg', settings.page.mode, (v) => { settings.page.mode = v; autosave(); });
  $('style').value = settings.page.style;
  $('style').addEventListener('change', (e) => { settings.page.style = e.target.value; autosave(); refreshPreviews(); });
  bindSwitch('floatBall', () => settings.page.floatBall, (v) => { settings.page.floatBall = v; });
  renderSites();
}

function renderSites() {
  const ul = $('sites');
  ul.innerHTML = '';
  if (!settings.page.alwaysSites.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '暂无';
    ul.appendChild(li);
    return;
  }
  settings.page.alwaysSites.forEach((h) => {
    const li = document.createElement('li');
    li.textContent = h;
    const b = document.createElement('button');
    b.textContent = '×';
    b.title = '移除';
    b.addEventListener('click', () => {
      settings.page.alwaysSites = settings.page.alwaysSites.filter((x) => x !== h);
      if (h !== 'www.youtube.com') chrome.permissions.remove({ origins: [`*://${h}/*`] }).catch(() => {});
      autosave();
      renderSites();
    });
    li.appendChild(b);
    ul.appendChild(li);
  });
}

// ---------- 视频字幕 ----------
const COLORS = ['#FBCD08', '#FFFFFF', '#7FD4FF', '#9BE7A8', '#FFB3C7'];

function fillVideo() {
  const y = settings.youtube;
  bindSwitch('ytEnabled', () => y.enabled, (v) => { y.enabled = v; });
  bindSwitch('ytAutoCC', () => y.autoCC !== false, (v) => { y.autoCC = v; });
  bindSwitch('ytOrig', () => y.showOriginal, (v) => { y.showOriginal = v; });
  bindSwitch('ytScaleWithPlayer', () => !!y.scaleWithPlayer, (v) => { y.scaleWithPlayer = v; });

  const range = (id, out, key, fmt) => {
    $(id).value = y[key];
    const show = () => { $(out).textContent = fmt(Number($(id).value)); };
    show();
    $(id).addEventListener('input', () => { y[key] = Number($(id).value); show(); refreshPreviews(); });
    $(id).addEventListener('change', autosave);
  };
  range('ytOrigScale', 'ytOrigScaleOut', 'origScale', (v) => Math.round(v * 100) + '%');
  range('ytTransScale', 'ytTransScaleOut', 'transScale', (v) => Math.round(v * 100) + '%');
  range('ytBg', 'ytBgOut', 'bgOpacity', (v) => Math.round(v * 100) + '%');

  const sw = $('ytColors');
  const paint = () => sw.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c.toLowerCase() === (y.transColor || '').toLowerCase()));
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.dataset.c = c;
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => { y.transColor = c; picker.value = c; paint(); refreshPreviews(); autosave(); });
    sw.appendChild(b);
  });
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = y.transColor;
  picker.title = '自定义颜色';
  picker.addEventListener('input', () => { y.transColor = picker.value; paint(); refreshPreviews(); });
  picker.addEventListener('change', autosave);
  sw.appendChild(picker);
  paint();
}

function refreshPreviews() {
  document.documentElement.dataset.cstStyle = settings.page.style;
  const y = settings.youtube;
  const p = $('ytPreview');
  p.style.setProperty('--cst-orig-size', (22 * (y.fontScale || 1) * y.origScale).toFixed(1) + 'px');
  p.style.setProperty('--cst-trans-size', (22 * (y.fontScale || 1) * y.transScale).toFixed(1) + 'px');
  p.style.setProperty('--cst-trans', y.transColor);
  p.style.setProperty('--cst-bg', `rgba(8,8,12,${y.bgOpacity})`);
  p.classList.toggle('no-orig', !y.showOriginal);
}

// ---------- 其它 ----------
async function init() {
  settings = await CST.loadSettings();
  fillEngine();
  fillPage();
  fillVideo();
  refreshPreviews();
  $('version').textContent = '版本 ' + chrome.runtime.getManifest().version;
  $('clearCache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearCache' });
    toast('译文缓存已清空');
  });
}

init();
