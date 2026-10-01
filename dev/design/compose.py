import asyncio, base64, os
from playwright.async_api import async_playwright
D = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(os.path.dirname(D), 'store')  # dev/store
b64 = lambda p: 'data:image/png;base64,' + base64.b64encode(open(os.path.join(D, p), 'rb').read()).decode()
ICON = b64('icon256.png')
SLIDES = [
  ('screenshot-1-bilingual.png', '网页双语对照', '原文、译文上下对照，读外文资料不再来回切换', 'shots/article-bilingual.png'),
  ('screenshot-2-replace.png', '一键切换“仅显示译文”', '整页变中文，链接照常可点；随时切回双语，不重复请求', 'shots/article-replace.png'),
  ('screenshot-3-video.png', '视频双语字幕', '自动生成的字幕先按句断开再翻译，中英两行同步显示', 'shots/video.png'),
  ('screenshot-4-engine.png', '大模型翻译，或零配置免费用', '支持 DeepSeek、通义千问、Kimi、智谱、OpenAI 等兼容接口', 'shots/options.png'),
]
CSS = '''*{margin:0;box-sizing:border-box}body{width:1280px;height:800px;overflow:hidden;background:#022A99;font-family:"Noto Sans CJK SC",sans-serif;color:#fff;position:relative}
.bg{position:absolute;right:-160px;top:-160px;width:520px;height:520px;border-radius:50%;background:rgba(251,205,8,.10)}
.head{position:absolute;left:72px;top:52px;right:72px;display:flex;align-items:center;gap:22px}
.head img{width:64px;height:64px}
.head h1{font-size:44px;font-weight:900;color:#FBCD08;letter-spacing:1px}
.head p{font-size:22px;color:rgba(255,255,255,.86);margin-top:6px}
.shot{position:absolute;left:72px;right:72px;top:178px;height:590px;border-radius:16px 16px 0 0;overflow:hidden;box-shadow:0 30px 70px rgba(0,0,0,.45);background:#fff}
.bar{height:34px;background:#eef0f6;display:flex;align-items:center;gap:8px;padding:0 14px}
.bar i{width:11px;height:11px;border-radius:50%;background:#d0d4df}
.shot img{display:block;width:100%}'''
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width':1280,'height':800})
        for name, h, sub, img in SLIDES:
            html = f'<style>{CSS}</style><div class="bg"></div><div class="head"><img src="{ICON}"><div><h1>{h}</h1><p>{sub}</p></div></div><div class="shot"><div class="bar"><i></i><i></i><i></i></div><img src="{b64(img)}"></div>'
            await pg.set_content(html); await pg.wait_for_timeout(200)
            await pg.screenshot(path=os.path.join(OUT, name))
        # 小宣传图 440x280
        await pg.set_viewport_size({'width':440,'height':280})
        await pg.set_content(f'''<style>*{{margin:0}}body{{width:440px;height:280px;background:#022A99;font-family:"Noto Sans CJK SC",sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;overflow:hidden;position:relative}}
          .c{{position:absolute;right:-70px;bottom:-90px;width:240px;height:240px;border-radius:50%;background:rgba(251,205,8,.12)}}
          img{{width:96px;height:96px}}h1{{color:#FBCD08;font-size:30px;font-weight:900}}p{{color:#fff;font-size:16px;opacity:.9}}</style>
          <div class="c"></div><img src="{ICON}"><h1>ClearSky 双语翻译</h1><p>网页双语对照 · 视频双语字幕</p>''')
        await pg.wait_for_timeout(200); await pg.screenshot(path=os.path.join(OUT, 'promo-small-440x280.png'))
        # 大宣传图 1400x560
        await pg.set_viewport_size({'width':1400,'height':560})
        await pg.set_content(f'''<style>*{{margin:0}}body{{width:1400px;height:560px;background:#022A99;font-family:"Noto Sans CJK SC",sans-serif;display:flex;align-items:center;gap:56px;padding:0 110px;box-sizing:border-box;overflow:hidden;position:relative}}
          .c{{position:absolute;right:-120px;top:-140px;width:520px;height:520px;border-radius:50%;background:rgba(251,205,8,.12)}}
          img{{width:200px;height:200px}}h1{{color:#FBCD08;font-size:64px;font-weight:900}}p{{color:#fff;font-size:28px;margin-top:14px;opacity:.92}}</style>
          <div class="c"></div><img src="{ICON}"><div><h1>ClearSky 双语翻译</h1><p>网页双语对照 / 仅译文 · 视频双语字幕 · 大模型翻译</p></div>''')
        await pg.wait_for_timeout(200); await pg.screenshot(path=os.path.join(OUT, 'promo-marquee-1400x560.png'))
        await b.close()
asyncio.run(main())
