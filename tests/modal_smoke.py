"""Live Chromium DOM regression: dynamically injected login modal, button labels, presentation attrs."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
MOCK = r'''
window.__conf={enabled:true,autoMode:'all',excludedDomains:'',prefetchPixels:700,maxBatchChars:2600,maxBatchItems:8,concurrentRequests:3,siteModes:{},visualMode:'translate'};
window.__storageListeners=[]; window.__messageListeners=[];
window.chrome={storage:{local:{get:async(keys)=>keys===null?{...window.__conf}:{...keys,...window.__conf},set:async(x)=>{Object.assign(window.__conf,x);for(const f of window.__storageListeners) f(x,'local')}},onChanged:{addListener:(f)=>window.__storageListeners.push(f)}},runtime:{onMessage:{addListener:(f)=>window.__messageListeners.push(f)},sendMessage:async(msg)=>msg.type==='VIWEB_FRAME_CONTEXT'?{ok:true,topHost:'goofish.com'}:msg.type==='VIWEB_TRANSLATE'?{ok:true,translations:msg.rows.map(r=>({id:r.id,text:'VI: '+r.text})),cacheHits:0}:{ok:false}}};
'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1300,'height':800})
    page.set_content('<html><body><h1>欢迎来到闲鱼</h1><section id="app"></section></body></html>')
    page.evaluate(MOCK)
    page.add_script_tag(path=str(ROOT/'content.js'))
    page.wait_for_function("document.querySelector('h1').textContent.startsWith('VI:')")
    page.evaluate('''() => {
      document.querySelector('#app').innerHTML = `<div id="modal" role="dialog" aria-label="登录到您的账号">
        <h2>手机扫码安全登录</h2><button id="button" type="button" title="点击登录">登录账号</button>
        <input id="account" placeholder="请输入手机号码" value="MY_PRIVATE_VALUE" />
        <input id="password" type="password" placeholder="请输入密码" value="secret-example" />
      </div>`;
    }''')
    page.wait_for_function("document.querySelector('#modal h2').textContent.startsWith('VI:')",timeout=12000)
    page.wait_for_function("document.querySelector('#button').textContent.startsWith('VI:')",timeout=12000)
    page.wait_for_function("document.querySelector('#account').placeholder.startsWith('VI:')",timeout=12000)
    page.wait_for_function("document.querySelector('#button').title.startsWith('VI:')",timeout=12000)
    page.wait_for_function("document.querySelector('#modal').getAttribute('aria-label').startsWith('VI:')",timeout=12000)
    assert page.locator('#account').input_value() == 'MY_PRIVATE_VALUE'
    assert page.locator('#password').input_value() == 'secret-example'
    page.evaluate("chrome.storage.local.set({visualMode:'original'})")
    page.wait_for_function("document.querySelector('#account').placeholder==='请输入手机号码'",timeout=8000)
    page.wait_for_function("document.querySelector('#button').textContent==='登录账号'",timeout=8000)
    print('PASS: dynamic login modal, labels, buttons, placeholders, title, aria-label, form values unchanged, restore original')
    browser.close()
