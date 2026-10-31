"""Chromium test: image translation UI on a fake page (real DOM, mocked extension runtime).
Run: python tests/image_smoke.py   (set CHROMIUM_PATH on Windows)
"""
import base64
import io
import os
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]


def png(size=(400, 300), color=(255, 255, 255)):
    buf = io.BytesIO()
    Image.new('RGB', size, color).save(buf, 'PNG')
    return buf.getvalue()


WHITE = png()
DATA_URL = 'data:image/png;base64,' + base64.b64encode(WHITE).decode()
URL_C = 'data:image/png;base64,' + base64.b64encode(png((401, 300), (250, 250, 250))).decode()
URL_D = 'data:image/png;base64,' + base64.b64encode(png((402, 300), (240, 240, 240))).decode()
TAINT_URL = 'https://img.test/remote.png'
PAGE = f"""<html><head><title>Shop</title></head><body style="margin:0;padding-bottom:1500px">
<img id="a" src="{DATA_URL}" style="display:block;margin:100px 0 0 100px;width:400px;height:300px">
<img id="tiny" src="{DATA_URL}" style="display:block;margin:20px 0 0 100px;width:60px;height:40px">
<img id="remote" src="{TAINT_URL}" style="display:block;margin:20px 0 0 100px;width:400px;height:300px">
<img id="c" src="{URL_C}" style="display:block;margin:20px 0 0 100px;width:400px;height:300px">
<img id="d" src="{URL_D}" style="display:block;margin:20px 0 0 100px;width:400px;height:300px">
</body></html>"""
MOCK = """window.__store={};window.__sent=[];window.__listeners=[];window.__msg=[];
window.chrome={storage:{local:{get:async()=>({...window.__store})},onChanged:{addListener:fn=>window.__listeners.push(fn)}},
runtime:{onMessage:{addListener:fn=>window.__msg.push(fn)},sendMessage:async m=>{window.__sent.push(m);
 if(m.type==='VIWEB_IMAGE') return {ok:true,cached:false,regions:[{b:[100,100,300,600],s:'Hello',v:'Xin chào'}]};
 if(m.type==='VIWEB_FETCH_IMAGE') return {ok:true,data:%r};
 return {ok:false}}}};""" % DATA_URL


def geometry(page, sel):
    return page.evaluate("""s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }""", sel)


def shadow(page, js):
    return page.evaluate("() => { const root = document.querySelector('[data-vietweb-ui]').shadowRoot; return (" + js + ")(root); }")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 900, 'height': 1800})
    page.route('https://page.test/**', lambda r: r.fulfill(body=PAGE, content_type='text/html'))
    page.route(TAINT_URL, lambda r: r.abort() if r.request.resource_type == 'fetch' else r.fulfill(body=WHITE, content_type='image/png'))
    page.add_init_script(MOCK)
    page.goto('https://page.test/')
    page.add_script_tag(path=str(ROOT / 'media_common.js'))
    page.add_script_tag(path=str(ROOT / 'image.js'))
    page.wait_for_function("[...document.images].every(i => i.complete)")

    # nothing happens until the user hovers an image; tiny images never get a button
    x, y, w, h = geometry(page, '#a')
    page.mouse.move(x + w / 2, y + h / 2)
    page.wait_for_function("document.querySelector('[data-vietweb-ui]')?.shadowRoot.querySelector('.pill')?.style.display === 'block'", timeout=4000)
    assert shadow(page, "r => r.querySelector('.pill').textContent") == 'Dịch ảnh'
    tx, ty, tw, th = geometry(page, '#tiny')
    page.mouse.move(tx + tw / 2, ty + th / 2)
    page.wait_for_function("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.pill').style.display === 'none'", timeout=4000)
    page.mouse.move(x + w / 2, y + h / 2)
    page.wait_for_function("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.pill').style.display === 'block'", timeout=4000)
    assert page.evaluate('window.__sent.length') == 0

    page.locator('.pill').click()
    page.wait_for_function("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.reg')", timeout=5000)
    sent = page.evaluate('window.__sent')
    assert sent[0]['type'] == 'VIWEB_IMAGE' and sent[0]['data'].startswith('data:image/jpeg;base64,') and sent[0]['page']['title'] == 'Shop', sent[0]['type']
    ov = shadow(page, "r => { const b = r.querySelector('.ov').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; }")
    assert [round(v) for v in ov] == [round(v) for v in (x, y, w, h)], ('overlay covers the image', ov, (x, y, w, h))
    reg = shadow(page, "r => { const e = r.querySelector('.reg'); const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return [b.left, b.top, b.width, b.height, s.backgroundColor, s.color, e.textContent]; }")
    assert reg[6] == 'Xin chào'
    assert abs(reg[0] - (x + 0.1 * w - 1.6)) < 3 and abs(reg[1] - (y + 0.1 * h - 1.2)) < 3, ('region sits on the OCR box', reg)
    assert reg[4] == 'rgb(255, 255, 255)' and reg[5] == 'rgb(17, 17, 17)', ('colours sampled from the image', reg)
    assert shadow(page, "r => r.querySelector('.pill').textContent") == 'Xem bản gốc'
    # the overlay follows the image when the page scrolls
    page.evaluate('window.scrollTo(0, 40)')
    page.wait_for_timeout(200)
    ov2 = shadow(page, "r => { const b = r.querySelector('.ov').getBoundingClientRect(); return b.top; }")
    assert abs(ov2 - (y - 40)) < 2, ov2
    page.evaluate('window.scrollTo(0, 0)')
    page.wait_for_timeout(200)
    # toggle original / translated
    page.locator('.pill').click()
    page.wait_for_function("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.ov').style.display === 'none'", timeout=2000)
    assert shadow(page, "r => r.querySelector('.pill').textContent") == 'Xem bản dịch'
    page.locator('.pill').click()
    page.wait_for_function("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.ov').style.display === 'block'", timeout=2000)
    assert page.evaluate('window.__sent.length') == 1, 'toggling never calls the API again'
    # visual mode "original" hides drawn translations
    page.evaluate("window.__store={visualMode:'original'}; window.__listeners.forEach(f=>f({visualMode:{}},'local'))")
    page.wait_for_function("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.ov').style.display === 'none'", timeout=2000)
    page.evaluate("window.__store={}; window.__listeners.forEach(f=>f({visualMode:{}},'local'))")

    # cross-origin image: canvas is tainted, so the extension fetches the bytes in the background
    page.evaluate('window.__sent.length = 0')
    page.evaluate("window.__msg.forEach(f => f({type:'VIWEB_IMAGE_CONTEXT', srcUrl: document.getElementById('remote').src}))")
    page.wait_for_function("window.__sent.some(m => m.type === 'VIWEB_IMAGE')", timeout=6000)
    types = [m['type'] for m in page.evaluate('window.__sent')]
    assert types == ['VIWEB_FETCH_IMAGE', 'VIWEB_IMAGE'], types
    # context menu on a URL without an <img> shows a hint instead of failing silently
    page.evaluate("window.__msg.forEach(f => f({type:'VIWEB_IMAGE_CONTEXT', srcUrl: 'https://nowhere.test/x.png'}))")
    page.wait_for_function("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.toast')", timeout=2000)

    # auto mode: translates images that scroll into view, capped per page
    page.evaluate('window.__sent.length = 0')
    page.evaluate("window.__store={imageMode:'auto',imageAutoLimit:2}; window.__listeners.forEach(f=>f({imageMode:{}},'local'))")
    page.wait_for_function("window.__sent.filter(m => m.type === 'VIWEB_IMAGE').length >= 2", timeout=8000)
    page.wait_for_timeout(1500)
    n = len([m for m in page.evaluate('window.__sent') if m['type'] == 'VIWEB_IMAGE'])
    assert n == 2, ('auto mode respects the per-page limit', n)
    # off disables the button
    page.evaluate("window.__store={imageMode:'off'}; window.__listeners.forEach(f=>f({imageMode:{}},'local'))")
    page.mouse.move(5, 5)
    page.wait_for_timeout(500)
    page.mouse.move(x + w / 2, y + h / 2)
    page.wait_for_timeout(600)
    assert shadow(page, "r => r.querySelector('.pill').style.display") == 'none'
    print('PASS: hover button, size gate, overlay geometry/colours, scroll tracking, toggle, cross-origin fallback, context menu, auto limit, off')
    browser.close()
