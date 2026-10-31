"""Standalone UI screenshot/test with mocked chrome APIs; requires Playwright Chromium."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
MOCK = '''
window.__conf={};
window.chrome=window.chrome||{};
chrome.storage={onChanged:{addListener:()=>{}},local:{get:async(defaults)=>({...defaults,...window.__conf}),set:async(data)=>{Object.assign(window.__conf,data)}}};
chrome.runtime={sendMessage:async(msg)=>({ok:true,translation:'Xin chào thế giới.',cleared:true}),openOptionsPage:()=>{}};
chrome.tabs={query:async()=>[{id:1,url:'https://nodeseek.com'}],sendMessage:async()=>({ok:true,enabled:true,shown:12,cacheHits:8,queued:0,lastBatchMs:900,error:''})};
'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
 for name,width,height in [('options',1060,950),('popup',355,650)]:
  page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
  page.set_content((ROOT/(name+'.html')).read_text(encoding='utf8'))
  page.add_style_tag(content=(ROOT/'ui.css').read_text())
  page.evaluate('(()=>{'+MOCK+'})()')
  page.add_script_tag(path=str(ROOT/'shared.js'))
  page.add_script_tag(path=str(ROOT/(name+'.js')))
  page.wait_for_timeout(350)
  if name=='options':
   assert page.locator('#endpoint').input_value()=='http://127.0.0.1:8317/v1'
   assert page.locator('#model').input_value()=='gemini-3-flash'
   assert page.locator('input[name=autoMode][value=all]').is_checked()
   page.locator('[data-preset="fast"]').click()
   assert page.locator('#parallel-value').inner_text()=='4'
   page.locator('#apiKey').fill('do-not-commit-to-source')
   page.locator('#save').click()
   page.wait_for_function("window.__conf.apiKey === 'do-not-commit-to-source'")
   page.wait_for_function("document.querySelector('#result').textContent.includes('Đã lưu')")
   page.locator('#apiKey').fill('')
   page.locator('#save').click() # don't include fake key in screenshots
  else:
   assert page.locator('#translated').inner_text()=='12'
   assert page.locator('#latency').inner_text()=='0.9s'
  target=ROOT/'tests'/(name+'-preview.png')
  page.screenshot(path=str(target),full_page=True)
  print('PASS:',name,'screenshot:',target)
  page.close()
 browser.close()
