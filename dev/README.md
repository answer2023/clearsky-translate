# ClearSky 双语翻译（Chrome 插件 · Manifest V3）

网页双语对照 / 仅显示译文（可切换）+ YouTube 双语字幕。翻译引擎：OpenAI 兼容大模型接口（DeepSeek、通义千问、Kimi、智谱、OpenAI、OpenRouter、自定义），未配置时自动使用谷歌免费接口兜底。

## 本地安装试用
1. 解压 `clearsky-translate-1.0.0.zip`
2. Chrome 打开 `chrome://extensions`，右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择解压出来的文件夹
4. 安装后会自动打开设置页；不填 API Key 也可直接用

## 使用
- 网页：点工具栏图标 → 翻译此页面；或 `Alt+A`；或右键菜单；或页面右侧悬浮按钮
- 视频：打开 YouTube 视频，字幕会自动打开并变成双语

## 目录结构
| 文件 | 作用 |
|---|---|
| manifest.json | 插件清单 |
| background.js | 后台：引擎调度、批量切分、并发、缓存、右键菜单、快捷键 |
| lib/engine-utils.js | 各引擎返回解析（可单测） |
| lib/subs.js | 字幕解析与自动字幕断句（可单测） |
| lib/defaults.js | 默认设置、服务商预设、语言列表 |
| content/page.js / page.css | 网页翻译 |
| content/yt-hook.js | 页面主环境中拦截播放器字幕数据 |
| content/youtube.js / youtube.css | 双语字幕层 |
| popup/、options/ | 弹窗与设置页 |
| privacy.html | 隐私政策 |

## 开发文件（dev/，不会打进上架包）
| 路径 | 内容 |
|---|---|
| dev/tests/ | 单元测试、端到端测试、本地模拟大模型服务 |
| dev/design/ | 图标源文件与渲染脚本、截图合成脚本、原始截图 |
| dev/store/ | 商店截图、宣传图、上架指南 |
| dev/build.sh | 生成上架 zip 到 dev/dist/ |

```
node dev/tests/unit.test.mjs      # 17 项单元测试
python3 dev/tests/e2e.py          # 28 项端到端测试（需要 Playwright + Chromium）
bash dev/build.sh                 # 打包上架用 zip
```

> 注意：Chrome 不允许插件目录里出现以下划线开头的文件夹（_locales 除外），所以开发目录命名为 dev。
