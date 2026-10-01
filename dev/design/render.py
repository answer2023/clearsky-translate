import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(device_scale_factor=1)
        for svg, sizes in [('icon.svg',[48,128,256]),('icon-small.svg',[16,32])]:
            src=open(svg).read()
            for s in sizes:
                await pg.set_viewport_size({'width':s,'height':s})
                styled = src.replace('<svg ', '<svg style="width:%dpx;height:%dpx;display:block" ' % (s, s), 1)
                await pg.set_content('<html><body style="margin:0;background:transparent">' + styled + '</body></html>')
                await pg.wait_for_timeout(150)
                name = f'../../icons/icon{s}.png' if s!=256 else 'icon256.png'
                await pg.screenshot(path=name, omit_background=True)
        await b.close()
asyncio.run(main())
