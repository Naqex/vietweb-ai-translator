"""Chromium test: streamed fragments are applied before the batch reply arrives.
Run: python tests/stream_smoke.py   (set CHROMIUM_PATH on Windows)
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
MOCK = r'''
window.__conf={enabled:true,excludedDomains:'',prefetchPixels:700,maxBatchChars:2600,maxBatchItems:8,siteModes:{},visualMode:'translate'};
window.__listeners=[];window.__sent=[];window.__release=null;
window.chrome = window.chrome || {};
chrome.storage={local:{get:async k=>k===null?{...window.__conf}:{...(k||{}),...window.__conf},set:async()=>{}},onChanged:{addListener:()=>{}}};
chrome.runtime={id:'self',onMessage:{addListener:fn=>window.__listeners.push(fn)},sendMessage:async msg=>{
  if(msg.type==='VIWEB_CANCEL')return {ok:true};
  if(msg.type!=='VIWEB_TRANSLATE')return {ok:false};
  window.__sent.push(msg);
  const first=msg.rows[0];
  window.__listeners.forEach(fn=>fn({type:'VIWEB_PARTIAL',batchId:'forged-'+msg.batchId,items:[{id:first.id,text:'FORGED'}]},{id:'self'}));
  window.__listeners.forEach(fn=>fn({type:'VIWEB_PARTIAL',batchId:msg.batchId,items:[{id:first.id,text:'FORGED-SENDER'}]},{id:'other-extension'}));
  window.__listeners.forEach(fn=>fn({type:'VIWEB_PARTIAL',batchId:msg.batchId,items:[{id:first.id,text:'STREAM: '+first.text}]},{id:'self'}));
  await new Promise(resolve=>window.__release=resolve);
  return {ok:true,translations:msg.rows.map(r=>({id:r.id,text:'FINAL: '+r.text})),cacheHits:0};
}};
'''
HTML = '''<!DOCTYPE html><html lang="en"><head><title>Stream</title></head><body><main>
<p id="a">First paragraph arrives through the stream.</p>
<p id="b">Second paragraph waits for the final reply.</p></main></body></html>'''
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1000, 'height': 700})
    page.set_content(HTML)
    page.evaluate("(()=>{\n" + MOCK + "\n})()")
    page.add_script_tag(path=str(ROOT / 'content.js'))
    page.wait_for_function("window.__sent.length>0 && !!window.__release", timeout=12000)
    page.wait_for_function("document.querySelector('#a').textContent.startsWith('STREAM:')", timeout=5000)
    assert page.locator('#b').inner_text().startswith('Second paragraph'), 'only the streamed fragment may be shown early'
    sent = page.evaluate("window.__sent[0]")
    assert sent['priority'] == 0 and sent['batchId'], 'viewport batch must carry a batch id and top priority'
    page.evaluate("window.__release()")
    page.wait_for_function("document.querySelector('#b').textContent.startsWith('FINAL:')", timeout=5000)
    assert page.locator('#a').inner_text().startswith('STREAM:'), 'an already shown fragment must not be rewritten'
    print('PASS: streamed fragment shown early, forged/foreign partials ignored, remaining fragments finish from the final reply')
    browser.close()
