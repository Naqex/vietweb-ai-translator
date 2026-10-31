"""Integration-ish options UI test: real Chromium page, Chrome storage shim persisted in
a persistent test backing store across page reopenings. Requires Playwright + Chromium."""
import os
from pathlib import Path
import time
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

SCRIPT = r'''
window.chrome = {
  storage: {onChanged:{addListener:()=>{}}, local: {
    get: async (defaults) => Object.assign({}, defaults, await window.__readPersisted()),
    set: async (values) => {
      await new Promise(resolve => setTimeout(resolve, 35));
      await window.__writePersisted(values);
    }
  }},
  runtime: {sendMessage: async () => ({ok:true,translation:'Xin chào thế giới.',cleared:true})}
};
'''

def saved(store, key):
    return store.get(key)

def expect_saved(page, key, expected):
    deadline = time.time() + 8
    while time.time() < deadline:
        found = page.evaluate("async (key) => (await window.__readPersisted())[key]", key)
        if found == expected:
            return
        page.wait_for_timeout(100)
    raise AssertionError(f"Not persisted: {key} expected {expected}, got {found}")

def open_settings(context):
    page = context.new_page()
    page.set_content((ROOT / 'options.html').read_text(encoding='utf8'))
    page.add_style_tag(content=(ROOT / 'ui.css').read_text(encoding='utf8'))
    page.evaluate(SCRIPT)
    page.add_script_tag(path=str(ROOT / 'shared.js'))
    page.add_script_tag(path=str(ROOT / 'options.js'))
    page.wait_for_function("document.querySelector('#save-state').textContent.includes('Tất cả thay đổi')")
    return page

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        context = browser.new_context()
        store = {}
        context.expose_binding('__readPersisted', lambda source: dict(store))
        context.expose_binding('__writePersisted', lambda source, values: store.update(values))
        page = open_settings(context)
        assert page.locator('input[name=autoMode][value=all]').is_checked()
        assert page.locator('[data-preset="balanced"]').get_attribute('aria-pressed') == 'true'

        # Preset commits without pressing the remote save button.
        page.locator('[data-preset="fast"]').click()
        expect_saved(page, 'concurrentRequests', 4)
        expect_saved(page, 'maxBatchChars', 1800)
        page.close()
        page = open_settings(context)
        
        page.wait_for_function("document.querySelector('[data-preset=fast]').getAttribute('aria-pressed') === 'true'",timeout=1000)
        assert page.locator('#parallel-value').inner_text() == '4'

        # Every other setting automatically persists, including global toggle and prompt.
        page.locator('input[name=autoMode][value=selected]').check()
        expect_saved(page, 'autoMode', 'selected')
        page.locator('#excludedDomains').fill('example.com\nnodeseek.com')
        expect_saved(page, 'excludedDomains', 'example.com\nnodeseek.com')
        page.locator('details > summary').click()
        page.locator('#customPrompt').fill('Custom prompt for Vietnamese translation')
        expect_saved(page, 'customPrompt', 'Custom prompt for Vietnamese translation')
        page.locator('#apiKey').fill('test-client-key')
        expect_saved(page, 'apiKey', 'test-client-key')
        page.locator('#model').fill('gemini-3-flash')
        expect_saved(page, 'model', 'gemini-3-flash')
        page.close()
        page = open_settings(context)
        page.wait_for_function("document.querySelector('#model').value === 'gemini-3-flash'")
        assert page.locator('input[name=autoMode][value=selected]').is_checked()
        assert page.locator('#excludedDomains').input_value() == 'example.com\nnodeseek.com'
        assert page.locator('#customPrompt').input_value() == 'Custom prompt for Vietnamese translation'
        assert page.locator('#apiKey').input_value() == 'test-client-key'

        # Manual performance save works and records status.
        page.locator('[data-preset="quality"]').click()
        page.locator('#save-performance').click()
        expect_saved(page, 'maxBatchChars', 3600)
        page.wait_for_function("document.querySelector('#perf-status').textContent.includes('Đã lưu')")
        page.close()
        page = open_settings(context)
        page.wait_for_function("document.querySelector('[data-preset=quality]').getAttribute('aria-pressed') === 'true'")

        # Page's bulk saves must not overwrite the popup's per-site settings.
        store['siteModes'] = {'nodeseek.com':'off'}
        page.locator('#endpoint').fill('http://localhost:8317/v1')
        expect_saved(page, 'endpoint', 'http://localhost:8317/v1')
        assert saved(store, 'siteModes') == {'nodeseek.com':'off'}

        # Invalid endpoint is rejected; fixing it resumes autosave.
        page.locator('#endpoint').fill('this-is-not-a-url')
        page.wait_for_function("document.querySelector('#save-state').textContent.includes('Không thể lưu')")
        assert saved(store, 'endpoint') == 'http://localhost:8317/v1'
        page.locator('#endpoint').fill('http://127.0.0.1:8317/v1')
        expect_saved(page, 'endpoint', 'http://127.0.0.1:8317/v1')
        assert saved(store, 'siteModes') == {'nodeseek.com':'off'}
        print('PASS: preset autosave, all other fields autosave, reload persistence, manual button, no popup data overwrite, invalid endpoint handling')
        context.close()
        browser.close()
