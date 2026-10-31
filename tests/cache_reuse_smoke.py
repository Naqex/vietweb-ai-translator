"""Chromium test (real IndexedDB): translation reuse. Counts model calls to prove tokens are saved.
Run: python tests/cache_reuse_smoke.py   (set CHROMIUM_PATH on Windows)
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
      window.sent=[]; const realFetch = window.fetch.bind(window);
      window.fetch=async (url, req) => {
        if (!req || !req.body) return realFetch(url, req);
        const user = JSON.parse(JSON.parse(req.body).messages[1].content);
        sent.push(user.items.map(i => i.t));
        const out = Object.fromEntries(user.items.map(i => [String(i.n), /[\\u4e00-\\u9fff]/.test(i.t) ? i.t : 'VI: ' + i.t.trim()]));
        return {ok:true,status:200,headers:{get:()=>'application/json'},json:async()=>({choices:[{message:{content:JSON.stringify(out)}}],usage:{prompt_tokens:10,completion_tokens:5}})};
      };""")
    page.add_script_tag(path=str(ROOT / 'shared.js'))
    page.add_script_tag(content=bg)
    result = page.evaluate("""async () => {
      const LONG = 'This is a deliberately long paragraph that is well over one hundred characters so that it is shared between all sites.';
      const run = async (rows, site, context = '') => {
        const before = sent.length;
        const r = await translateBatch(rows.map((t, i) => ({id: 'r' + i, text: t, context})), newContext('t:0', null, {site}));
        return {texts: r.translations.map(t => t.text), calls: sent.length - before, hits: r.cacheHits};
      };
      const out = {};
      out.first = await run([LONG, 'Reply'], 'a.com');
      // whitespace/Unicode noise and different surrounding context must still hit
      out.noise = await run(['  ' + LONG.replace(/ /g, '  ') + ' ', 'Reply\\u00a0'], 'a.com', 'completely different context');
      // long text is shared across sites; short UI text is site-scoped
      out.otherSite = await run([LONG, 'Reply'], 'b.com');
      // a skipped (untranslated) CJK fragment is shown but never persisted
      out.cjk1 = await run(['这是一个没有被翻译的句子'], 'a.com');
      out.cjk2 = await run(['这是一个没有被翻译的句子'], 'a.com');
      out.saved = metricsSummary().tokensSaved;
      out.entries = await cacheCount();
      return out;
    }""")
    r = result
    assert r['first']['calls'] == 1 and r['first']['hits'] == 0, r
    assert r['noise']['calls'] == 0 and r['noise']['hits'] == 2, ('whitespace/context noise must hit the cache', r['noise'])
    assert r['otherSite']['hits'] == 1 and r['otherSite']['calls'] == 1, ('long shared, short site-scoped', r['otherSite'])
    assert r['cjk1']['texts'] == ['这是一个没有被翻译的句子'] and r['cjk2']['calls'] == 1, ('untranslated output must not be cached', r)
    assert r['saved'] > 0, r
    assert r['entries'] == 3, ('LONG, Reply@a.com, Reply@b.com only', r['entries'])
    print('PASS: normalised keys, context-insensitive hits, long text shared across sites, short text per site, no poisoning by untranslated output, token savings counted')
    browser.close()
