"""Chromium test: image translation quality (gradient-aware erase, original ink colour, alignment, tiling of tall pictures).
Run: python tests/image_quality_smoke.py   (set CHROMIUM_PATH on Windows)
"""
import base64
import io
import json
import os
from pathlib import Path
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]


def to_url(img):
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def gradient_card():
    img = Image.new('RGB', (600, 300))
    px = img.load()
    for x in range(600):
        t = x / 599
        c = (round(150 + 105 * t), round(200 + 55 * t), round(255 - 105 * t))
        for y in range(300):
            px[x, y] = c
    d = ImageDraw.Draw(img)
    for y in range(102, 138, 6):  # thin blue "glyph" stripes, left part of the box only
        d.rectangle([100, y, 300, y + 1], fill=(20, 40, 200))
    return img


CARD = to_url(gradient_card())
TALL = to_url(Image.new('RGB', (400, 3000), (255, 255, 255)))
PAGE = f"""<html><head><title>T</title></head><body style="margin:0">
<img id="card" src="{CARD}" style="display:block;width:600px;height:300px">
<img id="tall" src="{TALL}" style="display:block;width:400px;height:3000px">
</body></html>"""
MOCK = """window.__store={};window.__sent=[];window.__listeners=[];window.__msg=[];
window.chrome={storage:{local:{get:async()=>({...window.__store})},onChanged:{addListener:fn=>window.__listeners.push(fn)}},
runtime:{onMessage:{addListener:fn=>window.__msg.push(fn)},sendMessage:async m=>{window.__sent.push({type:m.type,len:(m.data||'').length});
 if(m.type!=='VIWEB_IMAGE') return {ok:false};
 if(window.__big) return {ok:true,cached:false,regions:[{b:[450,100,550,900],s:'x',v:'Xin chào'}]};
 return {ok:true,cached:false,regions:[{b:[333,167,467,833],s:'Hello',v:'Chào bạn',a:'c'}]};}}};"""

SCAN = """async sel => { const im = document.querySelector(sel); const c = document.createElement('canvas');
  c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data, W = c.width;
  const at = (px, py) => { const o = (py * W + px) * 4; return [d[o], d[o + 1], d[o + 2]]; };
  const count = (x0, y0, x1, y1, f) => { let n = 0; for (let y = y0; y < y1; y++) for (let xx = x0; xx < x1; xx++) if (f(at(xx, y))) n++; return n; };
  const blue = p => p[2] > 150 && p[0] < 80 && p[1] < 100;
  const rows = (y0, y1) => count(0, y0, W, y1, p => p[0] < 100);
  return {h: c.height, w: W, at: [[103, 103], [497, 137], [98, 120], [503, 120]].map(([a, b]) => at(a, b)),
          blueLeft: count(100, 100, 300, 140, blue), blueRight: count(380, 100, 500, 140, blue),
          bands: [397, 1125, 1875, 2602].map(m => rows(Math.max(0, m - 50), m + 50)),
          gap: c.height > 1000 ? rows(600, 1000) : 0}; }"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 900, 'height': 1200})
    page.route('https://page.test/**', lambda r: r.fulfill(body=PAGE, content_type='text/html'))
    page.add_init_script(MOCK)
    page.goto('https://page.test/')
    page.add_script_tag(path=str(ROOT / 'media_common.js'))
    page.add_script_tag(path=str(ROOT / 'image.js'))
    page.wait_for_function("[...document.images].every(i => i.complete)")

    # gradient card: erased from the surrounding edges, ink colour kept, alignment taken from the ink
    page.evaluate("window.__msg.forEach(f => f({type:'VIWEB_IMAGE_CONTEXT', srcUrl: document.getElementById('card').src}))")
    page.wait_for_function("document.querySelector('#card').src.startsWith('blob:') && document.querySelector('#card').complete", timeout=8000)
    s = page.evaluate(SCAN, '#card')
    for inside, outside in ((s['at'][0], s['at'][2]), (s['at'][1], s['at'][3])):
        assert max(abs(a - b) for a, b in zip(inside, outside)) < 14, ('erased area follows the gradient', s['at'])
    assert s['blueLeft'] > 30, ('translation keeps the original ink colour', s)
    assert s['blueRight'] == 0, ('left-aligned like the original ink', s)
    assert len([m for m in page.evaluate('window.__sent') if m['type'] == 'VIWEB_IMAGE']) == 1, 'a normal picture is one call'

    # tall picture: cut into tiles, every tile translated, boxes mapped back to the whole picture
    page.evaluate("window.__big = true; window.__sent.length = 0")
    page.evaluate("window.__msg.forEach(f => f({type:'VIWEB_IMAGE_CONTEXT', srcUrl: document.getElementById('tall').src}))")
    page.wait_for_function("document.querySelector('#tall').src.startsWith('blob:') && document.querySelector('#tall').complete", timeout=10000)
    sent = [m for m in page.evaluate('window.__sent') if m['type'] == 'VIWEB_IMAGE']
    assert len(sent) == 4, ('tall picture is sent as tiles', len(sent))
    t = page.evaluate(SCAN, '#tall')
    assert t['h'] == 3000 and all(n > 40 for n in t['bands']), ('every tile contributes text at its own place', t['bands'])
    assert t['gap'] == 0, ('no stray text between tiles', t['gap'])
    print('PASS: gradient-aware erase, original ink colour, ink-based alignment, tiling of tall pictures')
    browser.close()
