"""Chromium test (real IndexedDB): image translation cache. Counts model calls to prove repeated images cost nothing.
Run: python tests/image_cache_smoke.py   (set CHROMIUM_PATH on Windows)
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
bg = (ROOT / 'background.js').read_text(encoding='utf8').replace("importScripts('shared.js');", '')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
    page = browser.new_page()
    page.route('https://cache.test/**', lambda r: r.fulfill(body='<html></html>', content_type='text/html'))
    page.goto('https://cache.test/')
    page.evaluate("""window.chrome={storage:{local:{get:async d=>({...d,model:'m1',fallbackModels:'',apiKey:'k',streaming:false})}},
      tabs:{sendMessage:()=>Promise.resolve()},runtime:{onMessage:{addListener(){}}}};
      window.imgCalls=0; const realFetch = window.fetch.bind(window);
      window.fetch=async (url, req) => {
        if (!req || !req.body) return realFetch(url, req);
        imgCalls++;
        const reply = '[{"box_2d":[100,100,200,500],"src":"Sale","vi":"Giảm giá"}]';
        return {ok:true,status:200,headers:{get:()=>'application/json'},json:async()=>({choices:[{message:{content:reply}}],usage:{prompt_tokens:1100,completion_tokens:40}})};
      };""")
    page.add_script_tag(path=str(ROOT / 'shared.js'))
    page.add_script_tag(content=bg)
    r = page.evaluate("""async () => {
      const A = 'data:image/jpeg;base64,/9j/AAAA', B = 'data:image/jpeg;base64,/9j/BBBB';
      const run = data => translateImage({data}, newContext('t:0', null, {site: 'x.com'}));
      const out = {};
      out.first = await run(A);
      out.again = await run(A);
      out.other = await run(B);
      out.calls = imgCalls;
      out.metrics = metricsSummary();
      return out;
    }""")
    assert r['first']['cached'] is False and r['first']['regions'][0]['v'] == 'Giảm giá', r
    assert r['again']['cached'] is True and r['again']['regions'][0]['b'] == [100, 100, 200, 500], r
    assert r['other']['cached'] is False, r
    assert r['calls'] == 2, ('the repeated image must not call the model again', r['calls'])
    assert r['metrics']['images'] == 2 and r['metrics']['imageHits'] == 1, r['metrics']
    print('PASS: image result cached by content hash; repeated image makes zero model calls; counters tracked')
    browser.close()
