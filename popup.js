(async () => {
  const $ = id => document.getElementById(id);
  let tab, host, pageFirst = null;
  function status(s, error=false) { $('notice').textContent=s; $('notice').classList.toggle('error', error); }
  try {
    const tabs = await chrome.tabs.query({active:true,currentWindow:true});
    tab=tabs[0];
    if (!tab?.url || !/^https?:/i.test(tab.url)) throw new Error('Trang này không hỗ trợ dịch.');
    host=new URL(tab.url).hostname;
    $('hostname').textContent=host;
    const conf=await chrome.storage.local.get(null);
    const mode = VIWEB_mode(conf);
    $('site-toggle').checked = VIWEB_siteEnabled({...VIWEB_DEFAULTS, ...conf, autoMode:mode}, host);
    $('mode-hint').textContent = mode === 'all' ? 'Tất cả website, có ngoại lệ' :
      mode === 'selected' ? 'Chỉ website đã chọn · lưu theo tên miền' :
      'Đã tắt toàn bộ · bật trang này để chuyển sang chế độ chọn lọc';
    $('original-toggle').checked=conf.visualMode==='original';
    if (!conf.apiKey) status('API Key đang để trống; chỉ hoạt động nếu proxy cho phép.', true);
    const reply=await chrome.tabs.sendMessage(tab.id,{type:'VIWEB_STATUS'});
    if (reply) {
      $('translated').textContent=reply.shown;
      $('cached').textContent=reply.cacheHits;
      $('latency').textContent=reply.lastBatchMs ? (reply.lastBatchMs / 1000).toFixed(1) + 's' : '—';
      pageFirst = reply.firstShownMs;
      if (reply.error) status(reply.error, true);
      else if (reply.enabled) status('Đang dịch theo vùng đọc · CLIProxyAPI');
      else status('Đã tắt trên website này');
    }
    try {
      const stats = await chrome.runtime.sendMessage({type:'VIWEB_METRICS'});
      const m = stats?.metrics;
      if (m?.requests) {
        const s = ms => ms == null ? '—' : (ms / 1000).toFixed(1) + 's';
        $('metrics-line').textContent = `p50 ${s(m.p50)} · p95 ${s(m.p95)} · 429: ${m.rateLimited}` +
          (pageFirst != null ? ` · đầu tiên ${s(pageFirst)}` : '');
      }
    } catch { /* metrics are optional */ }
  } catch (err) { status(err.message || String(err), true); $('site-toggle').disabled=true; $('original-toggle').disabled=true; }
  async function refresh() {
    try { if (tab) await chrome.tabs.sendMessage(tab.id, {type:'VIWEB_RESYNC'}); }
    catch { /* page needs reload to inject extension */ }
  }
  $('site-toggle').addEventListener('change', async e => {
    if (!host) return;
    const conf=await chrome.storage.local.get({siteModes:{}});
    const mode = VIWEB_mode(conf);
    const modes = {...conf.siteModes};
    if (e.target.checked) modes[host] = 'auto';
    else if (mode === 'all') modes[host] = 'off';
    else delete modes[host];
    const next = {siteModes:modes};
    // Enabling a site while globally paused is an explicit opt-in: keep its
    // selection and resume only selected domains.
    if (e.target.checked && mode === 'off') next.autoMode = 'selected';
    try {
      await chrome.storage.local.set(next);
      await refresh();
      $('mode-hint').textContent = (next.autoMode === 'selected' || mode === 'selected')
        ? 'Chỉ website đã chọn · lưu theo tên miền' : 'Tất cả website, có ngoại lệ';
    } catch (err) {
      e.target.checked = !e.target.checked;
      status('Không lưu được lựa chọn: ' + (err.message || String(err)), true);
      return;
    }
    status(e.target.checked ? 'Đã lưu website vào danh sách dịch tự động' : 'Đã tắt dịch trên website và lưu lựa chọn');
  });
  $('original-toggle').addEventListener('change', async e => {
    await chrome.storage.local.set({visualMode:e.target.checked ? 'original' : 'translate'});
    await refresh(); status(e.target.checked ? 'Đang hiển thị bản gốc' : 'Đang hiển thị tiếng Việt');
  });
  $('rescan').addEventListener('click', async () => {
    try {
      const r=await chrome.tabs.sendMessage(tab.id,{type:'VIWEB_FORCE'});
      status(r?.ok ? 'Đã đưa các đoạn còn thiếu vào hàng đợi' : r?.error || 'Không thực hiện được', !r?.ok);
    } catch { status('Hãy tải lại website để khởi động extension.', true); }
  });
  $('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
})();
