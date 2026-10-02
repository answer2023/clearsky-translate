import asyncio, json, os, shutil, subprocess, sys, time, tempfile
from playwright.async_api import async_playwright
DEV = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(DEV)  # 扩展根目录
HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(DEV, 'design', 'shots'); os.makedirs(SHOTS, exist_ok=True)
FIX = os.path.join(HERE, 'fixtures')
results = []
def check(name, cond, extra=''):
    results.append((name, bool(cond))); print(('✓' if cond else '✗'), name, extra if not cond else '')

def build_test_ext():
    d = tempfile.mkdtemp(prefix='cst-ext-')
    for item in os.listdir(ROOT):
        if item in ('dev', 'dist') or item.startswith('.'): continue
        src = os.path.join(ROOT, item)
        (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, os.path.join(d, item))
    m = json.load(open(os.path.join(d, 'manifest.json')))
    m['host_permissions'] += ['http://127.0.0.1:8787/*', '*://127.0.0.1/*']  # 测试用：相当于用户已授权（activeTab / 总是翻译）
    json.dump(m, open(os.path.join(d, 'manifest.json'), 'w'), ensure_ascii=False)
    return d

async def main():
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'mock_server.py')]); time.sleep(0.8)
    ext = build_test_ext()
    user = tempfile.mkdtemp(prefix='cst-prof-')
    try:
        async with async_playwright() as p:
            ctx = await p.chromium.launch_persistent_context(user, channel='chromium', headless=True,
                args=[f'--disable-extensions-except={ext}', f'--load-extension={ext}', '--autoplay-policy=no-user-gesture-required', '--lang=zh-CN'],
                viewport={'width': 1280, 'height': 800}, device_scale_factor=1)
            errors = []
            sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
            ext_id = sw.url.split('/')[2]
            check('后台 service worker 启动', ext_id)

            # 安装后自动打开设置页
            await asyncio.sleep(1)
            opt = None
            for pg in ctx.pages:
                if 'options.html' in pg.url: opt = pg
            check('首次安装自动打开设置页', opt is not None)
            if not opt:
                opt = await ctx.new_page(); await opt.goto(f'chrome-extension://{ext_id}/options/options.html')
            opt.on('pageerror', lambda e: errors.append('options: ' + str(e)))
            await opt.wait_for_selector('#provider option', state='attached')
            # 通过设置页 UI 配置大模型
            await opt.select_option('#provider', 'custom')
            await opt.fill('#baseUrl', 'http://127.0.0.1:8787/v1')
            await opt.fill('#model', 'mock-model')
            await opt.fill('#apiKey', 'sk-test-123')
            await opt.click('#saveEngine')
            await opt.wait_for_selector('#testResult.ok, #testResult.err', state='attached', timeout=15000)
            tr = await opt.text_content('#testResult')
            check('设置页：保存并测试连接成功', 'ok' == await opt.get_attribute('#testResult', 'class'), tr)
            stored = await opt.evaluate("(async()=>({s:(await chrome.storage.sync.get('settings')).settings, k:(await chrome.storage.local.get('apiKey')).apiKey}))()")
            check('API Key 只存本地不同步', stored['k'] == 'sk-test-123' and stored['s']['llm']['apiKey'] == '')
            await opt.evaluate("window.scrollTo(0,0)")
            await opt.screenshot(path=os.path.join(SHOTS, 'options.png'))
            await opt.set_viewport_size({'width':1280,'height':1500})
            await opt.evaluate("document.querySelector('#page').scrollIntoView()")
            await asyncio.sleep(0.3)
            await opt.screenshot(path=os.path.join(SHOTS, 'options-page.png'))

            # ---------- 网页翻译 ----------
            page = await ctx.new_page()
            page.on('pageerror', lambda e: errors.append('article: ' + str(e)))
            await page.goto('http://127.0.0.1:8787/article.html')
            await asyncio.sleep(1.8)  # 等动态段落出现
            check('按需注入：未操作前网页里没有插件脚本', await page.evaluate("!document.querySelector('cst-float')"))
            orig_html = await page.evaluate("document.querySelector('article').innerHTML")
            await page.screenshot(path=os.path.join(SHOTS, 'article-before.png'))
            tabs = await opt.evaluate("chrome.tabs.query({url:'http://127.0.0.1:8787/article.html'})")
            tab_id = tabs[0]['id']
            pop = await ctx.new_page()
            pop.on('pageerror', lambda e: errors.append('popup: ' + str(e)))
            await pop.set_viewport_size({'width': 340, 'height': 470})
            await pop.goto(f'chrome-extension://{ext_id}/popup/popup.html?tab={tab_id}')
            await pop.wait_for_selector('#toggle:not([disabled])', state='attached')
            check('弹窗：未注入页面显示「翻译此页面」', '翻译此页面' in (await pop.text_content('#toggle')))
            await pop.click('#toggle')
            await page.bring_to_front()
            await page.wait_for_function("document.querySelectorAll('cst-t').length >= 8", timeout=10000)
            await asyncio.sleep(0.8)
            n = await page.evaluate("document.querySelectorAll('cst-t').length")
            texts = await page.evaluate("[...document.querySelectorAll('cst-t')].map(n=>n.textContent)")
            check('双语：插入译文', n >= 8, n)
            check('双语：标题已翻译', '日本寿险是如何演变的' in texts)
            check('双语：中文段落被跳过', not any('本来就是中文' in t for t in texts))
            check('双语：代码块不翻译', await page.evaluate("!document.querySelector('pre').querySelector('cst-t')"))
            check('双语：链接内译文仍在 <a> 中', await page.evaluate("!!document.querySelector('#lnk cst-t')"))
            check('双语：导航短文本行内显示', await page.evaluate("[...document.querySelectorAll('nav cst-t')].every(n=>n.classList.contains('cst-inline'))"))
            navt = await page.evaluate("[...document.querySelectorAll('nav cst-t')].map(n=>n.textContent)")
            check('导航栏逐项翻译（不拼成一句）', navt == ['首页','市场','研究','关于'], navt)
            check('动态加载的段落也被翻译', await page.evaluate("!!document.querySelector('#dyn cst-t')"))
            log = json.loads(await (await page.request.get('http://127.0.0.1:8787/log')).text())
            check('大模型调用带正确 Key/模型', all(l['auth'] == 'Bearer sk-test-123' and l['model'] == 'mock-model' for l in log), log[:1])
            check('段落批量发送（请求数少于段落数）', len([l for l in log if l['n'] > 1]) >= 1)
            await page.screenshot(path=os.path.join(SHOTS, 'article-bilingual.png'))

            # 切换到"仅译文"
            tabs = await opt.evaluate("chrome.tabs.query({url:'http://127.0.0.1:8787/article.html'})")
            tab_id = tabs[0]['id']
            await opt.evaluate(f"chrome.tabs.sendMessage({tab_id},{{type:'setMode',mode:'replace'}})")
            await asyncio.sleep(0.4)
            check('替换模式：原文隐藏', await page.evaluate("getComputedStyle(document.querySelector('cst-o')).display==='none'"))
            check('替换模式：链接仍可点击', await page.evaluate("document.querySelector('#lnk').getAttribute('href')==='https://example.com/a' && document.querySelector('#lnk').innerText.trim()==='阅读完整报告'"))
            vis = await page.evaluate("document.querySelector('h1').innerText.trim()")
            check('替换模式：标题只显示中文', vis == '日本寿险是如何演变的', vis)
            await page.screenshot(path=os.path.join(SHOTS, 'article-replace.png'))
            check('替换模式：标签页标题也翻译', (await page.title()) == '日本寿险是如何演变的', await page.title())
            await opt.evaluate(f"chrome.tabs.sendMessage({tab_id},{{type:'setMode',mode:'bilingual'}})")
            await asyncio.sleep(0.3)
            check('切回双语：无需重新请求', len(json.loads(await (await page.request.get('http://127.0.0.1:8787/log')).text())) <= len(log) + 1)  # 标题与 h1 同文时命中缓存

            # 弹窗截图
            # 翻译开始后弹窗会自动关闭，重新打开一个看状态
            pop = await ctx.new_page()
            pop.on('pageerror', lambda e: errors.append('popup: ' + str(e)))
            await pop.set_viewport_size({'width': 340, 'height': 470})
            await pop.goto(f'chrome-extension://{ext_id}/popup/popup.html?tab={tab_id}')
            await pop.wait_for_selector('#toggle.on', state='attached', timeout=8000)
            await asyncio.sleep(0.5)
            check('弹窗显示当前页已翻译', True)
            await pop.screenshot(path=os.path.join(SHOTS, 'popup.png'))
            await pop.close()

            # 恢复原文
            await page.bring_to_front()
            await page.click('cst-float >> .b')
            await asyncio.sleep(0.3)
            restored = await page.evaluate("document.querySelector('article').innerHTML")
            check('恢复原文：DOM 与翻译前完全一致', restored == orig_html)

            # ---------- 总是翻译此网站（动态注册内容脚本） ----------
            await opt.evaluate("""(async()=>{const s=(await chrome.storage.sync.get('settings')).settings||{}; s.page=s.page||{}; s.page.alwaysSites=['127.0.0.1']; await chrome.storage.sync.set({settings:s});})()""")
            await asyncio.sleep(1.0)
            await page.reload()
            await page.wait_for_function("document.querySelectorAll('cst-t').length >= 8", timeout=10000)
            check('总是翻译：刷新后自动翻译', True)
            await opt.evaluate("""(async()=>{const s=(await chrome.storage.sync.get('settings')).settings; s.page.alwaysSites=[]; await chrome.storage.sync.set({settings:s});})()""")
            await asyncio.sleep(1.0)
            await page.reload(); await asyncio.sleep(1.5)
            check('总是翻译：移除后不再自动注入', await page.evaluate("!document.querySelector('cst-float') && !document.querySelector('cst-t')"))

            # ---------- 视频双语字幕 ----------
            async def yt_route(route):
                url = route.request.url
                if '/api/timedtext' in url:
                    await route.fulfill(path=os.path.join(FIX, 'timedtext.json'), content_type='application/json')
                elif url.endswith('/silence.wav'):
                    await route.fulfill(path=os.path.join(FIX, 'silence.wav'), content_type='audio/wav')
                elif '/watch' in url and 'NOCCVID01' in url:
                    html = open(os.path.join(FIX, 'yt.html'), encoding='utf-8').read().replace('aria-pressed="false">CC', 'aria-pressed="false" data-title-no-tooltip="无法显示字幕">CC')
                    await route.fulfill(body=html, content_type='text/html; charset=utf-8')
                elif '/watch' in url and 'LIVEVID01' in url:
                    await route.fulfill(path=os.path.join(FIX, 'yt-live.html'), content_type='text/html; charset=utf-8')
                elif '/watch' in url:
                    await route.fulfill(path=os.path.join(FIX, 'yt.html'), content_type='text/html; charset=utf-8')
                else:
                    await route.fulfill(status=404, body='')
            await ctx.route('https://www.youtube.com/**', yt_route)
            yt = await ctx.new_page()
            yt.on('pageerror', lambda e: errors.append('yt: ' + str(e)))
            await yt.goto('https://www.youtube.com/watch?v=TESTVID01')
            await yt.wait_for_function("document.querySelector('.ytp-subtitles-button').getAttribute('aria-pressed')==='true'", timeout=8000)
            check('视频：自动打开字幕', True)
            await yt.wait_for_selector('#cst-yt-overlay')
            await yt.evaluate("const v=document.querySelector('video'); v.currentTime=1.2; v.play()")
            await yt.wait_for_function("document.querySelector('#cst-yt-overlay .cst-yt-trans').textContent.length>0", timeout=10000)
            o = await yt.evaluate("[document.querySelector('.cst-yt-orig').textContent, document.querySelector('.cst-yt-trans').textContent]")
            check('视频：自动字幕断句为完整句子', o[0] == "so today we're going to talk about how compound interest works", o)
            check('视频：显示中文译文', o[1] == '今天我们来聊聊复利是怎么运作的', o)
            fs = await yt.evaluate("[getComputedStyle(document.querySelector('.cst-yt-orig')).fontSize, getComputedStyle(document.querySelector('.cst-yt-trans')).fontSize]")
            check('视频：原文译文字号默认一致', fs[0] == fs[1], fs)
            check('视频：原生字幕被隐藏', await yt.evaluate("getComputedStyle(document.querySelector('.ytp-caption-window-container')).display==='none'"))
            await yt.evaluate("document.querySelector('#movie_player').classList.remove('ytp-autohide')")
            await asyncio.sleep(0.3)
            await yt.screenshot(path=os.path.join(SHOTS, 'video.png'))
            await yt.evaluate("document.querySelector('#movie_player').classList.add('ytp-autohide'); document.querySelector('video').currentTime=5.2")
            await yt.wait_for_function("document.querySelector('.cst-yt-orig').textContent.startsWith('it is')", timeout=5000)
            o2 = await yt.evaluate("document.querySelector('.cst-yt-trans').textContent")
            check('视频：跳转后字幕同步', o2 == '它是个人理财中最强大的力量。', o2)
            # 用户关闭 CC → 双语层隐藏
            await yt.click('.ytp-subtitles-button')
            await asyncio.sleep(0.3)
            check('视频：关闭 CC 后双语层隐藏', await yt.evaluate("document.querySelector('#cst-yt-overlay').style.display==='none'"))

            # ---------- 直播字幕（无字幕文件，实时读取原生字幕） ----------
            lv = await ctx.new_page()
            lv.on('pageerror', lambda e: errors.append('live: ' + str(e)))
            await lv.goto('https://www.youtube.com/watch?v=LIVEVID01')
            await lv.wait_for_function("(document.querySelector('.cst-yt-trans')||{}).textContent === '它是个人理财中最强大的力量。'", timeout=10000)
            check('直播：读取原生字幕并翻译', True)
            check('直播：原生字幕透明隐藏而非移除', await lv.evaluate("getComputedStyle(document.querySelector('.ytp-caption-window-container')).opacity==='0'"))
            await lv.screenshot(path=os.path.join(SHOTS, 'video-live.png'))

            # ---------- 没有字幕的视频：给出提示 ----------
            nc = await ctx.new_page()
            nc.on('pageerror', lambda e: errors.append('nocc: ' + str(e)))
            await nc.goto('https://www.youtube.com/watch?v=NOCCVID01')
            await nc.wait_for_selector('.cst-yt-hint.show', timeout=8000)
            check('无字幕视频：提示「这个视频没有字幕」', '没有字幕' in (await nc.text_content('.cst-yt-hint')))
            check('无字幕视频：不会去点 CC', await nc.evaluate("document.querySelector('.ytp-subtitles-button').getAttribute('aria-pressed')==='false'"))

            check('全程无页面脚本错误', not errors, errors)
            await ctx.close()
    finally:
        srv.terminate()
    ok = sum(1 for _, c in results if c)
    print(f'\n{ok}/{len(results)} 通过')
    return ok == len(results)

sys.exit(0 if asyncio.run(main()) else 1)
