import sys
from playwright.sync_api import sync_playwright
slugs=sys.argv[1:]
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={'width':520,'height':900}, device_scale_factor=1)
    for s in slugs:
        pg.goto('file://../dist/index.html#'+s); pg.add_style_tag(content='.viewer-bar{display:none!important}'); pg.wait_for_timeout(300)
        pg.locator('#'+s).screenshot(path=f'/tmp/claude-0/{s}.png')
    b.close()
