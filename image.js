/* VietWeb AI — image translation (v1.6).
 * Hover an image (or use auto mode / the right-click menu) → one multimodal call returns OCR + boxes + Vietnamese,
 * which is drawn back over the image. Results are cached by image hash in the service worker. */
(() => {
  'use strict';
  const M = globalThis.VIWEB_MEDIA;
  if (!M || window.__vietwebImage) return;
  window.__vietwebImage = true;

  let conf = {...M.DEFAULTS};
  const states = new WeakMap(); // img -> {status: idle|busy|done|empty|error, regions, showing, src}
  const overlays = new Map();   // img -> overlay record (only images that currently have a drawn translation)
  let hoverImg = null, onPill = false, hideTimer = 0, raf = 0, pointer = null, pointerBusy = false;
  let autoCount = 0, autoRunning = 0;
  const autoQueue = [];

  const CSS = `
    :host{all:initial}
    .layer{position:fixed;inset:0;pointer-events:none;overflow:hidden;
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
    .ov{position:fixed;overflow:hidden;pointer-events:none;display:none}
    .in{position:absolute;container-type:size}
    .reg{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;overflow:hidden;
      border-radius:3px;line-height:1.15;text-align:center;font-weight:600}
    .t{width:100%;overflow-wrap:anywhere;padding:0 1px}
    .pill{position:fixed;display:none;pointer-events:auto;cursor:pointer;border:0;border-radius:999px;padding:6px 12px;
      font:600 12px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;letter-spacing:.01em;
      color:#1d1d1f;background:rgba(255,255,255,.86);-webkit-backdrop-filter:saturate(180%) blur(14px);
      backdrop-filter:saturate(180%) blur(14px);box-shadow:0 2px 10px rgba(0,0,0,.22),0 0 0 .5px rgba(0,0,0,.12);
      transition:transform .12s ease,background .12s ease}
    .pill:hover{transform:scale(1.04)}
    .pill[disabled]{cursor:default;opacity:.85}
    .pill.busy{animation:pulse 1.1s ease-in-out infinite}
    .pill.err{color:#c4271c}
    .toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);padding:9px 16px;border-radius:12px;font:500 13px/1.3 -apple-system,sans-serif;
      color:#fff;background:rgba(30,30,32,.9);box-shadow:0 6px 24px rgba(0,0,0,.3)}
    @keyframes pulse{50%{opacity:.55}}
    @media (prefers-color-scheme:dark){.pill{color:#f5f5f7;background:rgba(44,44,46,.88)}.pill.err{color:#ff6961}}`;
  let ui = null;
  function ensureUi() {
    if (ui && ui.host.isConnected) return ui;
    const {host, root} = M.shadowHost(CSS, 'position:fixed;inset:0;width:0;height:0;z-index:2147483000;pointer-events:none;');
    const layer = document.createElement('div');
    layer.className = 'layer';
    const pill = document.createElement('button');
    pill.className = 'pill';
    pill.type = 'button';
    pill.addEventListener('pointerenter', () => { onPill = true; clearTimeout(hideTimer); });
    pill.addEventListener('pointerleave', () => { onPill = false; scheduleHide(); });
    pill.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (hoverImg) pillAction(hoverImg); });
    root.append(layer, pill);
    (document.body || document.documentElement).append(host);
    ui = {host, root, layer, pill};
    return ui;
  }

  const enabled = () => M.allowed(conf, location.hostname) && conf.imageMode !== 'off';
  const imgSrc = img => img.currentSrc || img.src || '';
  function eligible(img) {
    if (!(img instanceof HTMLImageElement) || !img.complete || !img.naturalWidth || img.closest('[data-vietweb-ui]')) return false;
    const min = Math.max(48, Number(conf.imageMinSize) || 160), r = img.getBoundingClientRect();
    return r.width >= min && r.height >= min * 0.6 && img.naturalWidth >= 64;
  }
  const stateOf = img => {
    let st = states.get(img);
    if (!st || st.src !== imgSrc(img)) {
      removeOverlay(img);
      st = {status: 'idle', regions: null, showing: true, src: imgSrc(img)};
      states.set(img, st);
    }
    return st;
  };

  /* ---------- pill ---------- */
  const LABELS = {idle: 'Dịch ảnh', busy: 'Đang dịch…', empty: 'Không thấy chữ', error: 'Thử lại'};
  function pillLabel(st) { return st.status === 'done' ? (st.showing ? 'Xem bản gốc' : 'Xem bản dịch') : LABELS[st.status]; }
  function showPill(img) {
    if (!enabled() || !eligible(img)) return;
    hoverImg = img;
    clearTimeout(hideTimer);
    const {pill} = ensureUi(), st = stateOf(img);
    pill.textContent = pillLabel(st);
    pill.disabled = st.status === 'busy' || st.status === 'empty';
    pill.className = 'pill' + (st.status === 'busy' ? ' busy' : '') + (st.status === 'error' ? ' err' : '');
    pill.style.display = 'block';
    placePill();
    startLoop();
  }
  function hidePill() { hoverImg = null; if (ui) ui.pill.style.display = 'none'; }
  function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!onPill) hidePill(); }, 280); }
  function placePill() {
    if (!hoverImg || !ui) return;
    if (!hoverImg.isConnected) { hidePill(); return; }
    const r = hoverImg.getBoundingClientRect();
    const right = Math.min(r.right, innerWidth), top = Math.max(r.top, 0);
    if (r.bottom < 24 || r.top > innerHeight - 24 || right < 60) { ui.pill.style.display = 'none'; return; }
    ui.pill.style.display = 'block';
    ui.pill.style.right = Math.max(8, innerWidth - right + 8) + 'px';
    ui.pill.style.top = top + 8 + 'px';
  }
  function pillAction(img) {
    const st = stateOf(img);
    if (st.status === 'idle' || st.status === 'error') translate(img);
    else if (st.status === 'done') { st.showing = !st.showing; refreshPill(img); startLoop(); }
  }
  const refreshPill = img => { if (hoverImg === img) showPill(img); };

  /* ---------- hover detection ---------- */
  function onPointerMove(event) {
    if (!enabled() || event.pointerType === 'touch') return;
    pointer = [event.clientX, event.clientY];
    if (pointerBusy) return;
    pointerBusy = true;
    setTimeout(() => {
      pointerBusy = false;
      if (!pointer || onPill) return;
      let found = null;
      for (const el of document.elementsFromPoint(pointer[0], pointer[1])) {
        if (el instanceof HTMLImageElement) { found = el; break; }
        if (el === ui?.host) continue;
      }
      if (found && eligible(found)) { if (found !== hoverImg || ui?.pill.style.display === 'none') showPill(found); else clearTimeout(hideTimer); }
      else if (hoverImg) scheduleHide();
    }, 90);
  }

  /* ---------- image → base64 JPEG ---------- */
  function encode(source, w, h) {
    const max = Math.max(512, Number(conf.imageMaxSide) || 1536), scale = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return {data: canvas.toDataURL('image/jpeg', 0.85), canvas};
  }
  function dataUrlToBlob(url) {
    const [head, body] = url.split(',');
    const bin = atob(body), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], {type: /^data:([^;]+)/.exec(head)?.[1] || 'image/jpeg'});
  }
  async function decodeBlob(blob) {
    try { const bmp = await createImageBitmap(blob); return {source: bmp, w: bmp.width, h: bmp.height}; }
    catch { /* e.g. SVG: fall back to an <img> */ }
    const url = URL.createObjectURL(blob);
    try {
      const el = new Image();
      el.src = url;
      await el.decode();
      return {source: el, w: el.naturalWidth || 1024, h: el.naturalHeight || 1024};
    } finally { URL.revokeObjectURL(url); }
  }
  async function imageData(img) {
    try { return encode(img, img.naturalWidth, img.naturalHeight); }
    catch { /* cross-origin image taints the canvas: fetch the bytes instead */ }
    const src = imgSrc(img);
    let blob;
    try {
      const resp = await fetch(src, {credentials: 'omit'});
      if (!resp.ok) throw new Error('http ' + resp.status);
      blob = await resp.blob();
    } catch {
      const res = await M.send({type: 'VIWEB_FETCH_IMAGE', url: src});
      if (!res?.ok || !res.data) throw new Error(res?.error || 'Không tải được ảnh.');
      blob = dataUrlToBlob(res.data);
    }
    const {source, w, h} = await decodeBlob(blob);
    return encode(source, w, h);
  }

  /* ---------- colours sampled around each box so the translation blends in ---------- */
  function sampleColors(canvas, [y0, x0, y1, x1]) {
    const W = canvas.width, H = canvas.height, ctx = canvas.getContext('2d', {willReadFrequently: true});
    const pad = Math.max(2, Math.round(Math.min(W, H) * 0.012));
    const ix0 = Math.round(x0 / 1000 * W), ix1 = Math.round(x1 / 1000 * W), iy0 = Math.round(y0 / 1000 * H), iy1 = Math.round(y1 / 1000 * H);
    const ox0 = Math.max(0, ix0 - pad), oy0 = Math.max(0, iy0 - pad), ox1 = Math.min(W, ix1 + pad), oy1 = Math.min(H, iy1 + pad);
    if (ox1 <= ox0 || oy1 <= oy0) return {bg: '#fff', fg: '#111'};
    const {data} = ctx.getImageData(ox0, oy0, ox1 - ox0, oy1 - oy0), w = ox1 - ox0;
    const rs = [], gs = [], bs = [];
    const step = Math.max(1, Math.floor(((ox1 - ox0) * (oy1 - oy0)) / 600));
    for (let y = oy0, n = 0; y < oy1; y++) for (let x = ox0; x < ox1; x++, n++) {
      if (n % step) continue;
      if (x >= ix0 && x < ix1 && y >= iy0 && y < iy1) continue;
      const o = ((y - oy0) * w + (x - ox0)) * 4;
      rs.push(data[o]); gs.push(data[o + 1]); bs.push(data[o + 2]);
    }
    if (!rs.length) return {bg: '#fff', fg: '#111'};
    const med = a => a.sort((p, q) => p - q)[a.length >> 1];
    const r = med(rs), g = med(gs), b = med(bs);
    return {bg: `rgb(${r},${g},${b})`, fg: (0.299 * r + 0.587 * g + 0.114 * b) > 140 ? '#111' : '#fff'};
  }

  /* ---------- overlay ---------- */
  function buildOverlay(img, st, canvas) {
    const {layer} = ensureUi();
    removeOverlay(img);
    const el = document.createElement('div'), inner = document.createElement('div');
    el.className = 'ov';
    inner.className = 'in';
    el.append(inner);
    const subtle = conf.imageStyle === 'subtle', regs = [];
    for (const region of st.regions) {
      const reg = document.createElement('div'), text = document.createElement('div');
      reg.className = 'reg';
      text.className = 't';
      text.textContent = region.v;
      reg.append(text);
      const [y0, x0, y1, x1] = region.b, pad = 4;
      const top = Math.max(0, y0 - pad), left = Math.max(0, x0 - pad);
      reg.style.cssText = `top:${top / 10}%;left:${left / 10}%;height:${(Math.min(1000, y1 + pad) - top) / 10}%;width:${(Math.min(1000, x1 + pad) - left) / 10}%;`;
      const colors = region.colors || (region.colors = canvas ? sampleColors(canvas, region.b) : {bg: '#fff', fg: '#111'});
      reg.style.background = subtle ? 'rgba(0,0,0,.72)' : colors.bg;
      reg.style.color = subtle ? '#fff' : colors.fg;
      inner.append(reg);
      regs.push(reg);
    }
    layer.append(el);
    overlays.set(img, {el, inner, regs, geo: '', fitW: 0, fitTimer: 0});
  }
  function removeOverlay(img) {
    const ov = overlays.get(img);
    if (!ov) return;
    clearTimeout(ov.fitTimer);
    ov.el.remove();
    overlays.delete(img);
  }
  function fit(ov, cw) {
    for (const reg of ov.regs) {
      const text = reg.firstChild;
      let lo = 6, hi = 44, best = 6;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        reg.style.fontSize = mid + 'px';
        if (text.offsetHeight <= reg.clientHeight + 1 && text.scrollWidth <= text.clientWidth + 1) { best = mid; lo = mid; } else hi = mid;
      }
      reg.style.fontSize = (best / Math.max(1, cw)) * 100 + 'cqw';
    }
    ov.fitW = cw;
  }
  function updateOverlay(img, ov) {
    const st = states.get(img);
    if (!img.isConnected || !st || st.src !== imgSrc(img)) { removeOverlay(img); if (st) { st.status = 'idle'; st.regions = null; } return; }
    const r = img.getBoundingClientRect();
    if (!st.showing || conf.visualMode === 'original' || !enabled() || r.width < 24 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
      ov.el.style.display = 'none';
      ov.geo = '';
      return;
    }
    const cs = getComputedStyle(img), n = v => parseFloat(v) || 0;
    const bl = n(cs.borderLeftWidth) + n(cs.paddingLeft), bt = n(cs.borderTopWidth) + n(cs.paddingTop);
    const bw = r.width - bl - n(cs.borderRightWidth) - n(cs.paddingRight), bh = r.height - bt - n(cs.borderBottomWidth) - n(cs.paddingBottom);
    let cw = bw, ch = bh, cx = 0, cy = 0;
    const fitMode = cs.objectFit, nat = img.naturalWidth / img.naturalHeight;
    if (nat && ['contain', 'cover', 'scale-down'].includes(fitMode)) {
      const scale = fitMode === 'cover' ? Math.max(bw / img.naturalWidth, bh / img.naturalHeight)
        : Math.min(bw / img.naturalWidth, bh / img.naturalHeight, fitMode === 'scale-down' ? 1 : Infinity);
      cw = img.naturalWidth * scale; ch = img.naturalHeight * scale; cx = (bw - cw) / 2; cy = (bh - ch) / 2;
    }
    const geo = [r.left + bl, r.top + bt, bw, bh, cx, cy, cw, ch].map(v => Math.round(v * 10) / 10).join(',');
    if (geo === ov.geo) return;
    ov.geo = geo;
    ov.el.style.cssText = `display:block;left:${r.left + bl}px;top:${r.top + bt}px;width:${bw}px;height:${bh}px;`;
    ov.inner.style.cssText = `left:${cx}px;top:${cy}px;width:${cw}px;height:${ch}px;`;
    if (!ov.fitW) fit(ov, cw);
    else if (Math.abs(cw - ov.fitW) / ov.fitW > 0.3) { clearTimeout(ov.fitTimer); ov.fitTimer = setTimeout(() => fit(ov, cw), 220); }
  }
  function loop() {
    raf = 0;
    for (const [img, ov] of overlays) updateOverlay(img, ov);
    placePill();
    if (overlays.size || (hoverImg && ui && ui.pill.style.display !== 'none')) raf = requestAnimationFrame(loop);
  }
  function startLoop() { if (!raf) raf = requestAnimationFrame(loop); }

  /* ---------- translate ---------- */
  function toast(message) {
    const {layer} = ensureUi(), el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    layer.append(el);
    setTimeout(() => el.remove(), 3200);
  }
  async function translate(img, {auto = false} = {}) {
    const st = stateOf(img);
    if (st.status === 'busy' || st.status === 'done') return;
    st.status = 'busy';
    refreshPill(img);
    const src = st.src;
    try {
      const {data, canvas} = await imageData(img);
      const res = await M.send({type: 'VIWEB_IMAGE', data, page: {title: document.title.slice(0, 120)}});
      if (!res?.ok) throw new Error(res?.error || 'Dịch ảnh thất bại.');
      if (states.get(img) !== st || st.src !== imgSrc(img) || src !== st.src) return;
      st.regions = res.regions || [];
      if (!st.regions.length) { st.status = 'empty'; refreshPill(img); return; }
      st.status = 'done';
      st.showing = true;
      buildOverlay(img, st, canvas);
      startLoop();
    } catch (error) {
      if (states.get(img) !== st) return;
      st.status = auto ? 'idle' : 'error';
      if (!auto) toast(String(error?.message || error).slice(0, 120));
    }
    refreshPill(img);
  }

  /* ---------- auto mode: translate images as they scroll into view, capped per page ---------- */
  let observer = null, scanTimer = 0;
  const seen = new WeakSet();
  function drainAuto() {
    while (autoRunning < 2 && autoQueue.length && autoCount < (Number(conf.imageAutoLimit) || 0)) {
      const img = autoQueue.shift();
      if (!img.isConnected || !eligible(img) || stateOf(img).status !== 'idle') continue;
      autoCount++; autoRunning++;
      translate(img, {auto: true}).finally(() => { autoRunning--; drainAuto(); });
    }
  }
  function scan() {
    if (conf.imageMode !== 'auto' || !enabled()) return;
    observer ||= new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting && !autoQueue.includes(e.target)) { autoQueue.push(e.target); }
      drainAuto();
    }, {threshold: 0.3});
    for (const img of document.images) if (!seen.has(img)) { seen.add(img); observer.observe(img); }
  }
  function startScan() { clearInterval(scanTimer); scan(); scanTimer = setInterval(scan, 2500); }
  function stopScan() { clearInterval(scanTimer); observer?.disconnect(); observer = null; autoQueue.length = 0; }

  function applyMode() {
    if (conf.imageMode === 'auto' && enabled()) startScan(); else stopScan();
    if (!enabled()) hidePill();
    for (const [img, ov] of overlays) { ov.geo = ''; updateOverlay(img, ov); }
    if (overlays.size) startLoop();
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'VIWEB_IMAGE_CONTEXT') return;
    const url = String(msg.srcUrl || '');
    const candidates = [...document.images].filter(img => imgSrc(img) === url || img.src === url);
    const img = candidates.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    if (!img) { toast('Không tìm thấy thẻ <img> — ảnh nền CSS chưa được hỗ trợ.'); return; }
    if (!img.complete || !img.naturalWidth) { toast('Ảnh chưa tải xong.'); return; }
    const st = stateOf(img);
    if (st.status === 'done') { st.showing = !st.showing; startLoop(); return; }
    translate(img);
  });
  document.addEventListener('pointermove', onPointerMove, {passive: true, capture: true});
  document.addEventListener('scroll', () => { if (hoverImg) startLoop(); }, {passive: true, capture: true});
  M.onSettings(async () => { conf = await M.load(); applyMode(); });
  M.load().then(c => { conf = c; applyMode(); });
})();
