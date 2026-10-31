"""Chromium test: image translation replaces the <img> source with a baked, full-resolution picture
(real DOM, mocked extension runtime).  Run: python tests/image_smoke.py   (set CHROMIUM_PATH on Windows)
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


def data_url(size, color):
    return 'data:image/png;base64,' + base64.b64encode(png(size, color)).decode()


WHITE = png()
DATA_URL = data_url((400, 300), (255, 255, 255))
URL_C = data_url((401, 300), (250, 250, 250))
URL_D = data_url((402, 300), (240, 240, 240))
URL_P = data_url((403, 300), (255, 255, 255))
BIG = data_url((1600, 1200), (255, 255, 255))
TAINT_URL = 'https://img.test/remote.png'
PAGE = f"""<html><head><title>Shop</title></head><body style="margin:0;padding-bottom:1500px">
<a id="lnk" href="{DATA_URL}"><img id="a" src="{DATA_URL}" style="display:block;margin:100px 0 0 100px;width:400px;height:300px"></a>
<img id="tiny" src="{DATA_URL}" style="display:block;margin:20px 0 0 100px;width:60px;height:40px">
<img id="remote" src="{TAINT_URL}" style="display:block;margin:20px 0 0 100px;width:400px;height:300px">
<picture><source id="src" srcset="{URL_P}"><img id="pic" src="{DATA_URL}" style="display:block;margin:20px 0 0 100px;width:400px;height:300px"></picture>
<img id="big" src="{BIG}" style="display:block;margin:20px 0 0 100px;width:400px;height:300px">
<img id="c" src="{URL_C}" style="display:block;margin:20px 0 0 100px;width:400px;height:300px">
<img id="d" src="{URL_D}" style="display:block;margin:20px 0 0 100px;width:400px;height:300px">
</body></html>"""
MOCK = """window.__store={};window.__sent=[];window.__listeners=[];window.__msg=[];
window.chrome={storage:{local:{get:async()=>({...window.__store})},onChanged:{addListener:fn=>window.__listeners.push(fn)}},
runtime:{onMessage:{addListener:fn=>window.__msg.push(fn)},sendMessage:async m=>{window.__sent.push(m);
 if(m.type==='VIWEB_IMAGE') return {ok:true,cached:false,regions:[{b:[100,100,300,600],s:'Hello',v:'Xin chào các bạn'}]};
 if(m.type==='VIWEB_FETCH_IMAGE') return {ok:true,data:%r};
 return {ok:false}}}};""" % DATA_URL

PIXELS = """async sel => { const im = document.querySelector(sel); const c = document.createElement('canvas');
  c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
  const dark = (x0, y0, x1, y1) => { const p = x.getImageData(x0, y0, x1 - x0, y1 - y0).data; let n = 0;
    for (let i = 0; i < p.length; i += 4) if (p[i] < 100) n++; return n; };
  const W = c.width, H = c.height;
  return {w: W, h: H, inside: dark(Math.round(W * .1), Math.round(H * .1), Math.round(W * .6), Math.round(H * .3)),
          outside: dark(0, Math.round(H * .4), W, H) + dark(Math.round(W * .7), 0, W, Math.round(H * .35))}; }"""


def geometry(page, sel):
    return page.evaluate("""s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }""", sel)


def pill_text(page):
    return page.evaluate("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.pill').textContent")


def pill_display(page):
    return page.evaluate("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.pill').style.display")


def attr(page, sel, name):
    return page.evaluate("([s, n]) => document.querySelector(s).getAttribute(n)", [sel, name])


def open_page(browser, csp=None):
    page = browser.new_page(viewport={'width': 900, 'height': 2400})
    headers = {'Content-Security-Policy': csp} if csp else {}
    page.route('https://page.test/**', lambda r: r.fulfill(body=PAGE, content_type='text/html', headers=headers))
    page.route(TAINT_URL, lambda r: r.abort() if r.request.resource_type == 'fetch' else r.fulfill(body=WHITE, content_type='image/png'))
    page.add_init_script(MOCK)
    page.goto('https://page.test/')
    page.add_script_tag(path=str(ROOT / 'media_common.js'))
    page.add_script_tag(path=str(ROOT / 'image.js'))
    page.wait_for_function("[...document.images].every(i => i.complete)")
    return page


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
    page = open_page(browser)

    # nothing happens until the user hovers an image; tiny images never get a button
    x, y, w, h = geometry(page, '#a')
    page.mouse.move(x + w / 2, y + h / 2)
    page.wait_for_function("document.querySelector('[data-vietweb-ui]')?.shadowRoot.querySelector('.pill')?.style.display === 'block'", timeout=4000)
    assert pill_text(page) == 'Dịch ảnh'
    tx, ty, tw, th = geometry(page, '#tiny')
    page.mouse.move(tx + tw / 2, ty + th / 2)
    page.wait_for_function("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.pill').style.display === 'none'", timeout=4000)
    page.mouse.move(x + w / 2, y + h / 2)
    page.wait_for_function("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.pill').style.display === 'block'", timeout=4000)
    assert page.evaluate('window.__sent.length') == 0

    # translate: the <img> itself now holds the translated picture
    page.locator('.pill').click()
    page.wait_for_function("document.querySelector('#a').src.startsWith('blob:')", timeout=6000)
    sent = page.evaluate('window.__sent')
    assert sent[0]['type'] == 'VIWEB_IMAGE' and sent[0]['data'].startswith('data:image/jpeg;base64,') and sent[0]['page']['title'] == 'Shop'
    assert page.evaluate("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.reg, .ov')") is None, 'no DOM overlay any more'
    page.wait_for_function("document.querySelector('#a').complete && document.querySelector('#a').naturalWidth === 400")
    px = page.evaluate(PIXELS, '#a')
    assert (px['w'], px['h']) == (400, 300) and px['inside'] > 40, ('text is painted inside the OCR box', px)
    assert px['outside'] == 0, ('nothing painted outside the box', px)
    assert pill_text(page) == 'Xem bản gốc'
    translated_src = page.evaluate("document.querySelector('#a').src")
    assert page.evaluate("document.querySelector('#lnk').href") == translated_src, 'link to the same picture follows (lightbox / open image)'
    # zooming or scrolling never needs repositioning: it is just a normal image
    page.evaluate("document.querySelector('#a').style.width = '800px'; document.querySelector('#a').style.height = '600px'")
    assert page.evaluate("document.querySelector('#a').currentSrc") == translated_src

    # toggle original <-> translated without a new API call
    page.evaluate("document.querySelector('#a').style.cssText = 'display:block;margin:100px 0 0 100px;width:400px;height:300px'")
    page.mouse.move(x + w / 2, y + h / 2)
    page.locator('.pill').click()
    page.wait_for_function("document.querySelector('#a').src.startsWith('data:')", timeout=3000)
    assert pill_text(page) == 'Xem bản dịch'
    assert page.evaluate("document.querySelector('#lnk').getAttribute('href')").startswith('data:'), 'link restored'
    page.locator('.pill').click()
    page.wait_for_function("document.querySelector('#a').src === %r" % translated_src, timeout=3000)
    assert page.evaluate('window.__sent.length') == 1, 'toggling never calls the API again'
    # visual mode "original" shows the original picture, back again restores the translation
    page.evaluate("window.__store={visualMode:'original'}; window.__listeners.forEach(f=>f({visualMode:{}},'local'))")
    page.wait_for_function("document.querySelector('#a').src.startsWith('data:')", timeout=3000)
    page.evaluate("window.__store={}; window.__listeners.forEach(f=>f({visualMode:{}},'local'))")
    page.wait_for_function("document.querySelector('#a').src.startsWith('blob:')", timeout=3000)
    # the page swapping the picture (lazy-loading, carousel) forgets the old translation
    page.evaluate("document.querySelector('#a').src = %r" % URL_C)
    page.wait_for_function("document.querySelector('#a').complete && document.querySelector('#a').naturalWidth === 401")
    page.mouse.move(5, 5)
    page.wait_for_timeout(400)
    page.mouse.move(x + w / 2, y + h / 2)
    page.wait_for_function("document.querySelector('[data-vietweb-ui]').shadowRoot.querySelector('.pill').textContent === 'Dịch ảnh'", timeout=3000)
    page.evaluate("document.querySelector('#a').src = %r" % DATA_URL)

    # cross-origin image: canvas is tainted, so the bytes come from the background fetch
    page.evaluate('window.__sent.length = 0')
    page.evaluate("window.__msg.forEach(f => f({type:'VIWEB_IMAGE_CONTEXT', srcUrl: document.getElementById('remote').src}))")
    page.wait_for_function("document.querySelector('#remote').src.startsWith('blob:')", timeout=6000)
    types = [m['type'] for m in page.evaluate('window.__sent')]
    assert types == ['VIWEB_FETCH_IMAGE', 'VIWEB_IMAGE'], types
    assert page.evaluate(PIXELS, '#remote')['inside'] > 40

    # <picture>: the <source> would override <img src>, so it must be neutralised and later restored
    page.evaluate("window.__msg.forEach(f => f({type:'VIWEB_IMAGE_CONTEXT', srcUrl: document.getElementById('pic').currentSrc}))")
    page.wait_for_function("document.querySelector('#pic').currentSrc.startsWith('blob:')", timeout=6000)
    assert attr(page, '#src', 'srcset') is None
    page.evaluate("window.__msg.forEach(f => f({type:'VIWEB_IMAGE_CONTEXT', srcUrl: document.getElementById('pic').currentSrc}))")
    page.wait_for_function("document.querySelector('#pic').currentSrc.startsWith('data:')", timeout=3000)
    assert attr(page, '#src', 'srcset') is not None, '<source srcset> restored'

    # large image: baked at the picture's own resolution (not the downscaled copy sent to the model)
    page.evaluate("window.__msg.forEach(f => f({type:'VIWEB_IMAGE_CONTEXT', srcUrl: document.getElementById('big').src}))")
    page.wait_for_function("document.querySelector('#big').src.startsWith('blob:') && document.querySelector('#big').complete", timeout=8000)
    big = page.evaluate(PIXELS, '#big')
    assert (big['w'], big['h']) == (1600, 1200) and big['inside'] > 200 and big['outside'] == 0, big
    assert page.evaluate("document.querySelector('#big').width") == 400, 'layout size unchanged'

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
    # off disables the button and puts the original pictures back
    page.evaluate("window.__store={imageMode:'off'}; window.__listeners.forEach(f=>f({imageMode:{}},'local'))")
    page.wait_for_function("[...document.images].every(i => !i.src.startsWith('blob:'))", timeout=3000)
    page.mouse.move(5, 5)
    page.wait_for_timeout(500)
    page.mouse.move(x + w / 2, y + h / 2)
    page.wait_for_timeout(600)
    assert pill_display(page) == 'none'
    page.close()

    # a strict img-src CSP rejects blob: URLs; the data: URL fallback still works
    page = open_page(browser, csp="img-src data: https:")
    x, y, w, h = geometry(page, '#a')
    page.evaluate("window.__msg.forEach(f => f({type:'VIWEB_IMAGE_CONTEXT', srcUrl: document.getElementById('a').src}))")
    page.wait_for_function("document.querySelector('#a').src.startsWith('data:image/png') && document.querySelector('#a').src !== %r" % DATA_URL, timeout=8000)
    assert page.evaluate(PIXELS, '#a')['inside'] > 40
    print('PASS: hover button, size gate, baked full-res image replaces <img>, link/picture handling, toggle, page swap, cross-origin fallback, CSP data: fallback, auto limit, off')
    browser.close()
