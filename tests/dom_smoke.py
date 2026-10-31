"""Fast Chromium DOM smoke test without relying on Chrome extension policy.
Run: python tests/dom_smoke.py
Exercises the real content script against a mock extension message bridge.
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
MOCK = r'''
window.__conf={enabled:true,excludedDomains:'',prefetchPixels:700,maxBatchChars:2600,maxBatchItems:8,siteModes:{},visualMode:'translate'};
window.__storageListeners=[];
window.__messageListeners=[];
window.chrome = window.chrome || {};
chrome.storage={local:{get:async(keys)=>{
  if(keys===null)return {...window.__conf};
  if(typeof keys==='object')return {...keys,...window.__conf};
  return window.__conf;
},set:async(changes)=>{Object.assign(window.__conf,changes);window.__storageListeners.forEach(fn=>fn(changes,'local'));}},onChanged:{addListener:(fn)=>window.__storageListeners.push(fn)}};
chrome.runtime={onMessage:{addListener:(fn)=>window.__messageListeners.push(fn)},sendMessage:async(msg)=>{
  if(msg.type==='VIWEB_TRANSLATE')return {ok:true,translations:msg.rows.map(r=>({id:r.id,text:'VI: '+r.text})),cacheHits:0};
  return {ok:false,error:'Unknown request'};
}};
window.__message = async msg => await new Promise(resolve=>{
  const fn=window.__messageListeners[0];const synchronous=fn(msg,{},resolve);
  if(!synchronous && msg.type==='VIWEB_STATUS')return;
});
'''
HTML='''<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body>
<main><h1 id="title">The technology documentation is comprehensive</h1>
<article><p id="chinese">这是一个测试文章，包含完整的中文内容。</p>
<p id="english">Hello, this is a long English paragraph with technical information.</p>
<p id="mixed">Welcome to <a href="#">the documentation portal</a> about installation.</p>
<pre id="code">const token = 'NEVER_TRANSLATE';</pre>
<p id="vietnamese">Đây là tiếng Việt và không cần phải dịch sang ngôn ngữ khác.</p>
<p id="hidden" style="display:none">Invisible sensitive content should never be sent to AI.</p>
<div contenteditable="true" id="editable">Do not translate this editing surface.</div>
</article></main></body></html>'''
with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1200,'height':860})
  page.set_content(HTML)
  page.evaluate("(()=>{\n" + MOCK + "\n})()")
  page.add_script_tag(path=str(ROOT/'content.js'))
  page.wait_for_function("document.querySelector('#chinese').textContent.startsWith('VI:')", timeout=12000)
  page.wait_for_function("document.querySelector('#english').textContent.startsWith('VI:')", timeout=12000)
  assert page.locator('#code').inner_text()=="const token = 'NEVER_TRANSLATE';"
  assert page.locator('#vietnamese').inner_text().startswith('Đây là tiếng Việt')
  assert page.locator('#hidden').inner_text()=='Invisible sensitive content should never be sent to AI.'
  assert page.locator('#editable').inner_text()=='Do not translate this editing surface.'
  assert page.locator('#mixed a').count()==1, 'Link must survive text-node replacement'
  page.evaluate("""() => {let p=document.createElement('p');p.id='dynamic';p.textContent='New dynamic content should also be translated.';document.querySelector('article').appendChild(p)}""")
  page.wait_for_function("document.querySelector('#dynamic').textContent.startsWith('VI:')", timeout=12000)
  page.evaluate("chrome.storage.local.set({visualMode:'original'})")
  page.wait_for_function("!document.querySelector('#chinese').textContent.startsWith('VI:')",timeout=8000)
  page.evaluate("chrome.storage.local.set({visualMode:'translate'})")
  page.wait_for_function("document.querySelector('#chinese').textContent.startsWith('VI:')",timeout=8000)
  page.evaluate("chrome.storage.local.set({siteModes:{'': 'off'}})")
  page.wait_for_function("!document.querySelector('#chinese').textContent.startsWith('VI:')",timeout=8000)
  print('PASS: auto, CJK, English, DOM links, hidden content, editable, dynamic, original toggle, site off')
  browser.close()
