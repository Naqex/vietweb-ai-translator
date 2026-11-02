/* VietWeb AI — image translation (v1.7).
 * Hover an image (or use auto mode / the right-click menu) → one multimodal call returns OCR + boxes + Vietnamese.
 * The translation is painted into a full-resolution copy of the picture and that copy REPLACES the <img> source
 * (blob URL), so zoom, lightboxes, "save image as" and drag-and-drop all get the translated picture.
 * Results are cached by image hash in the service worker. */
(() => {
  'use strict';
  const M = globalThis.VIWEB_MEDIA;
  if (!M || window.__vietwebImage) return;
  window.__vietwebImage = true;

  let conf = {...M.DEFAULTS};
  // img -> {status: idle|busy|done|empty|error, regions, showing, applied, urls:Set, orig, blobUrl, density}
  const states = new WeakMap();
  const translated = new Set(); // images whose source currently may be our translated copy
  let hoverImg = null, onPill = false, hideTimer = 0, raf = 0, pointer = null, pointerBusy = false;
  let autoCount = 0, autoRunning = 0;
  const autoQueue = [];

  const CSS = `
    :host{all:initial}
    .layer{position:fixed;inset:0;pointer-events:none;overflow:hidden;
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
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
  const sameImage = (st, img) => st.urls.has(imgSrc(img)) || st.urls.has(img.src);
  function dropState(img) {
    const st = states.get(img);
    st?.guard?.disconnect();
    if (st?.blobUrl) URL.revokeObjectURL(st.blobUrl);
    translated.delete(img);
    states.delete(img);
  }
  const stateOf = img => {
    let st = states.get(img);
    if (!st || !sameImage(st, img)) {
      dropState(img); // the page swapped the picture: forget the old translation
      st = {status: 'idle', regions: null, showing: true, applied: false, urls: new Set([imgSrc(img), img.src]), orig: null, blobUrl: '', density: 1};
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
    else if (st.status === 'done') { st.showing = !st.showing; applyShowing(img, st); refreshPill(img); }
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
    return {data: canvas.toDataURL('image/jpeg', 0.85)};
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
    const nw = img.naturalWidth, nh = img.naturalHeight;
    try { return {...encode(img, nw, nh), source: img, w: nw, h: nh}; }
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
    return {...encode(source, w, h), source, w, h};
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

  /* ---------- paint the translation into a full-resolution copy ---------- */
  const FONT = '-apple-system, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  function wrapLines(ctx, text, maxW) {
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
      if (ctx.measureText(word).width > maxW) return null;
      const next = line ? line + ' ' + word : word;
      if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
  function layoutText(ctx, text, bw, bh) {
    let lo = 6, hi = Math.max(6, bh * 0.9), best = null;
    for (let i = 0; i < 10; i++) {
      const size = (lo + hi) / 2;
      ctx.font = `600 ${size}px ${FONT}`;
      const lines = wrapLines(ctx, text, bw);
      if (lines && lines.length * size * 1.18 <= bh) { best = {size, lines}; lo = size; } else hi = size;
    }
    if (best) return best;
    ctx.font = `600 6px ${FONT}`;
    return {size: 6, lines: wrapLines(ctx, text, Infinity) || [text]};
  }
  function paintRegions(ctx, canvas, regions) {
    const W = canvas.width, H = canvas.height, subtle = conf.imageStyle === 'subtle';
    const colors = regions.map(r => subtle ? {bg: 'rgba(0,0,0,.74)', fg: '#fff'} : sampleColors(canvas, r.b)); // sample before painting over
    const pad = Math.max(2, Math.round(Math.min(W, H) * 0.004));
    regions.forEach((region, i) => {
      const [y0, x0, y1, x1] = region.b;
      const left = Math.max(0, x0 / 1000 * W - pad), top = Math.max(0, y0 / 1000 * H - pad);
      const w = Math.min(W, x1 / 1000 * W + pad) - left, h = Math.min(H, y1 / 1000 * H + pad) - top;
      if (w < 4 || h < 4) return;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(left, top, w, h, Math.min(6, h * 0.15));
      ctx.fillStyle = colors[i].bg;
      ctx.fill();
      ctx.clip();
      const inner = Math.max(1, w * 0.02), {size, lines} = layoutText(ctx, region.v, w - inner * 2, h);
      ctx.fillStyle = colors[i].fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lh = size * 1.18, y = top + h / 2 - ((lines.length - 1) * lh) / 2;
      lines.forEach((text, n) => ctx.fillText(text, left + w / 2, y + n * lh, w));
      ctx.restore();
    });
  }
  async function bake(source, w, h, regions, cssW) {
    const s = Math.min(1, 4096 / Math.max(w, h), Math.sqrt(16e6 / (w * h)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * s));
    canvas.height = Math.max(1, Math.round(h * s));
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    paintRegions(ctx, canvas, regions);
    const png = canvas.width * canvas.height <= 3e6; // screenshots stay lossless, big photos stay small
    const blob = await new Promise(res => canvas.toBlob(res, png ? 'image/png' : 'image/jpeg', 0.92));
    if (!blob) throw new Error('Không tạo được ảnh đã dịch.');
    return {blob, density: canvas.width / Math.max(1, cssW)};
  }

  /* ---------- swap the picture the page shows ---------- */
  const setAttr = (el, name, value) => { if (value == null) el.removeAttribute(name); else el.setAttribute(name, value); };
  /* Sites like X draw the picture as a CSS background-image on a div and keep a transparent <img> on top:
     find those backgrounds (same file, or same box as the <img>) so they are swapped as well. */
  const pathKey = u => { try { const x = new URL(u, location.href); return x.origin + x.pathname; } catch { return u; } };
  const bgUrls = value => [...value.matchAll(/url\((["']?)(.*?)\1\)/g)].map(m => m[2]);
  function collectBackgrounds(img, st, current) {
    const keys = new Set([...st.urls, current].filter(Boolean).map(pathKey));
    const r = img.getBoundingClientRect(), roots = [];
    for (let el = img.parentElement, i = 0; el && i < 3 && el !== document.body && el !== document.documentElement; el = el.parentElement, i++) roots.push(el);
    const seen = new Set(), found = [];
    const check = el => {
      if (seen.has(el) || el === img || el.closest('[data-vietweb-ui]')) return;
      seen.add(el);
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') return;
      const urls = bgUrls(bg).filter(u => !/^data:image\/svg/i.test(u));
      if (!urls.length) return;
      const b = el.getBoundingClientRect();
      const sameBox = Math.abs(b.left - r.left) < 6 && Math.abs(b.top - r.top) < 6 && Math.abs(b.width - r.width) < 6 && Math.abs(b.height - r.height) < 6;
      if (urls.some(u => keys.has(pathKey(u))) || sameBox) found.push([el, el.style.getPropertyValue('background-image'), el.style.getPropertyPriority('background-image')]);
    };
    for (const root of roots) { check(root); let n = 0; for (const el of root.querySelectorAll('*')) { if (++n > 300) break; check(el); } }
    return found;
  }
  function captureOriginal(img, st) {
    const o = {src: img.getAttribute('src'), srcset: img.getAttribute('srcset'), sizes: img.getAttribute('sizes'), sources: [], link: null, bgs: []};
    if (img.parentElement?.tagName === 'PICTURE') for (const s of img.parentElement.querySelectorAll('source')) o.sources.push([s, s.getAttribute('srcset')]);
    const a = img.closest('a'), current = imgSrc(img);
    if (a && a.getAttribute('href') && (a.href === current || a.href === img.src)) o.link = [a, a.getAttribute('href')];
    o.bgs = collectBackgrounds(img, st, current);
    st.orig = o;
  }
  function showUrl(img, st, url) {
    img.removeAttribute('sizes');
    for (const [source] of st.orig.sources) source.removeAttribute('srcset');
    if (st.density > 1.02) img.setAttribute('srcset', `${url} ${st.density.toFixed(3)}x`); else img.removeAttribute('srcset');
    img.src = url;
    if (st.orig.link) st.orig.link[0].setAttribute('href', url);
    for (const [el] of st.orig.bgs) el.style.setProperty('background-image', `url("${url}")`, 'important');
  }
  function showOriginal(img, st) {
    const o = st.orig;
    setAttr(img, 'sizes', o.sizes);
    for (const [source, srcset] of o.sources) setAttr(source, 'srcset', srcset);
    setAttr(img, 'srcset', o.srcset);
    setAttr(img, 'src', o.src);
    if (o.link) setAttr(o.link[0], 'href', o.link[1]);
    for (const [el, value, priority] of o.bgs) { if (value) el.style.setProperty('background-image', value, priority); else el.style.removeProperty('background-image'); }
  }
  function waitLoad(img, ms = 8000) {
    return new Promise(resolve => {
      const done = ok => { clearTimeout(timer); img.removeEventListener('load', onLoad); img.removeEventListener('error', onError); resolve(ok); };
      const onLoad = () => done(true), onError = () => done(false), timer = setTimeout(() => done(false), ms);
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
    });
  }
  const blobToDataUrl = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  function applyShowing(img, st) {
    if (st.status !== 'done') return;
    const want = st.showing && conf.visualMode !== 'original' && enabled();
    if (want === st.applied) return;
    st.applied = want;
    if (want) showUrl(img, st, st.shownUrl); else showOriginal(img, st);
  }
  // Pages with a strict img-src CSP may refuse blob: URLs, so fall back to a data: URL.
  async function installTranslated(img, st, blob) {
    captureOriginal(img, st);
    st.blobUrl = URL.createObjectURL(blob);
    st.urls.add(st.blobUrl);
    st.shownUrl = st.blobUrl;
    showUrl(img, st, st.blobUrl);
    let ok = await waitLoad(img);
    if (!ok) {
      const dataUrl = await blobToDataUrl(blob);
      st.urls.add(dataUrl);
      st.shownUrl = dataUrl;
      showUrl(img, st, dataUrl);
      ok = await waitLoad(img);
      if (ok) { URL.revokeObjectURL(st.blobUrl); st.blobUrl = ''; }
    }
    if (!ok) {
      showOriginal(img, st);
      throw new Error('Trang này chặn việc thay ảnh (CSP).');
    }
    st.applied = true;
    translated.add(img);
    guardBackgrounds(img, st);
  }
  // React-style pages may rewrite the inline style or src after a re-render: put the translated picture back.
  function guardBackgrounds(img, st) {
    st.guard?.disconnect();
    const targets = [img, ...st.orig.bgs.map(b => b[0])];
    st.guard = new MutationObserver(() => {
      if (states.get(img) !== st || !st.applied || st.restoring) return;
      const broken = st.orig.bgs.some(([el]) => !el.style.backgroundImage.includes(st.shownUrl));
      if (broken) { st.restoring = true; for (const [el] of st.orig.bgs) el.style.setProperty('background-image', `url("${st.shownUrl}")`, 'important'); st.restoring = false; }
    });
    for (const el of targets) if (el !== img) st.guard.observe(el, {attributes: true, attributeFilter: ['style']});
  }
  function pruneDetached() {
    for (const img of [...translated]) if (!img.isConnected) dropState(img);
  }
  function loop() {
    raf = 0;
    placePill();
    if (hoverImg && ui && ui.pill.style.display !== 'none') raf = requestAnimationFrame(loop);
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
    const src = imgSrc(img), cssW = img.naturalWidth;
    try {
      const {data, source, w, h} = await imageData(img);
      const res = await M.send({type: 'VIWEB_IMAGE', data, page: {title: document.title.slice(0, 120)}});
      if (!res?.ok) throw new Error(res?.error || 'Dịch ảnh thất bại.');
      if (states.get(img) !== st || imgSrc(img) !== src) return;
      st.regions = res.regions || [];
      if (!st.regions.length) { st.status = 'empty'; refreshPill(img); return; }
      const {blob, density} = await bake(source, w, h, st.regions, cssW);
      if (states.get(img) !== st || imgSrc(img) !== src) return;
      st.density = density;
      await installTranslated(img, st, blob);
      st.status = 'done';
      st.showing = true;
      pruneDetached();
      applyShowing(img, st);
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
    for (const img of translated) { const st = states.get(img); if (st) applyShowing(img, st); }
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'VIWEB_IMAGE_CONTEXT') return;
    const url = String(msg.srcUrl || '');
    const candidates = [...document.images].filter(img => imgSrc(img) === url || img.src === url);
    const img = candidates.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    if (!img) { toast('Không tìm thấy thẻ <img> — ảnh nền CSS chưa được hỗ trợ.'); return; }
    if (!img.complete || !img.naturalWidth) { toast('Ảnh chưa tải xong.'); return; }
    const st = stateOf(img);
    if (st.status === 'done') { st.showing = !st.showing; applyShowing(img, st); refreshPill(img); return; }
    translate(img);
  });
  document.addEventListener('pointermove', onPointerMove, {passive: true, capture: true});
  document.addEventListener('scroll', () => { if (hoverImg) startLoop(); }, {passive: true, capture: true});
  M.onSettings(async () => { conf = await M.load(); applyMode(); });
  M.load().then(c => { conf = c; applyMode(); });
})();
