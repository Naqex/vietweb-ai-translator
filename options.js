/* VietWeb AI settings (v1.1.1). All controls autosave. Writes are serialized so an
 * older delayed save cannot overwrite a newer choice. Only settings owned by this
 * page are written, preserving siteModes edited in the popup. */
(() => {
  const $ = id => document.getElementById(id);
  const perfKeys = ['concurrentRequests', 'maxBatchChars', 'maxBatchItems', 'firstBatchItems', 'timeoutSeconds', 'prefetchPixels'];
  let conf = {...VIWEB_DEFAULTS};
  let preset = 'balanced';
  let initialized = false;
  let siteModes = {};
  let editRevision = 0;
  let saveTimer = null;
  let writeChain = Promise.resolve();

  function notify(text, failure = false) {
    for (const id of ['save-state', 'perf-status']) {
      const el = $(id);
      if (!el) continue;
      el.textContent = text;
      el.classList.toggle('failure', failure);
    }
    $('result').textContent = text;
    $('result').classList.toggle('failure', failure);
  }

  function display() {
    $('endpoint').value = conf.endpoint;
    $('model').value = conf.model;
    $('fallbackModels').value = conf.fallbackModels || '';
    $('streaming').checked = conf.streaming !== false;
    $('apiKey').value = conf.apiKey;
    $('excludedDomains').value = conf.excludedDomains;
    $('customPrompt').value = conf.customPrompt;
    document.querySelector('input[name=autoMode][value=' + conf.autoMode + ']').checked = true;
    $('parallel-value').textContent = conf.concurrentRequests;
    $('chars-value').textContent = Number(conf.maxBatchChars).toLocaleString('vi-VN');
    $('first-value').textContent = conf.firstBatchItems;
    $('prefetch-value').textContent = conf.prefetchPixels + 'px';
    $('timeout-value').textContent = conf.timeoutSeconds + 's';
    document.querySelectorAll('.segment').forEach(el => {
      el.classList.toggle('selected', el.dataset.preset === preset);
      el.setAttribute('aria-pressed', String(el.dataset.preset === preset));
    });
  }

  // Never overwrite popup-managed siteModes or settings introduced in later versions.
  function collect() {
    const value = {
      autoMode: document.querySelector('input[name=autoMode]:checked')?.value || 'all',
      endpoint: $('endpoint').value.trim(),
      model: $('model').value.trim(),
      fallbackModels: $('fallbackModels').value.trim(),
      streaming: $('streaming').checked,
      apiKey: $('apiKey').value.trim(),
      excludedDomains: $('excludedDomains').value.trim(),
      customPrompt: $('customPrompt').value.trim()
    };
    for (const key of perfKeys) value[key] = conf[key];
    return value;
  }

  function validate(value) {
    if (!value.endpoint || !value.model) throw new Error('Cần nhập endpoint và model.');
    let url;
    try { url = new URL(value.endpoint); }
    catch { throw new Error('Endpoint phải là URL hợp lệ.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Endpoint phải dùng HTTP hoặc HTTPS.');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new Error('Chỉ dùng HTTP với localhost; máy chủ bên ngoài cần HTTPS.');
  }

  // Writes are queued in editing order even when the previous write is slow.
  async function persist() {
    if (!initialized) return;
    clearTimeout(saveTimer);
    const revision = editRevision;
    const value = collect();
    try {
      validate(value);
      notify('Đang lưu…');
      const write = writeChain.then(() => chrome.storage.local.set(value));
      writeChain = write.catch(() => {});
      await write;
      if (revision === editRevision) {
        conf = {...conf, ...value};
        notify('Đã lưu tự động ✓');
      }
      return true;
    } catch (error) {
      if (revision === editRevision) notify('Không thể lưu: ' + (error.message || String(error)), true);
      throw error;
    }
  }

  function changed(delay = 600) {
    if (!initialized) return;
    editRevision++;
    clearTimeout(saveTimer);
    notify('Có thay đổi · đang chờ lưu…');
    saveTimer = setTimeout(() => { void persist().catch(() => {}); }, delay);
  }

  document.querySelectorAll('.segment').forEach(el => el.addEventListener('click', () => {
    if (!initialized) return;
    const next = el.dataset.preset;
    if (!VIWEB_PRESETS[next]) return;
    // Capture current unsaved text fields before the preset redraws the UI.
    conf = {...conf, ...collect(), ...VIWEB_PRESETS[next]};
    preset = next;
    display();
    changed(0); // One click persists performance immediately.
  }));

  $('save-performance').addEventListener('click', () => {
    if (initialized) void persist().catch(() => {});
  });
  for (const id of ['endpoint', 'model', 'fallbackModels', 'apiKey', 'excludedDomains', 'customPrompt']) {
    $(id).addEventListener('input', () => changed(650));
    $(id).addEventListener('change', () => changed(0));
  }
  $('streaming').addEventListener('change', () => changed(0));
  document.querySelectorAll('input[name=autoMode]').forEach(input => input.addEventListener('change', () => changed(0))); 
  $('toggle-key').addEventListener('click', () => {
    const visible = $('apiKey').type === 'text';
    $('apiKey').type = visible ? 'password' : 'text';
    $('toggle-key').textContent = visible ? 'Hiện' : 'Ẩn';
  });
  $('save').addEventListener('click', () => { void persist().catch(() => {}); });
  $('test').addEventListener('click', async () => {
    $('test').disabled = true;
    try {
      await persist();
      notify('Đang kiểm tra kết nối CLIProxyAPI…');
      const result = await chrome.runtime.sendMessage({type: 'VIWEB_TEST'});
      if (!result?.ok) throw new Error(result?.error || 'Không kết nối được API.');
      notify('Đã lưu · Kết nối thành công: “' + (result.translation || 'Xin chào thế giới.') + '”');
    } catch (error) { notify(error.message || String(error), true); }
    finally { $('test').disabled = false; }
  });
  $('load-models').addEventListener('click', async () => {
    $('load-models').disabled = true;
    try {
      await persist();
      notify('Đang tải danh sách model…');
      const result = await chrome.runtime.sendMessage({type: 'VIWEB_MODELS'});
      if (!result?.ok) throw new Error(result?.error || 'Không lấy được danh sách model.');
      $('model-list').replaceChildren(...result.models.map(id => Object.assign(document.createElement('option'), {value: id})));
      notify(`Có ${result.models.length} model. Chọn từ gợi ý ở ô Model ID (thêm hậu tố như (low) nếu muốn).`);
    } catch (error) { notify(error.message || String(error), true); }
    finally { $('load-models').disabled = false; }
  });
  const fmt = (n, d = 0) => n === null || n === undefined ? '—' : Number(n).toLocaleString('vi-VN', {maximumFractionDigits: d});
  const sec = ms => ms === null || ms === undefined ? '—' : (ms / 1000).toFixed(2) + 's';
  async function renderMetrics(action = 'VIWEB_METRICS') {
    try {
      const res = await chrome.runtime.sendMessage({type: action});
      if (!res?.ok || !res.metrics) throw new Error(res?.error || 'Không đọc được thống kê.');
      const m = res.metrics;
      const cells = [
        ['Request API', fmt(m.requests)], ['Thành công / lỗi', `${fmt(m.ok)} / ${fmt(m.failed)}`],
        ['Latency p50 / p95', `${sec(m.p50)} / ${sec(m.p95)}`], ['Retry', fmt(m.retries)],
        ['Lỗi 429', fmt(m.rateLimited)], ['Chuyển model dự phòng', fmt(m.fallbacks)],
        ['Cache hit', m.hitRate === null ? '—' : Math.round(m.hitRate * 100) + '% (' + fmt(m.cacheHits) + ')'],
        ['Token vào / ra', `${fmt(m.tokensIn)} / ${fmt(m.tokensOut)}`],
        ['Đoạn thiếu sau retry', fmt(m.missing)], ['Request bị hủy (đổi trang)', fmt(m.cancelled)]
      ];
      $('metrics-grid').replaceChildren(...cells.map(([label, value]) => {
        const box = document.createElement('div');
        const l = document.createElement('span'); l.textContent = label;
        const v = document.createElement('strong'); v.textContent = value;
        box.append(l, v); return box;
      }));
      $('metrics-concurrency').textContent = m.ceiling ? `Song song ${m.concurrency}/${m.ceiling}` : 'Chưa có request';
    } catch (error) { $('metrics-grid').textContent = error.message || String(error); }
  }
  $('metrics-refresh').addEventListener('click', () => void renderMetrics());
  $('metrics-reset').addEventListener('click', () => void renderMetrics('VIWEB_METRICS_RESET'));
  $('clear-cache').addEventListener('click', async () => {
    try {
      const result = await chrome.runtime.sendMessage({type: 'VIWEB_CLEAR_CACHE'});
      $('cache-status').textContent = result?.ok ? 'Đã xóa cache.' : (result?.error || 'Không xóa được.');
    } catch (error) { $('cache-status').textContent = String(error); }
  });

  function renderSites() {
    const list = $('site-list');
    list.replaceChildren();
    const domains = Object.keys(siteModes).filter(host => siteModes[host] === 'auto').sort();
    $('site-count').textContent = `${domains.length} website`;
    if (!domains.length) {
      const empty = document.createElement('span'); empty.className = 'help';
      empty.textContent = 'Chưa có website nào được chọn. Thêm tên miền ở trên hoặc bật trong popup.';
      list.append(empty); return;
    }
    for (const host of domains) {
      const item = document.createElement('div'); item.className = 'site-item';
      const name = document.createElement('span'); name.textContent = host;
      const remove = document.createElement('button'); remove.type = 'button';
      remove.textContent = 'Xóa'; remove.className = 'text-remove';
      remove.setAttribute('aria-label', `Bỏ ${host} khỏi danh sách`);
      remove.addEventListener('click', () => void changeSite(host, false));
      item.append(name, remove); list.append(item);
    }
  }
  async function changeSite(host, add) {
    const label = $('site-list-status');
    try {
      // Read the newest map so popup changes are not erased by an older Options tab.
      const fresh = await chrome.storage.local.get({siteModes:{}});
      const updated = {...fresh.siteModes};
      if (add) updated[host] = 'auto'; else delete updated[host];
      await chrome.storage.local.set({siteModes:updated});
      siteModes = updated;
      renderSites();
      label.textContent = add ? `Đã lưu ${host}.` : `Đã xóa ${host}.`;
    } catch (err) { label.textContent = 'Không thể lưu danh sách: ' + (err.message || String(err)); }
  }
  $('add-site-form').addEventListener('submit', event => {
    event.preventDefault();
    const host = VIWEB_cleanHost($('new-site').value);
    if (!host) { $('site-list-status').textContent = 'Tên miền không hợp lệ (ví dụ: nodeseek.com).'; return; }
    $('new-site').value = '';
    void changeSite(host, true);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.siteModes) return;
    siteModes = changes.siteModes.newValue || {};
    renderSites();
  });

  chrome.storage.local.get(null).then(values => {
    conf = {...VIWEB_DEFAULTS, ...values, autoMode: VIWEB_mode(values)};
    siteModes = values.siteModes || {};
    renderSites();
    preset = Object.keys(VIWEB_PRESETS).find(key => perfKeys.every(p => VIWEB_PRESETS[key][p] === conf[p])) || 'balanced';
    display();
    initialized = true;
    void renderMetrics();
    notify('Tất cả thay đổi sẽ được lưu tự động');
  }).catch(error => notify('Không đọc được cấu hình: ' + (error.message || String(error)), true));
})();
