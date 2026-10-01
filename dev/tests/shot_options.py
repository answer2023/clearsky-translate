import asyncio, os, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from playwright.async_api import async_playwright
import importlib.util
spec = importlib.util.spec_from_file_location('e2e_mod', os.path.join(os.path.dirname(__file__), 'e2e.py'))
src = open(spec.origin).read().split('async def main')[0]
ns = {'__file__': spec.origin}; exec(src, ns)
async def main():
    ext = ns['build_test_ext'](); user = tempfile.mkdtemp()
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(user, channel='chromium', headless=True,
            args=[f'--disable-extensions-except={ext}', f'--load-extension={ext}'], viewport={'width':1280,'height':800})
        sw = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
        eid = sw.url.split('/')[2]
        pg = await ctx.new_page(); await pg.goto(f'chrome-extension://{eid}/options/options.html')
        await pg.wait_for_selector('#provider option', state='attached')
        await pg.select_option('#provider', 'deepseek')
        await pg.fill('#apiKey', 'sk-0000000000000000')
        await pg.evaluate("""()=>{const r=document.querySelector('#testResult');r.className='ok';r.textContent='连接成功：「你好！敏捷的棕色狐狸跳过了那只懒狗。」'}""")
        await pg.screenshot(path=os.path.join(ns['DEV'], 'design', 'shots', 'options.png'))
        await ctx.close()
asyncio.run(main())
