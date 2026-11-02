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

  /* ---------- image → base64 JPEG tiles (very tall / wide pictures are cut so the text stays legible) ---------- */
  const MAX_TILES = 10;
  function tilePlan(w, h) {
    const max = Math.max(512, Number(conf.imageMaxSide) || 1536);
    const vertical = h >= w, long = vertical ? h : w, short = vertical ? w : h;
    let n = 1;
    if (long > max * 1.3 && long / short > 2.4) n = Math.min(MAX_TILES, Math.ceil(long / (short * 2)));
    const own = long / n, overlap = n > 1 ? Math.max(24, Math.round(own * 0.06)) : 0;
    return Array.from({length: n}, (_, i) => {
      const own0 = i * own, own1 = (i + 1) * own, start = Math.max(0, Math.floor(own0 - overlap)), end = Math.min(long, Math.ceil(own1 + overlap));
      return {vertical, start, len: end - start, own0, own1: i === n - 1 ? Infinity : own1};
    });
  }
  function encode(source, w, h) {
    const max = Math.max(512, Number(conf.imageMaxSide) || 1536);
    return tilePlan(w, h).map(tile => {
      const sw = tile.vertical ? w : tile.len, sh = tile.vertical ? tile.len : h;
      const scale = Math.min(1, max / Math.max(sw, sh));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sw * scale));
      canvas.height = Math.max(1, Math.round(sh * scale));
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, tile.vertical ? 0 : tile.start, tile.vertical ? tile.start : 0, sw, sh, 0, 0, canvas.width, canvas.height);
      return {...tile, data: canvas.toDataURL('image/jpeg', 0.85)};
    });
  }
  /* A region belongs to the tile whose own zone holds its centre; local 0-1000 boxes become whole-image boxes. */
  function mergeTiles(tiles, results, w, h) {
    const merged = [];
    tiles.forEach((tile, i) => {
      for (const region of results[i] || []) {
        const [y0, x0, y1, x1] = region.b, a = tile.vertical ? [y0, y1] : [x0, x1];
        const px = a.map(v => tile.start + v / 1000 * tile.len), mid = (px[0] + px[1]) / 2;
        if (tiles.length > 1 && (mid < tile.own0 || mid >= tile.own1)) continue;
        const g = v => Math.max(0, Math.min(1000, Math.round(v / (tile.vertical ? h : w) * 10000) / 10));
        merged.push({...region, b: tile.vertical ? [g(px[0]), x0, g(px[1]), x1] : [y0, g(px[0]), y1, g(px[1])]});
      }
    });
    return dedupe(merged);
  }
  /* The model sometimes returns the same block twice (or once per overlapping tile): keep the one with more source text. */
  function dedupe(list) {
    const area = r => Math.max(1, (r.b[2] - r.b[0]) * (r.b[3] - r.b[1]));
    const overlap = (p, q) => Math.max(0, Math.min(p.b[2], q.b[2]) - Math.max(p.b[0], q.b[0])) * Math.max(0, Math.min(p.b[3], q.b[3]) - Math.max(p.b[1], q.b[1]));
    const drop = new Set();
    list.forEach((p, i) => list.forEach((q, j) => {
      if (j <= i || drop.has(i) || drop.has(j)) return;
      const o = overlap(p, q);
      if (o / Math.min(area(p), area(q)) < 0.85 || Math.min(area(p), area(q)) / Math.max(area(p), area(q)) < 0.5) return;
      drop.add((p.s || '').length >= (q.s || '').length ? j : i);
    }));
    return list.filter((_, i) => !drop.has(i));
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
    try { return {tiles: encode(img, nw, nh), source: img, w: nw, h: nh}; }
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
    return {tiles: encode(source, w, h), source, w, h};
  }

  /* ---------- erase the original text: only the thin strokes are replaced, so buttons, borders and gradients stay intact ---------- */
  const relLum = (r, g, b) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrastOf = (a, b) => { const p = relLum(...a), q = relLum(...b); return (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05); };
  const rgb = c => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
  const darkOrLight = c => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) > 140 ? '#111' : '#fff';

  /* Separable min/max filter on a one-channel buffer; closing (dark text) and opening (light text) remove strokes thinner than the window. */
  function slide(src, w, h, r, horizontal, takeMax) {
    const out = new Uint8Array(src.length), len = horizontal ? w : h, lines = horizontal ? h : w, step = horizontal ? 1 : w, lineStep = horizontal ? w : 1;
    for (let l = 0; l < lines; l++) {
      const base = l * lineStep;
      for (let i = 0; i < len; i++) {
        let v = takeMax ? 0 : 255;
        for (let j = Math.max(0, i - r), e = Math.min(len - 1, i + r); j <= e; j++) { const p = src[base + j * step]; if (takeMax ? p > v : p < v) v = p; }
        out[base + i * step] = v;
      }
    }
    return out;
  }
  const morph = (src, w, h, r, takeMax) => slide(slide(src, w, h, r, true, takeMax), w, h, r, false, takeMax);
  function ringMedian(d, w, h) {
    const rs = [], gs = [], bs = [], t = Math.min(2, Math.max(1, h >> 2), Math.max(1, w >> 2));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x >= t && x < w - t && y >= t && y < h - t) continue;
      const o = (y * w + x) * 4; rs.push(d[o]); gs.push(d[o + 1]); bs.push(d[o + 2]);
    }
    const med = a => a.sort((p, q) => p - q)[a.length >> 1];
    return [med(rs), med(gs), med(bs)];
  }
  /* Fill every masked pixel by interpolating between the nearest unmasked pixels of its row and its column. */
  function inpaint(d, mask, w, h, fallback) {
    const est = new Float32Array(w * h * 3), cnt = new Uint8Array(w * h);
    const run = (horizontal) => {
      const len = horizontal ? w : h, lines = horizontal ? h : w, idx = (l, i) => horizontal ? l * w + i : i * w + l;
      for (let l = 0; l < lines; l++) {
        for (let i = 0; i < len;) {
          if (!mask[idx(l, i)]) { i++; continue; }
          let j = i;
          while (j < len && mask[idx(l, j)]) j++;
          const a = i > 0 ? idx(l, i - 1) * 4 : -1, b = j < len ? idx(l, j) * 4 : -1;
          if (a >= 0 || b >= 0) for (let k = i; k < j; k++) {
            const t = (k - i + 1) / (j - i + 1), p = idx(l, k);
            for (let c = 0; c < 3; c++) est[p * 3 + c] += a >= 0 && b >= 0 ? d[a + c] * (1 - t) + d[b + c] * t : d[(a >= 0 ? a : b) + c];
            cnt[p]++;
          }
          i = j;
        }
      }
    };
    run(true); run(false);
    const patch = new ImageData(w, h), avg = [0, 0, 0];
    let n = 0;
    for (let p = 0; p < w * h; p++) {
      if (!mask[p]) continue;
      for (let c = 0; c < 3; c++) { const v = cnt[p] ? est[p * 3 + c] / cnt[p] : fallback[c]; patch.data[p * 4 + c] = v; avg[c] += v; }
      patch.data[p * 4 + 3] = 255;
      n++;
    }
    return {patch, bg: n ? avg.map(v => v / n) : fallback};
  }

  /* Plan for one region: the padded area, the erase patch (null = solid fill), the real ink box, text colour, weight, alignment and size cap. */
  function prepareRegion(ctx, W, H, region, subtle) {
    const b = region.b, hint = region.a || 'c', ph = (b[2] - b[0]) / 1000 * H;
    const pad = Math.max(2, Math.min(8, Math.round(ph * 0.12)));
    const x0 = Math.max(0, Math.floor(b[1] / 1000 * W) - pad), y0 = Math.max(0, Math.floor(b[0] / 1000 * H) - pad);
    const x1 = Math.min(W, Math.ceil(b[3] / 1000 * W) + pad), y1 = Math.min(H, Math.ceil(b[2] / 1000 * H) + pad);
    const w = x1 - x0, h = y1 - y0, n = w * h;
    if (w < 4 || h < 4) return null;
    const area = {x0, y0, x1, y1, align: hint, weight: 600, ib: null};
    if (subtle) return {...area, solid: 'rgba(0,0,0,.74)', fg: '#fff'};
    const d = ctx.getImageData(x0, y0, w, h).data, edge = ringMedian(d, w, h), solid = {...area, solid: rgb(edge), fg: darkOrLight(edge)};
    const L = new Uint8Array(n);
    for (let i = 0; i < n; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    const r = Math.max(2, Math.min(16, Math.round(ph * 0.1)));
    const C = morph(morph(L, w, h, r, true), w, h, r, false), O = morph(morph(L, w, h, r, false), w, h, r, true);
    // one polarity only: otherwise the gaps between strokes look like thin light text on dark text
    let meanL = 0, darkN = 0, lightN = 0;
    const centre = [];
    for (let y = h >> 2; y < h - (h >> 2); y++) for (let x = w >> 2; x < w - (w >> 2); x++) centre.push(L[y * w + x]);
    const med = Uint8Array.from(centre.length ? centre : L).sort()[(centre.length || n) >> 1];
    for (let i = 0; i < n; i++) { meanL += L[i]; if (C[i] - L[i] > 28 && L[i] < med) darkN++; if (L[i] - O[i] > 28 && L[i] > med) lightN++; }
    meanL /= n;
    const edgeL = 0.299 * edge[0] + 0.587 * edge[1] + 0.114 * edge[2];
    const dark = Math.min(darkN, lightN) < 0.7 * Math.max(darkN, lightN) ? darkN > lightN : Math.abs(meanL - edgeL) > 0.5 ? meanL < edgeL : darkN <= lightN;
    const mask = new Uint8Array(n), diff = new Uint8Array(n);
    let count = 0, maxD = 0;
    for (let i = 0; i < n; i++) {
      const v = dark ? C[i] - L[i] : L[i] - O[i];
      diff[i] = Math.max(0, v);
      if (v > 18) { mask[i] = 255; count++; }
    }
    // long thin structures that merely cross a sloppy box (borders, rules, outlines) are not text: leave them alone
    const seenPx = new Uint8Array(n), stack = [];
    for (let s = 0; s < n; s++) {
      if (!mask[s] || seenPx[s]) continue;
      const comp = [];
      let cx0 = w, cx1 = -1, cy0 = h, cy1 = -1;
      stack.push(s); seenPx[s] = 1;
      while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i - x) / w;
        comp.push(i);
        if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (mask[j] && !seenPx[j]) { seenPx[j] = 1; stack.push(j); }
        }
      }
      const bw = cx1 - cx0 + 1, bh = cy1 - cy0 + 1;
      const touches = (cx0 === 0 && x0 > 0) || (cy0 === 0 && y0 > 0) || (cx1 === w - 1 && x1 < W) || (cy1 === h - 1 && y1 < H);
      if ((bw >= 0.92 * w || bh >= 0.92 * h) && (comp.length / (bw * bh) < 0.35 || Math.min(bw, bh) <= 0.3 * Math.max(bw, bh)) || touches) {
        for (const i of comp) mask[i] = 0;
        count -= comp.length;
      }
    }
    for (let i = 0; i < n; i++) if (mask[i] && diff[i] > maxD) maxD = diff[i];
    if (count < 6 || count / n > 0.55) return solid; // no thin strokes found, or a photo-like area: plain fill
    const dilated = morph(mask, w, h, ph > 40 ? 2 : 1, true);
    const {patch, bg} = inpaint(d, dilated, w, h, edge);

    const rowC = new Uint16Array(h), colC = new Uint16Array(w);
    let ix0 = w, ix1 = -1, iy0 = h, iy1 = -1, cr = 0, cg = 0, cb = 0, cn = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      rowC[y]++; colC[x]++;
      if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; if (y < iy0) iy0 = y; if (y > iy1) iy1 = y;
      if (diff[i] >= maxD * 0.7) { cr += d[i * 4]; cg += d[i * 4 + 1]; cb += d[i * 4 + 2]; cn++; }
    }
    const bands = [];
    for (let y = iy0; y <= iy1; y++) {
      if (!rowC[y]) continue;
      let top = y, lo = w, hi = -1;
      for (; y <= iy1 && rowC[y]; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < lo) lo = x; if (x > hi) hi = x; }
      bands.push({top, bottom: y, lo, hi});
    }
    const ibw = ix1 - ix0 + 1, ibh = iy1 - iy0 + 1;
    let align = hint;
    if (bands.length > 1) {
      const spread = f => Math.max(...bands.map(f)) - Math.min(...bands.map(f)), tol = 0.04 * ibw + 2;
      if (spread(q => q.lo) <= tol) align = 'l'; else if (spread(q => q.hi) <= tol) align = 'r'; else if (spread(q => (q.lo + q.hi) / 2) <= tol) align = 'c';
    }
    const density = count / (ibw * ibh), inkColor = cn >= 4 ? [cr / cn, cg / cn, cb / cn] : null;
    return {
      x0, y0, x1, y1, patch, align, solid: null,
      ib: {x0: x0 + ix0, y0: y0 + iy0, x1: x0 + ix1 + 1, y1: y0 + iy1 + 1},
      cap: ibh / bands.length * 0.95,
      weight: density > 0.3 ? 700 : density < 0.16 ? 500 : 600,
      fg: inkColor && contrastOf(inkColor, bg) >= 3 ? rgb(inkColor) : darkOrLight(bg)
    };
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
  function layoutText(ctx, text, bw, bh, weight = 600, cap = Infinity) {
    let lo = 6, hi = Math.max(6, Math.min(bh * 0.9, cap)), best = null;
    for (let i = 0; i < 10; i++) {
      const size = (lo + hi) / 2;
      ctx.font = `${weight} ${size}px ${FONT}`;
      const lines = wrapLines(ctx, text, bw);
      if (lines && lines.length * size * 1.18 <= bh) { best = {size, lines}; lo = size; } else hi = size;
    }
    if (best) return best;
    ctx.font = `${weight} 6px ${FONT}`;
    return {size: 6, lines: wrapLines(ctx, text, Infinity) || [text]};
  }
  function paintRegions(ctx, canvas, regions) {
    const W = canvas.width, H = canvas.height, subtle = conf.imageStyle === 'subtle';
    const plans = regions.map(r => ({region: r, plan: prepareRegion(ctx, W, H, r, subtle)})).filter(p => p.plan); // all sampling happens before anything is painted
    for (const {plan} of plans) { // erase first so overlapping boxes never cover each other's text
      if (plan.patch) { // only stroke pixels carry alpha, so earlier erasures are never reverted
        const tmp = document.createElement('canvas');
        tmp.width = plan.x1 - plan.x0; tmp.height = plan.y1 - plan.y0;
        tmp.getContext('2d').putImageData(plan.patch, 0, 0);
        ctx.drawImage(tmp, plan.x0, plan.y0);
        continue;
      }
      ctx.beginPath();
      ctx.roundRect(plan.x0, plan.y0, plan.x1 - plan.x0, plan.y1 - plan.y0, Math.min(6, (plan.y1 - plan.y0) * 0.15));
      ctx.fillStyle = plan.solid;
      ctx.fill();
    }
    for (const {region, plan} of plans) {
      const area = {x0: plan.x0, y0: plan.y0, x1: plan.x1, y1: plan.y1};
      const fit = box => {
        const w = box.x1 - box.x0, h = box.y1 - box.y0, inner = Math.max(1, w * 0.02);
        return {box, inner, ...layoutText(ctx, region.v, w - inner * 2, h, plan.weight, plan.cap)};
      };
      let layout = fit(area);
      if (plan.ib) { // match the original text size first; fall back to the whole area when the translation is much longer
        const ex = Math.max(2, (plan.ib.x1 - plan.ib.x0) * 0.04), ey = Math.max(2, (plan.ib.y1 - plan.ib.y0) * 0.08);
        const tight = fit({x0: Math.max(area.x0, plan.ib.x0 - ex), y0: Math.max(area.y0, plan.ib.y0 - ey), x1: Math.min(area.x1, plan.ib.x1 + ex), y1: Math.min(area.y1, plan.ib.y1 + ey)});
        layout = tight.size >= plan.cap * 0.72 || tight.size >= layout.size ? tight : layout;
      }
      const {box, inner, size, lines} = layout, w = box.x1 - box.x0, h = box.y1 - box.y0;
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.x0, area.y0, area.x1 - area.x0, area.y1 - area.y0);
      ctx.clip();
      ctx.font = `${plan.weight} ${size}px ${FONT}`;
      ctx.fillStyle = plan.fg;
      ctx.textBaseline = 'middle';
      ctx.textAlign = plan.align === 'l' ? 'left' : plan.align === 'r' ? 'right' : 'center';
      const tx = plan.align === 'l' ? box.x0 + inner : plan.align === 'r' ? box.x1 - inner : box.x0 + w / 2;
      const lh = size * 1.18, y = box.y0 + h / 2 - ((lines.length - 1) * lh) / 2;
      lines.forEach((text, n) => ctx.fillText(text, tx, y + n * lh, w));
      ctx.restore();
    }
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
      const {tiles, source, w, h} = await imageData(img);
      const page = {title: document.title.slice(0, 120)}, results = new Array(tiles.length).fill(null);
      let next = 0, failure = null;
      await Promise.all(Array.from({length: Math.min(3, tiles.length)}, async () => {
        while (next < tiles.length) {
          const i = next++;
          const res = await M.send({type: 'VIWEB_IMAGE', data: tiles[i].data, page});
          if (res?.ok) results[i] = res.regions || [];
          else failure = failure || new Error(res?.error || 'Dịch ảnh thất bại.');
        }
      }));
      if (results.every(r => r === null)) throw failure;
      if (states.get(img) !== st || imgSrc(img) !== src) return;
      st.regions = mergeTiles(tiles, results, w, h);
      if (failure && !auto) toast('Một số phần của ảnh chưa dịch được.');
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
