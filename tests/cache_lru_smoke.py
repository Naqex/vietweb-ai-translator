"""Chromium test (real IndexedDB): cache trimming is LRU, not FIFO.
Run: python tests/cache_lru_smoke.py   (set CHROMIUM_PATH on Windows)
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
    page.evaluate("window.chrome={storage:{local:{get:async d=>d,set:async()=>{}}},tabs:{sendMessage:()=>Promise.resolve()},runtime:{onMessage:{addListener(){}}}}")
    page.add_script_tag(path=str(ROOT / 'shared.js'))
    page.add_script_tag(content=bg)
    result = page.evaluate("""async () => {
      const put = async (k, at) => { const db = await openDB();
        await new Promise((res, rej) => { const r = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put({key: k, value: 'v' + k, at}); r.onsuccess = res; r.onerror = () => rej(r.error); }); };
      const old = Date.now() - 3600e3;
      for (let i = 0; i < 300; i++) await put('k' + i, old + i);   // k0 is the oldest
      const hit = await cacheGetMany(['k0', 'missing']);            // touching k0 makes it the newest
      await new Promise(r => setTimeout(r, 100));
      await trimCache(200);
      const left = await cacheGetMany(['k0', 'k1', 'k100', 'k299']);
      return {hit, left};
    }""")
    assert result['hit'] == ['vk0', None], result
    assert result['left'][0] == 'vk0', 'recently used entry must survive trimming'
    assert result['left'][1] is None, 'oldest untouched entry must be evicted'
    assert result['left'][3] == 'vk299'
    print('PASS: batch read returns hits/misses, hit refreshed, trimming evicts least recently used')
    browser.close()
