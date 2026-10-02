"""免费翻译引擎测试：微软优先、失败时自动切到谷歌（拦截插件后台的网络请求，不访问真实服务）"""
import asyncio, json, os, sys, tempfile, subprocess, time
os.environ['PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS'] = '1'
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, 'e2e.py')).read().split('async def main')[0]
ns = {'__file__': os.path.join(HERE, 'e2e.py')}; exec(src, ns)
from playwright.async_api import async_playwright

async def main():
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'mock_server.py')]); time.sleep(0.8)
    ext = ns['build_test_ext'](); user = tempfile.mkdtemp()
    calls = {'auth': 0, 'ms': 0, 'google': 0}
    state = {'ms_fail': False}
    try:
        async with async_playwright() as p:
            ctx = await p.chromium.launch_persistent_context(user, channel='chromium', headless=True,
                args=[f'--disable-extensions-except={ext}', f'--load-extension={ext}'])
            async def ms_auth(route):
                calls['auth'] += 1
                await route.fulfill(body='x' * 120 if not state['ms_fail'] else '', status=200 if not state['ms_fail'] else 500)
            async def ms_api(route):
                calls['ms'] += 1
                items = json.loads(route.request.post_data)
                await route.fulfill(json=[{'translations': [{'text': '【微软】' + it['Text'], 'to': 'zh-Hans'}]} for it in items])
            async def google(route):
                calls['google'] += 1
                from urllib.parse import parse_qs
                qs = parse_qs(route.request.post_data or '')
                q = qs.get('q', [])
                if '/translate_a/single' in route.request.url:
                    await route.fulfill(json=[[['【谷歌】' + q[0], q[0]]], None, 'en'])
                else:
                    await route.fulfill(json=[['【谷歌】' + x, 'en'] for x in q])
            await ctx.route('https://edge.microsoft.com/**', ms_auth)
            await ctx.route('https://api-edge.cognitive.microsofttranslator.com/**', ms_api)
            await ctx.route('https://translate.googleapis.com/**', google)
            sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
            eid = sw.url.split('/')[2]
            opt = await ctx.new_page(); await opt.goto(f'chrome-extension://{eid}/options/options.html')
            await opt.wait_for_selector('#freeEngine', state='attached')
            ok = 0; total = 0
            def check(name, cond, extra=''):
                nonlocal ok, total; total += 1; ok += bool(cond); print(('✓' if cond else '✗'), name, '' if cond else extra)
            check('设置页：免费翻译首选默认是微软', await opt.eval_on_selector('#freeEngine', 'e => e.value') == 'microsoft')
            tr = lambda texts: opt.evaluate(f"chrome.runtime.sendMessage({{type:'translate',kind:'page',texts:{json.dumps(texts, ensure_ascii=False)}}})")
            r = await tr(['Hello world', 'Top stories'])
            check('未配大模型：走微软免费翻译', r['ok'] and r['result'] == ['【微软】Hello world', '【微软】Top stories'], r)
            check('微软：只取一次授权令牌', calls['auth'] == 1, calls)
            # 微软故障 → 自动切谷歌
            state['ms_fail'] = True
            await opt.evaluate("chrome.runtime.sendMessage({type:'clearCache'})")
            # 令牌已缓存，模拟接口本身失败：改路由让翻译接口 503
            await ctx.unroute('https://api-edge.cognitive.microsofttranslator.com/**')
            await ctx.route('https://api-edge.cognitive.microsofttranslator.com/**', lambda route: route.fulfill(status=503, body=''))
            r = await tr(['Fallback please', 'Second line'])
            check('微软故障：自动切到谷歌', r['ok'] and r['result'][0] == '【谷歌】Fallback please', r)
            # 首选改为谷歌
            await opt.select_option('#freeEngine', 'google'); await asyncio.sleep(0.6)
            g0 = calls['google']
            r = await tr(['Only google'])
            check('首选谷歌：直接走谷歌', r['ok'] and r['result'][0] == '【谷歌】Only google' and calls['google'] > g0, r)
            st = await opt.evaluate("chrome.runtime.sendMessage({type:'getStatus'})")
            check('状态：当前引擎显示为谷歌', st['engine'] == 'google', st)
            # 旧设置迁移：engine=google
            await opt.evaluate("(async()=>{const s=(await chrome.storage.sync.get('settings')).settings; s.engine='google'; delete s.freeEngine; await chrome.storage.sync.set({settings:s});})()")
            await asyncio.sleep(0.4)
            st = await opt.evaluate("chrome.runtime.sendMessage({type:'getStatus'})")
            check('旧设置「只用谷歌免费」迁移正确', st['engine'] == 'google', st)
            await ctx.close()
            print(f'\n{ok}/{total} 通过')
            return ok == total
    finally:
        srv.terminate()

sys.exit(0 if asyncio.run(main()) else 1)
