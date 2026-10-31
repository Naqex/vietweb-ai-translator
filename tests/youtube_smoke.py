"""Chromium test: YouTube subtitle overlay on a fake watch page (real DOM, mocked extension runtime).
Run: python tests/youtube_smoke.py   (set CHROMIUM_PATH on Windows)
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
PAGE = """<html><head><title>Demo video</title></head><body>
<div id="movie_player" class="html5-video-player" style="position:relative;width:800px;height:450px;background:#222">
<video class="html5-main-video" style="width:100%;height:100%"></video>
<div class="ytp-caption-window-container"><span class="ytp-caption-segment"></span></div></div></body></html>"""
MOCK = """window.__store={};window.__sent=[];window.__listeners=[];window.__t=0;
window.chrome={storage:{local:{get:async()=>({...window.__store})},onChanged:{addListener:fn=>window.__listeners.push(fn)}},
runtime:{sendMessage:async m=>{window.__sent.push(m);
 if(m.type==='VIWEB_TRANSLATE') return {ok:true,translations:m.rows.map(r=>({id:r.id,text:'VI: '+r.text}))};
 return {ok:false}}}};"""
CUES = {"events": [
    {"tStartMs": 5000, "dDurationMs": 2000, "segs": [{"utf8": "Hello world"}]},
    {"tStartMs": 8000, "dDurationMs": 2000, "segs": [{"utf8": "Second "}, {"utf8": "line"}]},
    {"tStartMs": 8000, "dDurationMs": 100},
    {"tStartMs": 1000000, "dDurationMs": 2000, "segs": [{"utf8": "Far away"}]}]}
TRACK = "https://www.youtube.com/api/timedtext?v=abc123&lang=en&fmt=json3"


def lines(page):
    return page.evaluate("""() => { const h = document.querySelector('#movie_player [data-vietweb-ui]');
      return h ? [...h.shadowRoot.querySelectorAll('.line')].map(n => n.textContent) : null; }""")


def setup(playwright_browser, with_track=True):
    page = playwright_browser.new_page(viewport={'width': 900, 'height': 600})
    page.route('https://www.youtube.com/**', lambda r: r.fulfill(body=PAGE, content_type='text/html'))
    page.add_init_script(MOCK)
    page.goto('https://www.youtube.com/watch?v=abc123')
    page.evaluate("Object.defineProperty(document.querySelector('video'),'currentTime',{get:()=>window.__t})")
    page.add_script_tag(path=str(ROOT / 'media_common.js'))
    page.add_script_tag(path=str(ROOT / 'youtube.js'))
    return page


def post_track(page, url, body):
    page.evaluate("([u,b]) => window.postMessage({source:'viweb-yt',type:'track',url:u,body:b}, location.origin)", [url, body])


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])

    page = setup(browser)
    # translated captions and the original language track are ignored; YouTube's own auto-translation too
    post_track(page, TRACK.replace('lang=en', 'lang=vi'), json.dumps(CUES))
    post_track(page, TRACK + '&tlang=vi', json.dumps(CUES))
    page.wait_for_timeout(700)
    assert page.evaluate('window.__sent.length') == 0, 'Vietnamese / auto-translated tracks must not be sent'
    post_track(page, TRACK, json.dumps(CUES))
    page.evaluate('window.__t = 5.5')
    page.wait_for_function("window.__sent.length > 0", timeout=5000)
    sent = page.evaluate('window.__sent')
    rows = [r['text'] for m in sent for r in m['rows']]
    assert rows == ['Hello world', 'Second line'], ('only the window around the playhead is translated', rows)
    assert sent[0]['page']['kind'] == 'video subtitles' and sent[0]['priority'] == 0, sent[0]
    page.wait_for_function("document.querySelector('#movie_player [data-vietweb-ui]')?.    shadowRoot.textContent.includes('VI: Hello world')", timeout=5000)
    assert lines(page) == ['Hello world', 'VI: Hello world'], lines(page)
    assert page.evaluate("document.documentElement.hasAttribute('data-vietweb-yt')"), 'native captions are hidden while the overlay is active'
    page.evaluate('window.__t = 9')
    page.wait_for_function("document.querySelector('#movie_player [data-vietweb-ui]').shadowRoot.textContent.includes('VI: Second line')", timeout=3000)
    page.evaluate('window.__t = 7.5')
    page.wait_for_timeout(400)
    assert lines(page) is None or lines(page) == [], ('no cue is active in the gap', lines(page))
    # seeking far ahead translates the new window, not everything in between
    before = page.evaluate('window.__sent.length')
    page.evaluate('window.__t = 1000.5')
    page.wait_for_function("window.__sent.length > %d" % before, timeout=5000)
    assert [r['text'] for m in page.evaluate('window.__sent')[before:] for r in m['rows']] == ['Far away']
    page.wait_for_function("document.querySelector('#movie_player [data-vietweb-ui]').shadowRoot.textContent.includes('VI: Far away')", timeout=3000)
    # settings apply live: translated-only → off → bilingual again (track is kept)
    page.evaluate("window.__store={youtubeMode:'translated'}; window.__listeners.forEach(f=>f({youtubeMode:{}},'local'))")
    page.wait_for_function("document.querySelector('#movie_player [data-vietweb-ui]').shadowRoot.querySelectorAll('.line').length === 1", timeout=3000)
    assert lines(page) == ['VI: Far away'], lines(page)
    page.evaluate("window.__store={youtubeMode:'off'}; window.__listeners.forEach(f=>f({youtubeMode:{}},'local'))")
    page.wait_for_timeout(500)
    assert not lines(page), lines(page)
    assert not page.evaluate("document.documentElement.hasAttribute('data-vietweb-yt')"), 'native captions return when off'
    page.evaluate("window.__store={youtubeMode:'bilingual'}; window.__listeners.forEach(f=>f({youtubeMode:{}},'local'))")
    page.wait_for_function("document.querySelector('#movie_player [data-vietweb-ui]')?.shadowRoot.querySelectorAll('.line').length === 2", timeout=4000)
    page.close()

    # Fallback: no track captured → translate the live caption text drawn by the player
    page = setup(browser)
    page.evaluate("document.querySelector('.ytp-caption-segment').textContent = 'Welcome back everyone'")
    page.wait_for_function("document.querySelector('#movie_player [data-vietweb-ui]')?.shadowRoot.textContent.includes('VI: Welcome back everyone')", timeout=5000)
    assert lines(page) == ['Welcome back everyone', 'VI: Welcome back everyone'], lines(page)
    live_rows = [r for m in page.evaluate('window.__sent') for r in m.get('rows', [])]
    assert [r['text'] for r in live_rows] == ['Welcome back everyone'], live_rows
    page.close()
    print('PASS: track ignore rules, windowed prefetch, bilingual overlay, seek, live settings, native caption hiding, live-caption fallback')
    browser.close()
