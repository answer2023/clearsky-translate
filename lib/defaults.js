// 共享默认设置：同时被后台（ES module 副作用导入）和内容脚本（经典脚本）使用
(function (g) {
  const PROVIDERS = {
    deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    qwen: { name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    moonshot: { name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    zhipu: { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-haiku' },
    custom: { name: '自定义（OpenAI 兼容接口）', baseUrl: '', model: '' }
  };

  const LANGS = [
    ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'],
    ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'],
    ['pt', 'Português'], ['it', 'Italiano'], ['ru', 'Русский'], ['vi', 'Tiếng Việt'],
    ['th', 'ไทย'], ['id', 'Bahasa Indonesia'], ['ar', 'العربية']
  ];

  const DEFAULTS = {
    targetLang: 'zh-CN',
    engine: 'auto', // auto：配置了大模型就用大模型，否则用免费翻译；llm：只用大模型；free：只用免费翻译
    freeEngine: 'microsoft', // 免费翻译首选：microsoft（国内可直连）| google；失败时自动换另一个
    llm: {
      provider: 'deepseek',
      baseUrl: PROVIDERS.deepseek.baseUrl,
      apiKey: '',
      model: PROVIDERS.deepseek.model,
      temperature: 0.2
    },
    page: {
      mode: 'bilingual', // bilingual 双语对照 | replace 替换原文
      style: 'plain', // plain | dashed | highlight | quote | dim
      floatBall: true,
      alwaysSites: []
    },
    youtube: {
      enabled: true,
      autoCC: true,
      showOriginal: true,
      fontScale: 1, // 旧版整体字号（保留兼容）
      origScale: 1, // 原文字号
      transScale: 1, // 译文字号
      scaleWithPlayer: false, // true：全屏时字幕跟着适度放大；默认不放大
      transColor: '#FBCD08',
      origColor: '#FFFFFF',
      bgOpacity: 0.55
    }
  };

  function deepMerge(base, over) {
    if (Array.isArray(base)) return Array.isArray(over) ? over : base;
    if (base && typeof base === 'object') {
      const out = { ...base };
      if (over && typeof over === 'object') {
        for (const k of Object.keys(over)) {
          out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
        }
      }
      return out;
    }
    return over === undefined ? base : over;
  }

  async function loadSettings() {
    const raw = await chrome.storage.sync.get('settings');
    const local = await chrome.storage.local.get('apiKey');
    const s = deepMerge(DEFAULTS, raw.settings || {});
    // API Key 只存本地，不随账号同步
    s.llm.apiKey = local.apiKey || '';
    // 旧版设置迁移：engine 'google' → 只用免费翻译 + 谷歌
    if (s.engine === 'google') { s.engine = 'free'; s.freeEngine = 'google'; }
    return s;
  }

  async function saveSettings(s) {
    const copy = JSON.parse(JSON.stringify(s));
    const key = copy.llm.apiKey || '';
    copy.llm.apiKey = '';
    await chrome.storage.sync.set({ settings: copy });
    await chrome.storage.local.set({ apiKey: key });
  }

  const FREE_ENGINES = { microsoft: '微软翻译', google: '谷歌翻译' };

  function llmConfigured(s) {
    return !!(s.llm && s.llm.apiKey && s.llm.baseUrl && s.llm.model);
  }

  function langName(code) {
    const f = LANGS.find((l) => l[0] === code);
    return f ? f[1] : code;
  }

  g.CST = { PROVIDERS, LANGS, DEFAULTS, FREE_ENGINES, deepMerge, loadSettings, saveSettings, llmConfigured, langName };
})(globalThis);
